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

  /* 各项信号的风险权重。

     为什么「提交内存」比「物理内存占用率」权重更高（v2 的改动）：
       AE 崩溃最常见的表现是 "Unable to allocate XXX MB of memory" ——
       那是**分配失败**，而分配失败撞的是「提交上限（commit limit）」，
       不是物理内存余量。Adobe 社区里 96 GB / 128 GB 的机器在内存只用 40% 时
       照样每 20 分钟报这个错；反过来物理内存吃紧但 commit 宽松时反而没事。
       所以 commit 是内存侧的主信号，物理占用率降为辅助（仍保留，因为代价不对称：
       误存只是卡一下，漏存丢的是工作）。

     为什么加「崩溃历史」：
       WER 的 AppCrash 记录能拿到确切时间。崩溃往往成簇出现（刚崩过的机器更容易再崩），
       所以在 24 小时内崩过时进入「不稳定期」：保存更勤、阈值更低。 */
  var W = {
    commitCritical: 45,  // 提交内存 >= 92%
    commitHigh: 28,      // 提交内存 >= 80%
    commitRaise: 12,     // 提交内存 >= 70%
    memCritical: 20,     // 物理内存 >= 92%（辅助信号，降权）
    memHigh: 12,         // 物理内存 >= 85%
    memRaise: 6,         // 物理内存 >= 75%
    marginNegative: 40,  // 磁盘余量为负（已低于 AE 要求的最低线）
    marginThin: 18,      // 磁盘余量 < 5 GB
    cacheFull: 10,       // 缓存配额填满 >= 95%
    hostMiss: 30,        // 主机连续 2 次心跳无响应
    crashHot: 22,        // 近 6 小时内崩过
    crashDay: 12,        // 近 24 小时内崩过
    stale: 10            // 有改动且积压超过设定时长
  };

  var MEM_CRITICAL = 92, MEM_HIGH = 85, MEM_RAISE = 75;
  var COMMIT_CRITICAL = 92, COMMIT_HIGH = 80, COMMIT_RAISE = 70;
  var MARGIN_THIN_GB = 5, CACHE_FULL_PCT = 95;
  var HOST_MISS_MIN = 2;   // 连续丢失次数达到此值才计入风险，避免渲染时误判

  /* ---------- 档位 ----------
     为什么要有档位，而不是全靠自动：
       「多久该存一次」本质上是个人的风险偏好，不是一个能算出来的最优解。
       有人宁可被打断也不想丢十分钟，有人半天的活丢了也认。所以给几档让他选。

     为什么「稳定」档的崩溃窗口反而更长（72h）：
       很少崩的机器，崩一次是异常事件，值得警惕三天；
       每天崩两次的机器，三小时前崩过只是日常，按日常对待就好。

     hotH / dayH 只影响「崩溃史」这项信号计多少分，
     具体存多勤由 holdMin / riskSave 决定（选档位时会一并写入设置）。 */
  var MODES = {
    stable:     { label: '稳定（很少崩）',       hotH: 24, dayH: 72, unstable: true,  holdMin: 15, riskSave: 60 },
    occasional: { label: '偶发（每周左右）',     hotH: 6,  dayH: 24, unstable: true,  holdMin: 10, riskSave: 60 },
    frequent:   { label: '高频（几乎每天崩）',   hotH: 3,  dayH: 12, unstable: true,  holdMin: 5,  riskSave: 45 },
    quiet:      { label: '安静（尽量别打扰）',   hotH: 3,  dayH: 12, unstable: false, holdMin: 20, riskSave: 70 }
  };
  var MODE_ORDER = ['stable', 'occasional', 'frequent', 'quiet'];

  /* 按本机崩溃史推荐档位。读不到历史时给「偶发」——中间档，不激进也不放任。 */
  function recommend(profile) {
    var c = (profile && isFinite(profile.count30)) ? Number(profile.count30) : null;
    if (c === null) {
      return { mode: 'occasional', count30: null, reason: '读不到本机崩溃史，用中间档' };
    }
    if (c <= 1) {
      return {
        mode: 'stable', count30: c,
        reason: c === 0 ? '近 30 天没有崩溃记录' : '近 30 天只崩过 1 次'
      };
    }
    if (c <= 4) {
      return { mode: 'occasional', count30: c, reason: '近 30 天崩过 ' + c + ' 次' };
    }
    return { mode: 'frequent', count30: c, reason: '近 30 天崩过 ' + c + ' 次，属高频' };
  }

  /* 档位对应的设置值（写入 settings，用户可见可改） */
  function preset(mode) {
    var m = MODES[mode] || MODES.occasional;
    return { mode: MODES[mode] ? mode : 'occasional', holdMin: m.holdMin, riskSave: m.riskSave };
  }

  var DEFAULTS = {
    on: true,          // 总开关
    autoSave: true,    // true=自动写入原工程；false=只提示不写
    holdMin: 10,       // 有改动时最多积压多少分钟就必须存一次
    riskSave: 60,      // 风险达到此值立即保存
    cooldownMin: 2,    // 两次自动保存的最小间隔
    mode: 'occasional' // 档位（stable / occasional / frequent / quiet）
  };

  function num(v, def, lo, hi) {
    var n = Number(v);
    if (v === null || v === '' || typeof v === 'boolean' || !isFinite(n)) return def;
    n = Math.round(n);
    return Math.min(hi, Math.max(lo, n));
  }

  function normCfg(c) {
    c = c || {};
    var mode = MODES[c.mode] ? c.mode : DEFAULTS.mode;
    var base = MODES[mode];
    // 档位隐含它的数值：只给 mode 时用该档的 holdMin/riskSave；
    // 显式给了就尊重显式值（用户微调过的数字不该被档位覆盖）。
    return {
      on:          typeof c.on === 'boolean' ? c.on : DEFAULTS.on,
      autoSave:    typeof c.autoSave === 'boolean' ? c.autoSave : DEFAULTS.autoSave,
      holdMin:     num(c.holdMin, base.holdMin, 1, 120),
      riskSave:    num(c.riskSave, base.riskSave, 40, 100),
      cooldownMin: num(c.cooldownMin, DEFAULTS.cooldownMin, 1, 60),
      mode:        mode
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

    /* 把「几小时前」说成人话。崩溃提示里用它，比 0.37 小时友好得多 */
    function fmtAgo(h) {
      if (!isFinite(h) || h < 0) return '—';
      if (h < 1) return Math.max(1, Math.round(h * 60)) + ' 分钟';
      if (h < 48) return Math.round(h) + ' 小时';
      return Math.round(h / 24) + ' 天';
    }

    function evaluate(st, now) {
      st = st || {};
      observe(st, now);

      var risk = 0, reasons = [];

      /* severity 与分数分开算的原因：
         有些单一信号本身就是高危（提交内存 95%、磁盘余量为负），
         若只看加权总分，会被阈值平均掉，出现「最危险的情形只判到留意」的矛盾。
         所以额外维护一个等级下限：0=无 1=至少留意 2=直接高危。 */
      var hard = 0;

      /* 崩溃史 → 按档位取窗口。
         档位决定「多久内算刚崩过」和「崩过之后要不要进入不稳定期」，
         这是机器脾气与个人偏好的结合点：稳定机崩一次值得警惕三天，
         高频机三小时前崩过只是日常。 */
      var M = MODES[C.mode] || MODES.occasional;
      var crashH = Number(st.crashHoursAgo);
      var hasCrash = (st.crashHoursAgo !== null && st.crashHoursAgo !== undefined &&
                      isFinite(crashH) && crashH >= 0);
      var unstable = hasCrash && M.unstable && crashH <= M.dayH;
      var riskEff = unstable ? Math.max(40, C.riskSave - 15) : C.riskSave;
      var holdEff = unstable ? Math.max(2, Math.round(C.holdMin / 2)) : C.holdMin;

      /* 提交内存：内存侧的主信号（分配失败看的是提交上限，不是物理余量） */
      var commit = Number(st.commitPct);
      if (isFinite(commit) && st.commitPct !== null && st.commitPct !== undefined) {
        if (commit >= COMMIT_CRITICAL) {
          risk += W.commitCritical;
          hard = 2;
          reasons.push('提交内存 ' + Math.round(commit) + '%，再分配可能失败');
        } else if (commit >= COMMIT_HIGH) {
          risk += W.commitHigh;
          if (hard < 1) hard = 1;
          reasons.push('提交内存 ' + Math.round(commit) + '%，接近提交上限');
        } else if (commit >= COMMIT_RAISE) {
          risk += W.commitRaise;
          reasons.push('提交内存 ' + Math.round(commit) + '%');
        }
      }

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

      if (hasCrash) {
        if (crashH <= M.hotH) {
          risk += W.crashHot;
          if (hard < 1) hard = 1;
          reasons.push('近 ' + fmtAgo(M.hotH) + '内崩过（' + fmtAgo(crashH) + '前）');
        } else if (crashH <= M.dayH) {
          risk += W.crashDay;
          reasons.push('近期崩过（' + fmtAgo(crashH) + '前）');
        }
      }

      var staleMin = dirtySince ? (now - dirtySince) / MIN : 0;
      if (dirtySince && staleMin >= holdEff) {
        risk += W.stale;
        reasons.push('改动已积压 ' + Math.round(staleMin) + ' 分钟');
      }

      risk = Math.min(100, Math.round(risk));

      var level = 'ok';
      if (risk >= riskEff) level = 'high';
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
        blocked: '',
        unstable: unstable,
        mode: C.mode,
        hotH: M.hotH,
        dayH: M.dayH,
        riskSave: riskEff,      // 有效阈值（不稳定期会更低）
        holdMin: holdEff,       // 有效积压上限（不稳定期会减半）
        commitPct: isFinite(commit) ? commit : null,
        crashHoursAgo: hasCrash ? crashH : null
      };

      /* ---- 判定是否动手 ---- */
      var overRisk = risk >= riskEff || hard === 2;
      var overHold = !!dirtySince && staleMin >= holdEff;

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
    MEM_CRITICAL: MEM_CRITICAL, MEM_HIGH: MEM_HIGH, MEM_RAISE: MEM_RAISE,
    COMMIT_CRITICAL: COMMIT_CRITICAL, COMMIT_HIGH: COMMIT_HIGH, COMMIT_RAISE: COMMIT_RAISE,
    MARGIN_THIN_GB: MARGIN_THIN_GB, CACHE_FULL_PCT: CACHE_FULL_PCT,
    HOST_MISS_MIN: HOST_MISS_MIN,
    CRASH_HOT_H: 6, CRASH_DAY_H: 24,
    MODES: MODES,
    MODE_ORDER: MODE_ORDER,
    recommend: recommend,
    preset: preset,
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
