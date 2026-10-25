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

  /* 追加一个采样点。返回同一个数组（原地追加），太长时从头部丢弃。
     采样是双字段的：b = 缓存已用字节，m = 当时的「余量 GB」。
     为什么必须存 m：余量 = 磁盘可用 − 所需空间，它的下降不只由缓存造成
     （往缓存盘拷素材、其它软件写盘都会吃）。只靠 b 的斜率算 ETA 会在
     「缓存不动、磁盘被别人吃掉」时给出错误结论，甚至因为 b 平而直接不给 ETA。 */
  function push(hist, t, bytes, opts) {
    hist = hist || [];
    opts = opts || {};
    var gap = opts.minGap || MIN_GAP;
    var max = opts.maxPoints || MAX_POINTS;

    if (!isFinite(t) || !isFinite(bytes) || bytes < 0) return hist;

    var m = null;
    if (opts.marginGB !== null && opts.marginGB !== undefined) {
      var mv = Number(opts.marginGB);
      if (isFinite(mv)) m = Math.round(mv * 10) / 10;   // 0.1 GB 精度够了
    }

    var n = hist.length;
    if (n && (t - hist[n - 1].t) < gap) return hist;          // 太密

    // 去重：缓存没变且余量也没变，才算「没有新信息」。
    // 只看 b 会把「磁盘被其它程序吃掉」这种变化漏掉。
    if (n) {
      var prev = hist[n - 1];
      var prevM = (prev.m === undefined) ? null : prev.m;
      var sameB = prev.b === bytes;
      var sameM = (m === null || prevM === null) ? true : (Math.abs(m - prevM) < 0.1);
      if (sameB && sameM && (t - prev.t) < gap * 5) return hist;
    }

    hist.push({ t: t, b: bytes, m: m });
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

  /* 余量的消耗速率（GB/小时，正数 = 余量在变少）。
     这才是「还有多久撞线」的真实定义：撞线的是余量，不是缓存。
     只统计带 m 的采样点；老版本存下来的历史没有 m，就自然被跳过，
     调用方据此退回旧算法 —— 不假装有数据。 */
  function marginRate(hist, windowMs) {
    var win = windowMs || WINDOW;
    var out = { perHour: 0, spanMs: 0, points: 0, ok: false };

    if (!hist || !hist.length) return out;

    var pts = [];
    for (var i = 0; i < hist.length; i++) {
      var p = hist[i];
      if (p && p.m !== null && p.m !== undefined && isFinite(p.m)) pts.push(p);
    }
    out.points = pts.length;
    if (pts.length < 2) return out;

    var last = pts[pts.length - 1];
    var first = pts[0];
    for (var j = 0; j < pts.length; j++) {
      if (last.t - pts[j].t <= win) { first = pts[j]; break; }
    }

    var span = last.t - first.t;
    out.spanMs = span;
    if (span <= 0) return out;

    out.perHour = -(last.m - first.m) / (span / HOUR);   // 余量下降 = 正消耗
    out.ok = span >= MIN_SPAN;
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

  function fmtSignedGB(v) {
    if (!isFinite(v)) return '—';
    var a = Math.abs(v);
    return (v < 0 ? '−' : '+') + (a >= 10 ? a.toFixed(0) : a.toFixed(1)) + ' GB';
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
     返回 { text, level }，level 用于着色。

     两条路径：
       · 有余量采样（m）→ 用「余量斜率」算 ETA，用「缓存斜率」解释原因。这是正解。
       · 只有老采样（没有 m）→ 完全沿用旧算法，行为与以前逐字一致。 */
  function describe(hist, remainGB, windowMs) {
    var rc = rate(hist, windowMs);
    var rm = marginRate(hist, windowMs);

    if (!rm.ok) return describeByCache(rc, remainGB);
    return describeByMargin(rc, rm, remainGB);
  }

  /* 没有余量样本时的旧算法：只看缓存增速 */
  function describeByCache(rc, remainGB) {
    var r = rc;

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

  /* 有余量样本：ETA 由余量斜率决定，缓存斜率只负责解释「是不是缓存干的」。
     三种归因要分开写，否则用户看到「缓存未增长」而判定是红的时候完全无从下手。 */
  function describeByMargin(rc, rm, remainGB) {
    var consume = rm.perHour;            // 正 = 余量在下降

    if (isFinite(remainGB) && remainGB <= 0) {
      return {
        text: '余量已为负 ' + fmtSignedGB(remainGB) + '，AE 会提示磁盘不足',
        level: 'bad', rate: rc, marginRate: rm, etaHours: 0
      };
    }

    // 余量没有在减少：不给 ETA，也别硬编一个
    if (!(consume >= FLAT)) {
      var t;
      if (rc.dir === 'up') t = '缓存 ' + fmtRate(rc.perHour) + '，余量暂未下降';
      else if (rc.dir === 'down') t = '缓存回落 ' + fmtRate(rc.perHour) + '，余量未降';
      else t = '缓存与余量均稳定';
      return { text: t, level: 'flat', rate: rc, marginRate: rm };
    }

    var h = eta(remainGB, consume);
    var tail = (h === null) ? '' : ' · 约 ' + fmtEta(h) + '耗尽余量';
    var lvl = (h !== null && h !== Infinity && h < 24) ? 'warn' : 'up';

    // ① 缓存能解释大部分消耗：就是缓存在吃
    if (rc.dir === 'up' && rc.perHour >= consume * 0.5) {
      return {
        text: '↑ ' + fmtRate(rc.perHour) + tail,
        level: lvl, rate: rc, marginRate: rm, etaHours: h
      };
    }

    // ② 缓存在涨，但只解释了小部分：差额是别的程序
    if (rc.dir === 'up') {
      return {
        text: '缓存 ' + fmtRate(rc.perHour) + '，磁盘 ' + fmtRate(-consume) +
              '（差额来自其它程序）' + tail,
        level: lvl, rate: rc, marginRate: rm, etaHours: h
      };
    }

    // ③ 缓存没涨（甚至回落），但磁盘在掉：跟缓存无关
    return {
      text: '磁盘 ' + fmtRate(-consume) + '（缓存未增长，可能其它程序在占用）' + tail,
      level: lvl, rate: rc, marginRate: rm, etaHours: h
    };
  }

  return {
    MIN_SPAN: MIN_SPAN,
    MIN_GAP: MIN_GAP,
    MAX_POINTS: MAX_POINTS,
    WINDOW: WINDOW,
    push: push,
    rate: rate,
    marginRate: marginRate,
    eta: eta,
    fmtRate: fmtRate,
    fmtSignedGB: fmtSignedGB,
    fmtEta: fmtEta,
    describe: describe
  };
});
