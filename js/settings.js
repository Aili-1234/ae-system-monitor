/* ============================================================
 * settings.js — 面板设置：默认值 / 校验 / 归一化（纯逻辑）
 *
 * 同一个 UMD 双通道写法，原因见 ae-cache.js 顶部注释：
 * CEP 开了 --enable-nodejs 后会往页面注入 module，
 * 二选一 UMD 会导致 window 上拿不到。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonSettings = api;
    if (typeof window !== 'undefined' && window && window !== root) window.SysmonSettings = api;
  } catch (e) {}
  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var DEFAULTS = {
    autoCollapse: true,      // 面板变窄时自动折叠
    // 小窗显示（1.6.5 起可自由选）：主要那个画环，下面还有两格可配。
    // 清单见下面的 MINI_MAIN / MINI_SUB —— 换指标不用改别处，这里只是默认值。
    miniMetric: 'cache_pct',   // 主显示：磁盘缓存已用 %
    miniSub1:   'mem_free_gb', // 次显示 1：内存可用
    miniSub2:   'enough',      // 次显示 2：盘够不够装（够 / 偏紧 / 不够）
    quotaGB: 0,              // 手动设定的缓存上限；0 = 自动检测（优先读 AE 偏好）
    // 首屏视图：compact 全部收起(极简) / full 全部展开(完整) / remember 沿用上次的展开状态
    // 1.6.0 新增。此前是硬编码"全部收起"，用户想看细节就得逐个点开。
    uiDefault: 'compact',
    // 四个主项的展开状态（true = 展示细节）
    // uiDefault=remember 时读这里；compact/full 时由它决定首屏
    ui: {
      cache: false,
      mem:   false,
      disk:  false,
      guard: false,
      // 面板主题（1.7.1）：五套深色主题，只换强调色系。放 ui 里是为了跟着
      // main.js 里那句「ui: USR.ui」原样带走，不必在 7 处白名单里各补一行。
      theme: 'mint'
    },
    crashGuard: {
      on: true,              // 崩溃前自动保存总开关
      autoSave: true,        // true=写入原工程；false=只提示不动手
      holdMin: 10,           // 有改动最多积压多少分钟
      riskSave: 60,          // 风险分数达到此值立即保存
      cooldownMin: 2,        // 两次自动保存的最小间隔
      log: true,             // 把每次保存（含失败原因）写进日志文件
      backup: true,          // 覆盖原工程前先留一份可回退的副本
      keepBackups: 5,        // 每个工程最多留几份回退副本
      backupDir: '',         // 回退副本落点；'' = 默认（工程目录旁的「AE-System-Monitor 备份」）
      // 档位：装好后按本机崩溃史自动选一次，之后由用户决定
      // stable 稳定 / occasional 偶发 / frequent 高频 / quiet 安静
      mode: 'occasional',
      detectedAt: 0          // 上次「按本机历史检测」的时间戳；0 = 还没检测过
    },
    reminders: {
      water:   { on: true,  everyMin: 45 },
      stand:   { on: true,  everyMin: 60 },
      eyes:    { on: true,  everyMin: 40 },
      mem:     { on: false, everyMin: 30 },
      memHigh: { on: true,  thresholdPct: 90, sustain: 3, cooldownMin: 15 }
    }
  };

  /* ---------------- 小窗可选指标（1.6.5 起可自由选，1.6.6 改浅显） ----------------
   * 唯一出处：main.js 用这份清单生成下拉选项与标签，settings 用它做取值校验。
   * 用户抱怨过两件事，都落在这一小块里：
   *   ①「左边那个与上面重复了」—— 主显示与次显示指同一个指标时次显示留空（见 fixMini），
   *      而不是把同一个数换个单位再显示一遍。
   *   ②「159 ÷ 182 = 87.4%，但是我实际并没有用 159gb，这给了用户一个误导向数据。
   *      次要项目显示你再优化一下。要求浅显易懂」
   *      —— 159GB 是「缓存上限 + 安全缓冲」（允许用的总量），不是已经用掉的量，挂在
   *      「AE 所需」这个名字下会被读成「AE 现在要 159GB」。所以：
   *      · need_gb 改成显示真正的上限（quotaGB），标签叫「缓存上限」；
   *      · 比率 need_pct 从次显示里拿掉，换成词语指标 enough「盘够装吗」（够 / 偏紧 / 不够），
   *        判定直接复用面板既有的三条线（ST.cache.verdict），不另立阈值。
   * 名字一律用「谁的、什么量」的直白说法，别让人把「上限」读成「已用」。 */
  /* ---------------- 面板主题（1.7.1） ----------------
   * 用户原话：「多加几个主题，比如黑白蓝粉灰」→「预设 5 色：薄荷绿（=现在这版）/ 天青蓝
   * 藕紫 灰色和淡粉色」。定稿五套都是**深色底**（"薄荷绿 = 现在这版"这句定了调），
   * 只换强调色系 + 一点点底色色温；语义色 warn（琥珀）/ bad（红）保留，只做轻微色温偏移。
   * 「薄荷绿」就是默认那套（css 的 :root），所以它没有 body[data-theme="mint"] 块。
   * 色点颜色 THEME_DOTS 只在界面画圆点用，和 CSS 里的强调色一一对应。
   * 1.7.2（用户：「主题可以再加两个浅色底」「颜色再加一个黑色适配 ae 原生主题」）：
   * 加到 8 套 —— 新增象牙白 ivory、雾蓝浅 mist（两套**浅色底**）与黑色 black（纯黑 + AE 原生
   * 那种灰蓝高亮，最靠近 AE 自己的深色界面）；深色那五套一行不动。
   * 浅色底不是把底色翻白就完事：灰阶必须整体下压（#999999 放在白底上只有 1.6:1），
   * 所以浅色主题另给一套 fg/fg-2/fg-3 与语义色，由 [8h] 的对比度实算断言卡住。
   * 这两套浅色的色点直接用**它自己的底色**，与深色六套（色点 = 强调色/中性灰）刻意不同 ——
   * 一眼就能认出「这套是浅色」。 */
  var THEMES = ['mint', 'azure', 'lotus', 'gray', 'pink', 'ivory', 'mist', 'black'];
  var THEME_LABELS = {
    mint: '薄荷绿', azure: '天青蓝', lotus: '藕紫', gray: '灰色', pink: '淡粉',
    ivory: '象牙白', mist: '雾蓝浅', black: '黑色'
  };
  var THEME_DOTS = {
    mint: '#7fbf9a', azure: '#63b3d4', lotus: '#a99ad0', gray: '#a8a8a8', pink: '#dda3b8',
    ivory: '#f6f3ee', mist: '#eef2f6', black: '#6b6b6b'
  };

  var MINI_MAIN = ['cache_pct', 'mem_free_pct', 'need_pct', 'disk_free_pct'];
  var MINI_SUB = ['none', 'cache_gb', 'mem_free_gb', 'need_gb', 'enough', 'left_gb',
                  'disk_free_gb', 'rate', 'eta'];
  // 小窗里显示的短名（窄面板放不下长名字）与单位（下拉里跟在名字后面）
  var MINI_LABELS = {
    cache_pct: '缓存已用', cache_gb: '缓存已用',
    mem_free_pct: '内存可用', mem_free_gb: '内存可用',
    need_pct: '上限占盘比', need_gb: '缓存上限',
    left_gb: '配额还剩', disk_free_pct: '磁盘可用', disk_free_gb: '磁盘可用',
    enough: '盘够装吗', rate: '缓存增速', eta: '多久写满', none: '不显示'
  };
  var MINI_UNITS = {
    cache_pct: '%', mem_free_pct: '%', need_pct: '%', disk_free_pct: '%',
    cache_gb: 'GB', mem_free_gb: 'GB', need_gb: 'GB', left_gb: 'GB', disk_free_gb: 'GB',
    enough: '', rate: '每小时', eta: '时长', none: ''
  };

  // 每个字段的约束。新增字段只要在这里加一行，校验就自动生效。
  var SCHEMA = {
    autoCollapse: { type: 'bool' },
    // alias：1.6.4 及以前的 cache / mem 两个老值，迁移到新的四个指标
    miniMetric:   { type: 'enum', values: MINI_MAIN, alias: { cache: 'cache_pct', mem: 'mem_free_pct' } },
    miniSub1:     { type: 'enum', values: MINI_SUB },
    miniSub2:     { type: 'enum', values: MINI_SUB },
    quotaGB:      { type: 'num', lo: 0, hi: 4000 },
    uiDefault:    { type: 'enum', values: ['compact', 'full', 'remember'] },
    ui: {
      cache: { type: 'bool' },
      mem:   { type: 'bool' },
      disk:  { type: 'bool' },
      guard: { type: 'bool' },
      theme: { type: 'enum', values: THEMES, def: 'mint' }
    },
    crashGuard: {
      on:          { type: 'bool' },
      autoSave:    { type: 'bool' },
      holdMin:     { type: 'num', lo: 1,   hi: 120 },
      riskSave:    { type: 'num', lo: 40,  hi: 100 },
      cooldownMin: { type: 'num', lo: 1,   hi: 60 },
      log:         { type: 'bool' },
      backup:      { type: 'bool' },
      keepBackups: { type: 'num', lo: 1, hi: 20 },
      backupDir:   { type: 'str', max: 240 },
      mode:        { type: 'enum', values: ['stable', 'occasional', 'frequent', 'quiet'] },
      detectedAt:  { type: 'num', lo: 0, hi: 4102444800000 }   // 2100-01-01
    },
    reminders: {
      water:   { on: { type: 'bool' }, everyMin: { type: 'num', lo: 5, hi: 240 } },
      stand:   { on: { type: 'bool' }, everyMin: { type: 'num', lo: 5, hi: 240 } },
      eyes:    { on: { type: 'bool' }, everyMin: { type: 'num', lo: 5, hi: 240 } },
      mem:     { on: { type: 'bool' }, everyMin: { type: 'num', lo: 5, hi: 240 } },
      memHigh: {
        on:           { type: 'bool' },
        thresholdPct: { type: 'num', lo: 50, hi: 99 },
        sustain:      { type: 'num', lo: 1,  hi: 30 },
        cooldownMin:  { type: 'num', lo: 1,  hi: 180 }
      }
    }
  };

  var LIMITS = {
    everyMin:    [5, 240],
    thresholdPct: [50, 99],
    sustain:     [1, 30],
    cooldownMin: [1, 180]
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function normBool(v, def) { return typeof v === 'boolean' ? v : def; }

  function normNum(v, def, lo, hi) {
    var n = Number(v);
    if (typeof v === 'boolean' || v === null || v === '' || !isFinite(n)) return def;
    n = Math.round(n);
    return Math.min(hi, Math.max(lo, n));
  }

  function normEnum(v, def, values) {
    return values.indexOf(v) >= 0 ? v : def;
  }

  /* 路径字符串：只做「不改变语义」的清理。
     用户点右键「复制为路径」拿到的是一对引号包着的字符串，也可能粘出尾随空格或结尾反斜杠；
     这些都吃掉，否则拼出来的目录名带着引号，在资源管理器里看着像另一个文件夹。
     真正的合法性（盘在不在、有没有权限）交给 fs 判，见 main.js canUseDir()。 */
  function normStr(v, def, max) {
    if (typeof v !== 'string') return def;
    var s = v.replace(/[\x00-\x1f]/g, '').trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/[\\/]+$/, '');
    if (/^[a-zA-Z]:$/.test(s)) s = s + '\\';      // 盘根：'D:' 这种半截路径补回分隔符
    if (max && s.length > max) s = s.slice(0, max);
    return s;
  }

  // 按 schema 递归归一化：任何脏数据都退回到默认值，不抛异常
  function walk(schema, def, src) {
    var out = {};
    for (var k in schema) {
      if (!Object.prototype.hasOwnProperty.call(schema, k)) continue;
      var rule = schema[k];
      var dv = def ? def[k] : undefined;
      var sv = (src && typeof src === 'object') ? src[k] : undefined;

      if (rule.type === 'bool') {
        out[k] = normBool(sv, !!dv);
      } else if (rule.type === 'num') {
        out[k] = normNum(sv, dv, rule.lo, rule.hi);
      } else if (rule.type === 'enum') {
        // alias：老值先翻译再校验，否则用户升级后小窗会静默跳回默认指标
        var ev = (rule.alias && rule.alias[sv]) ? rule.alias[sv] : sv;
        out[k] = normEnum(ev, dv, rule.values);
      } else if (rule.type === 'str') {
        out[k] = normStr(sv, dv || '', rule.max);
      } else {
        out[k] = walk(rule, dv, sv);   // 嵌套节点
      }
    }
    return out;
  }

  function defaults() { return clone(DEFAULTS); }

  /* 小窗次显示与主显示重复时留空（1.6.5）。
     「缓存 5%」上面已经画成环了，下面再来一格「缓存 7.3GB」就是重复 —— 用户原话
     「左边那个与上面重复了」。百分号版与绝对值版算同一家（cache_pct / cache_gb → cache）。 */
  function miniFamily(id) {
    var s = String(id === undefined || id === null ? '' : id);
    if (s === 'none') return 'none';
    if (s === 'rate' || s === 'eta' || s === 'left_gb') return s;
    return s.replace(/_(pct|gb)$/, '');
  }

  /* 只做一件事：把重复的次显示改成 none，其余原样返回（可反复调用，幂等）。
     纯函数、不碰 DOM、不抛异常 —— 界面自己调它做提示，单测直接喂数据。 */
  function fixMini(cfg) {
    var c = cfg || {};
    var f0 = miniFamily(c.miniMetric);
    var f1 = miniFamily(c.miniSub1);
    if (f1 !== 'none' && f1 === f0) { c.miniSub1 = 'none'; f1 = 'none'; }
    var f2 = miniFamily(c.miniSub2);
    if (f2 === 'none' || f2 === f0 || (f1 !== 'none' && f2 === f1)) c.miniSub2 = 'none';
    return c;
  }

  function normalize(saved) { return fixMini(walk(SCHEMA, DEFAULTS, saved)); }

  // 从字符串（localStorage）解析；坏 JSON 直接回默认值
  function parse(str) {
    if (!str) return defaults();
    try { return normalize(JSON.parse(str)); }
    catch (e) { return defaults(); }
  }

  function stringify(cfg) { return JSON.stringify(normalize(cfg)); }

  return {
    DEFAULTS: DEFAULTS,
    SCHEMA: SCHEMA,
    LIMITS: LIMITS,
    THEMES: THEMES,
    THEME_LABELS: THEME_LABELS,
    THEME_DOTS: THEME_DOTS,
    MINI_MAIN: MINI_MAIN,
    MINI_SUB: MINI_SUB,
    MINI_LABELS: MINI_LABELS,
    MINI_UNITS: MINI_UNITS,
    miniFamily: miniFamily,
    fixMini: fixMini,
    defaults: defaults,
    normalize: normalize,
    parse: parse,
    stringify: stringify
  };
});
