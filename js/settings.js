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
    miniMetric: 'cache',     // 小窗显示：cache(缓存填充率) | mem(内存占用)
    quotaGB: 0,              // 手动设定的缓存上限；0 = 自动检测（优先读 AE 偏好）
    crashGuard: {
      on: true,              // 崩溃前自动保存总开关
      autoSave: true,        // true=写入原工程；false=只提示不动手
      holdMin: 10,           // 有改动最多积压多少分钟
      riskSave: 60,          // 风险分数达到此值立即保存
      cooldownMin: 2,        // 两次自动保存的最小间隔
      log: true              // 把每次保存（含失败原因）写进日志文件
    },
    reminders: {
      water:   { on: true,  everyMin: 45 },
      stand:   { on: true,  everyMin: 60 },
      eyes:    { on: true,  everyMin: 40 },
      mem:     { on: false, everyMin: 30 },
      memHigh: { on: true,  thresholdPct: 90, sustain: 3, cooldownMin: 15 }
    }
  };

  // 每个字段的约束。新增字段只要在这里加一行，校验就自动生效。
  var SCHEMA = {
    autoCollapse: { type: 'bool' },
    miniMetric:   { type: 'enum', values: ['cache', 'mem'] },
    quotaGB:      { type: 'num', lo: 0, hi: 4000 },
    crashGuard: {
      on:          { type: 'bool' },
      autoSave:    { type: 'bool' },
      holdMin:     { type: 'num', lo: 1,   hi: 120 },
      riskSave:    { type: 'num', lo: 40,  hi: 100 },
      cooldownMin: { type: 'num', lo: 1,   hi: 60 },
      log:         { type: 'bool' }
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
        out[k] = normEnum(sv, dv, rule.values);
      } else {
        out[k] = walk(rule, dv, sv);   // 嵌套节点
      }
    }
    return out;
  }

  function defaults() { return clone(DEFAULTS); }

  function normalize(saved) { return walk(SCHEMA, DEFAULTS, saved); }

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
    defaults: defaults,
    normalize: normalize,
    parse: parse,
    stringify: stringify
  };
});
