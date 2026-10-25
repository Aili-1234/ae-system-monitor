/* ============================================================
 * reminder.js — 提醒调度引擎（纯逻辑，可注入时钟）
 *
 * 设计要点：
 *   · 不碰 DOM、不碰定时器、不读系统 —— 只做「该不该响」的判断
 *   · 时钟由外部注入，测试里可以瞬间跨越几小时
 *   · 每条提醒独立计时；关闭再开启会从「此刻」重新起算，
 *     不会因为关了三天、一开就立刻连响
 *
 * 两条不同的触发模型：
 *   1) 定时型（water / stand / eyes / mem）：距上次触发满 N 分钟
 *   2) 阈值型（memHigh）：连续 M 次采样超过阈值，且有冷却时间
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonReminder = api;
    if (typeof window !== 'undefined' && window && window !== root) window.SysmonReminder = api;
  } catch (e) {}
  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MIN = 60000;
  var TIMER_IDS = ['water', 'stand', 'eyes', 'mem'];
  var ALL_IDS = TIMER_IDS.concat(['memHigh']);

  var META = {
    water: { icon: '💧', title: '喝口水吧' },
    stand: { icon: '🧍', title: '起来活动一下' },
    eyes:  { icon: '👀', title: '看看远处' },
    mem:   { icon: '🧠', title: '内存占用' },
    memHigh: { icon: '⚠', title: '内存偏高', level: 'warn' }
  };

  function fmtBytes(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Math.abs(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    var d = (digits === null || digits === undefined) ? (i >= 3 ? 1 : 0) : digits;
    return v.toFixed(d) + ' ' + u[i];
  }

  function buildMessage(id, rc, ctx) {
    ctx = ctx || {};
    switch (id) {
      case 'water':
        return '已经 ' + rc.everyMin + ' 分钟了，喝两口水再继续。';
      case 'stand':
        return '坐了 ' + rc.everyMin + ' 分钟，站起来走两步、转下脖子。';
      case 'eyes':
        return '望向 6 米外 20 秒，让眼睛歇一下（20-20-20）。';
      case 'mem':
        if (isFinite(ctx.memPct)) {
          return '当前占用 ' + ctx.memPct.toFixed(0) + '%' +
                 (ctx.memUsed ? '（' + fmtBytes(ctx.memUsed) + ' / ' + fmtBytes(ctx.memTotal) + '）' : '');
        }
        return '定时内存播报。';
      case 'memHigh':
        return '内存已占用 ' + (isFinite(ctx.memPct) ? ctx.memPct.toFixed(0) + '%' : '--') +
               '，AE 预览可能开始卡顿。可考虑清理磁盘缓存或降低预览分辨率。';
      default:
        return '';
    }
  }

  function make(id, rc, ctx) {
    var m = META[id] || { icon: '•', title: id };
    return {
      id: id,
      icon: m.icon,
      title: m.title,
      level: m.level || 'info',
      msg: buildMessage(id, rc, ctx)
    };
  }

  function create(opts) {
    opts = opts || {};
    var now = opts.now || function () { return Date.now(); };

    var startedAt = now();
    var lastFired = {};     // id -> 时间戳
    var offSeen = {};       // id -> 是否曾在「关闭」状态待过
    var snoozeUntil = {};   // id -> 到点时间
    var memStreak = 0;      // 内存超阈值的连续采样次数
    var memLastFired = 0;

    function clearSnooze(id) { delete snoozeUntil[id]; }

    function tick(cfg, ctx) {
      if (!cfg || !cfg.reminders) return [];
      var t = now();
      var out = [];
      var r = cfg.reminders;

      /* ---- 定时型 ---- */
      for (var i = 0; i < TIMER_IDS.length; i++) {
        var id = TIMER_IDS[i];
        var rc = r[id];
        if (!rc) continue;

        if (!rc.on) {
          // 关闭期间清掉计时基准，重新开启时从此刻起算
          offSeen[id] = true;
          delete lastFired[id];
          clearSnooze(id);
          continue;
        }
        if (offSeen[id]) { offSeen[id] = false; lastFired[id] = t; continue; }

        // 稍后提醒：到点立即响一次，并重置周期
        if (snoozeUntil[id]) {
          if (t >= snoozeUntil[id]) {
            clearSnooze(id);
            lastFired[id] = t;
            out.push(make(id, rc, ctx));
          }
          continue;
        }

        var base = (lastFired[id] === undefined) ? startedAt : lastFired[id];
        if (t - base >= rc.everyMin * MIN) {
          lastFired[id] = t;
          out.push(make(id, rc, ctx));
        }
      }

      /* ---- 阈值型：内存偏高 ---- */
      var mh = r.memHigh;
      if (mh && mh.on) {
        var pct = (ctx && isFinite(ctx.memPct)) ? ctx.memPct : null;

        if (pct === null) {
          memStreak = 0;
        } else if (pct >= mh.thresholdPct) {
          memStreak++;
        } else {
          memStreak = 0;
        }

        if (snoozeUntil.memHigh) {
          if (t >= snoozeUntil.memHigh) {
            clearSnooze('memHigh');
            memStreak = 0;
            memLastFired = t;
            out.push(make('memHigh', mh, ctx));
          }
        } else if (memStreak >= mh.sustain && pct !== null) {
          if (!memLastFired || (t - memLastFired) >= mh.cooldownMin * MIN) {
            memLastFired = t;
            memStreak = 0;
            out.push(make('memHigh', mh, ctx));
          }
        }
      } else {
        memStreak = 0;
        clearSnooze('memHigh');
      }

      return out;
    }

    function snooze(id, minutes) {
      var min = Number(minutes);
      if (!isFinite(min) || min <= 0) min = 10;
      snoozeUntil[id] = now() + min * MIN;
      return snoozeUntil[id];
    }

    function reset() {
      startedAt = now();
      lastFired = {};
      offSeen = {};
      snoozeUntil = {};
      memStreak = 0;
      memLastFired = 0;
    }

    function snapshot() {
      return {
        startedAt: startedAt,
        lastFired: JSON.parse(JSON.stringify(lastFired)),
        snoozeUntil: JSON.parse(JSON.stringify(snoozeUntil)),
        memStreak: memStreak,
        memLastFired: memLastFired
      };
    }

    return {
      tick: tick,
      snooze: snooze,
      reset: reset,
      snapshot: snapshot
    };
  }

  return { create: create, TIMER_IDS: TIMER_IDS, ALL_IDS: ALL_IDS, META: META };
});
