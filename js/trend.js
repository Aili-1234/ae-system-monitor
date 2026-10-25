/* ============================================================
 * trend.js — 缓存增速与"还能撑多久"（纯逻辑，可注入时间）
 *
 * 为什么值得单独成模块：
 *   「+1.2 GB/h，约 3 天后撞上限」这句话比「已用 5.9 GB」有用得多，
 *   但它由三次采样、两个除法、一个窗口裁剪算出来 —— 算错了没人看得出来。
 *   抽离后可以用假时钟把每种情形都摆一遍。
 *
 * 两个必须守住的语义：
 *   1) 样本不够就别给结论。少于 10 分钟的数据直接说「采样中」，
 *      否则面板一打开就显示「约 0 分钟后耗尽」这种吓人的假警报。
 *   2) 缓存会回落（AE 自己会清）。回落时不能显示负数增速还硬算 ETA，
 *      要如实说「已回落」。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonTrend = api;
    if (typeof window !== 'undefined' && window && window !== root) window.SysmonTrend = api;
  } catch (e) {}
  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MIN = 60000;
  var HOUR = 3600000;
  var GB = 1073741824;

  var MIN_SPAN = 10 * MIN;     // 少于 10 分钟样本不给结论
  var MIN_GAP = 60 * 1000;     // 两次采样至少隔 1 分钟
  var MAX_POINTS = 480;        // 最多保留 480 点（1 分钟粒度约 8 小时）
  var WINDOW = 2 * HOUR;       // 增速只看最近 2 小时
  var FLAT = 0.01;             // 每小时 0.01 GB 以下视为没增长

  /* 追加一个采样点。返回同一个数组（原地追加），太长时从头部丢弃。 */
  function push(hist, t, bytes, opts) {
    hist = hist || [];
    opts = opts || {};
    var gap = opts.minGap || MIN_GAP;
    var max = opts.maxPoints || MAX_POINTS;

    if (!isFinite(t) || !isFinite(bytes) || bytes < 0) return hist;

    var n = hist.length;
    if (n && (t - hist[n - 1].t) < gap) return hist;          // 太密
    if (n && hist[n - 1].b === bytes && (t - hist[n - 1].t) < gap * 5) return hist;

    hist.push({ t: t, b: bytes });
    while (hist.length > max) hist.shift();
    return hist;
  }

  /* 最近 windowMs 内的平均增速（GB/小时）。
     返回 { perHour, spanMs, points, ok, dir } */
  function rate(hist, windowMs) {
    var win = windowMs || WINDOW;
    var out = { perHour: 0, spanMs: 0, points: hist ? hist.length : 0, ok: false, dir: 'flat' };

    if (!hist || hist.length < 2) return out;

    var last = hist[hist.length - 1];
    var first = last;

    // 取窗口内最早的一点；窗口外的一律不用
    for (var i = 0; i < hist.length; i++) {
      if (last.t - hist[i].t <= win) { first = hist[i]; break; }
    }

    var span = last.t - first.t;
    out.spanMs = span;
    if (span <= 0) return out;

    var d = last.b - first.b;
    // 统一换算成 GB/小时：外部（eta / 文案）都按 GB 记账
    out.perHour = (d / GB) / (span / HOUR);
    out.ok = span >= MIN_SPAN;

    if (Math.abs(out.perHour) < FLAT) out.dir = 'flat';
    else out.dir = out.perHour > 0 ? 'up' : 'down';

    return out;
  }

  /* 距离"余量耗尽"还有多少小时。
     remainGB <= 0 返回 0（已不足）；不增长返回 Infinity（不再增长）。 */
  function eta(remainGB, perHour) {
    if (!isFinite(remainGB) || !isFinite(perHour)) return null;
    if (remainGB <= 0) return 0;
    if (perHour < FLAT) return Infinity;
    return remainGB / perHour;
  }

  function fmtRate(perHour) {
    if (!isFinite(perHour)) return '—';
    var a = Math.abs(perHour);
    if (a < FLAT) return '0 GB/h';
    var s = a >= 10 ? a.toFixed(0) : (a >= 0.1 ? a.toFixed(1) : a.toFixed(2));
    return (perHour > 0 ? '+' : '−') + s + ' GB/h';
  }

  function fmtEta(h) {
    if (h === null || h === undefined) return '—';
    if (h === Infinity) return '不再增长';
    if (h <= 0) return '已不足';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' 分钟后';
    if (h < 48) return Math.round(h) + ' 小时后';
    if (h < 24 * 90) return Math.round(h / 24) + ' 天后';
    return '3 个月以上';
  }

  /* 一句话结论，供界面直接显示。
     返回 { text, level }，level 用于着色。 */
  function describe(hist, remainGB, windowMs) {
    var r = rate(hist, windowMs);

    if (r.points < 2 || !r.ok) {
      var got = r.spanMs ? Math.round(r.spanMs / MIN) : 0;
      return { text: '增速采样中（' + got + ' 分钟）', level: 'flat', rate: r };
    }
    if (r.dir === 'down') {
      return { text: '缓存回落 ' + fmtRate(r.perHour), level: 'flat', rate: r };
    }
    if (r.dir === 'flat') {
      return { text: '缓存未增长', level: 'flat', rate: r };
    }

    var h = eta(remainGB, r.perHour);
    // 余量未知（缓存盘还没定位到）时不要硬凑一句话，只报增速
    var tail = (h === null) ? '' : ' · 约 ' + fmtEta(h) + '耗尽余量';
    return {
      text: '↑ ' + fmtRate(r.perHour) + tail,
      level: (h !== null && h !== Infinity && h < 24) ? 'warn' : 'up',
      rate: r,
      etaHours: h
    };
  }

  return {
    MIN_SPAN: MIN_SPAN,
    MIN_GAP: MIN_GAP,
    MAX_POINTS: MAX_POINTS,
    WINDOW: WINDOW,
    push: push,
    rate: rate,
    eta: eta,
    fmtRate: fmtRate,
    fmtEta: fmtEta,
    describe: describe
  };
});
