/* ============================================================
 * guard.js — 崩溃前保护（纯逻辑，不碰 DOM / 不碰文件系统）
 *
 * 为什么单独成模块：
 *   「什么时候该保存」是这个功能唯一的难点，也是唯一必须测的东西。
 *   抽离后可以在 Node 里用假时钟精确验证每一种判定分支。
 *
 * 重要前提（决定了它能做什么、不能做什么）：
 *   面板进程与 AE 同生共死。AE 崩溃时面板一起消失，
 *   所以不存在「崩溃后抢救」，只能在崩溃概率升高时提前落盘。
 *
 *   也正因如此，判定用的是「可观测信号」而非「崩溃预警」：
 *   内存压力 / 磁盘余量 / 缓存填满 / 主机心跳丢失 / 改动积压时长。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonGuard = api;
    if (typeof window !== 'undefined' && window && window !== root) window.SysmonGuard = api;
  } catch (e) {}
  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MIN = 60000;

  /* 各项信号的风险权重。数值来自「该因素与 AE 崩溃的相关性」的经验排序：
     内存耗尽是 AE 最常见的崩溃原因，磁盘写满次之，心跳丢失说明主线程已被拖死。 */
  var W = {
    memCritical: 45,   // 内存 >= 92%
    memHigh: 28,       // 内存 >= 85%
    memRaise: 12,      // 内存 >= 75%
    marginNegative: 40,// 磁盘余量为负（已低于 AE 要求的最低线）
    marginThin: 18,    // 磁盘余量 < 5 GB
    cacheFull: 10,     // 缓存配额填满 >= 95%
    hostMiss: 30,      // 主机连续 2 次心跳无响应
    stale: 10          // 有改动且积压超过设定时长
  };

  var MEM_CRITICAL = 92, MEM_HIGH = 85, MEM_RAISE = 75;
  var MARGIN_THIN_GB = 5, CACHE_FULL_PCT = 95;
  var HOST_MISS_MIN = 2;   // 连续丢失次数达到此值才计入风险，避免渲染时误判

  var DEFAULTS = {
    on: true,          // 总开关
    autoSave: true,    // true=自动写入原工程；false=只提示不写
    holdMin: 10,       // 有改动时最多积压多少分钟就必须存一次
    riskSave: 60,      // 风险达到此值立即保存
    cooldownMin: 2     // 两次自动保存的最小间隔
  };

  function num(v, def, lo, hi) {
    var n = Number(v);
    if (v === null || v === '' || typeof v === 'boolean' || !isFinite(n)) return def;
    n = Math.round(n);
    return Math.min(hi, Math.max(lo, n));
  }

  function normCfg(c) {
    c = c || {};
    return {
      on:          typeof c.on === 'boolean' ? c.on : DEFAULTS.on,
      autoSave:    typeof c.autoSave === 'boolean' ? c.autoSave : DEFAULTS.autoSave,
      holdMin:     num(c.holdMin, DEFAULTS.holdMin, 1, 120),
      riskSave:    num(c.riskSave, DEFAULTS.riskSave, 40, 100),
      cooldownMin: num(c.cooldownMin, DEFAULTS.cooldownMin, 1, 60)
    };
  }

  function create(cfg) {
    var C = normCfg(cfg);

    var dirtySince = 0;     // 有改动的起始时刻（0 表示当前无改动）
    var lastSaveAt = 0;     // 上次成功保存时刻
    var missStreak = 0;     // 连续心跳丢失次数

    function configure(next) { C = normCfg(next); }

    /* 每次采样先更新内部计时状态。
       projDirty 允许三态：true / false / null(未知) */
    function observe(st, now) {
      st = st || {};
      if (st.projDirty === true) {
        if (!dirtySince) dirtySince = now;
      } else if (st.projDirty === false) {
        dirtySince = 0;
      }
      // null 不动：未知时保留上一次判断，避免来回抖动

      if (st.hostAlive === false) missStreak++;
      else missStreak = 0;
    }

    function watchAt() { return Math.min(25, Math.max(0, C.riskSave - 20)); }

    function evaluate(st, now) {
      st = st || {};
      observe(st, now);

      var risk = 0, reasons = [];

      /* severity 与分数分开算的原因：
         有些单一信号本身就是高危（内存 93%、磁盘余量为负），
         若只看加权总分，会被阈值平均掉，出现「最危险的情形只判到留意」的矛盾。
         所以额外维护一个等级下限：0=无 1=至少留意 2=直接高危。 */
      var hard = 0;

      var mem = Number(st.memPct);
      if (isFinite(mem)) {
        if (mem >= MEM_CRITICAL) {
          risk += W.memCritical;
          hard = 2;
          reasons.push('内存 ' + Math.round(mem) + '%，已在崩溃高发区间');
        } else if (mem >= MEM_HIGH) {
          risk += W.memHigh;
          if (hard < 1) hard = 1;
          reasons.push('内存 ' + Math.round(mem) + '%，接近上限');
        } else if (mem >= MEM_RAISE) {
          risk += W.memRaise;
          reasons.push('内存 ' + Math.round(mem) + '%');
        }
      }

      var margin = Number(st.marginGB);
      if (isFinite(margin) && st.marginGB !== null) {
        if (margin < 0) {
          risk += W.marginNegative;
          hard = 2;
          reasons.push('磁盘余量不足 ' + margin.toFixed(1) + ' GB');
        } else if (margin < MARGIN_THIN_GB) {
          risk += W.marginThin;
          if (hard < 1) hard = 1;
          reasons.push('磁盘余量仅 ' + margin.toFixed(1) + ' GB');
        }
      }

      var fill = Number(st.cacheFillPct);
      if (isFinite(fill) && fill >= CACHE_FULL_PCT) {
        risk += W.cacheFull;
        if (hard < 1) hard = 1;
        reasons.push('缓存配额已填满 ' + Math.round(fill) + '%');
      }

      if (missStreak >= HOST_MISS_MIN) {
        risk += W.hostMiss;
        if (hard < 1) hard = 1;
        reasons.push('AE 连续 ' + missStreak + ' 次无响应');
      }

      var staleMin = dirtySince ? (now - dirtySince) / MIN : 0;
      if (dirtySince && staleMin >= C.holdMin) {
        risk += W.stale;
        reasons.push('改动已积压 ' + Math.round(staleMin) + ' 分钟');
      }

      risk = Math.min(100, Math.round(risk));

      var level = 'ok';
      if (risk >= C.riskSave) level = 'high';
      else if (risk >= watchAt()) level = 'watch';

      if (hard === 2) level = 'high';
      else if (hard === 1 && level === 'ok') level = 'watch';

      var r = {
        risk: risk,
        level: level,
        hard: hard,
        reasons: reasons,
        dirtySince: dirtySince,
        dirtyMin: staleMin,
        lastSaveAt: lastSaveAt,
        missStreak: missStreak,
        shouldSave: false,
        suggest: false,
        why: '',
        blocked: ''
      };

      /* ---- 判定是否动手 ---- */
      var overRisk = risk >= C.riskSave || hard === 2;
      var overHold = !!dirtySince && staleMin >= C.holdMin;

      if (!C.on) {
        r.blocked = 'off';
        return r;
      }
      if (!st.projOpen) {
        r.blocked = 'no-project';
        return r;
      }
      if (!st.projPath) {
        // 未保存过的工程：save() 会弹出「另存为」对话框，绝不能自动触发
        r.blocked = 'untitled';
        return r;
      }
      if (st.projDirty === false) {
        r.blocked = 'clean';
        return r;
      }
      if (st.projDirty === null || st.projDirty === undefined) {
        r.blocked = 'unknown';
        return r;
      }
      if (st.renderActive) {
        r.blocked = 'rendering';
        return r;
      }

      if (overRisk || overHold) {
        r.suggest = true;
        r.why = overRisk ? 'risk' : 'hold';
      }

      if (r.suggest) {
        var since = lastSaveAt ? now - lastSaveAt : Infinity;
        if (since < C.cooldownMin * MIN) {
          r.blocked = 'cooldown';
          r.why = '';
          r.suggest = false;
          r.waitMs = C.cooldownMin * MIN - since;
          return r;
        }
        if (!C.autoSave) {
          r.blocked = 'suggest-only';
          return r;
        }
        r.shouldSave = true;
        r.blocked = '';
        return r;
      }

      if (!r.blocked) r.blocked = 'not-yet';
      return r;
    }

    function markSaved(now) {
      lastSaveAt = now;
      dirtySince = 0;
    }

    function markFailed(now) {
      // 失败也记时间，否则会每轮重试、反复卡住界面
      lastSaveAt = now;
    }

    function reset() {
      dirtySince = 0;
      lastSaveAt = 0;
      missStreak = 0;
    }

    function snapshot() {
      return { dirtySince: dirtySince, lastSaveAt: lastSaveAt, missStreak: missStreak, cfg: C };
    }

    return {
      evaluate: evaluate,
      observe: observe,
      markSaved: markSaved,
      markFailed: markFailed,
      configure: configure,
      reset: reset,
      snapshot: snapshot,
      getCfg: function () { return C; }
    };
  }

  return {
    W: W,
    MIN: MIN,
    DEFAULTS: DEFAULTS,
    create: create,
    normalize: normCfg,
    BLOCK_LABELS: {
      'off':          '保护已关闭',
      'no-project':   '未打开工程',
      'untitled':     '工程尚未保存过，无法静默写入',
      'clean':        '没有未保存的改动',
      'unknown':      '无法确认改动状态',
      'rendering':    '正在渲染，本次跳过',
      'cooldown':     '距上次保存太近',
      'suggest-only': '仅提示，不自动写入',
      'not-yet':      '风险未达阈值'
    }
  };
});
