/* settings.test.js — 设置归一化测试
 * 重点：localStorage 里的东西可能是任何脏数据，绝不能让面板崩。
 */
const S = require('../js/settings.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

console.log('[1] 默认值结构');
const d = S.defaults();
ok('autoCollapse 默认开', d.autoCollapse === true);
ok('miniMetric 默认 cache', d.miniMetric === 'cache');
ok('已移除 sound 字段（不出声）', d.sound === undefined);
ok('water 默认 45 分钟', d.reminders.water.everyMin === 45, d.reminders.water.everyMin);
ok('memHigh 默认阈值 90', d.reminders.memHigh.thresholdPct === 90);
ok('mem 定时播报默认关', d.reminders.mem.on === false);
ok('defaults 返回副本（改不坏源）', (function () {
  const a = S.defaults(); a.reminders.water.everyMin = 999;
  return S.defaults().reminders.water.everyMin === 45;
})());

console.log('\n[2] 脏数据一律退回默认');
ok('null', S.normalize(null).reminders.water.everyMin === 45);
ok('undefined', S.normalize(undefined).reminders.water.on === true);
ok('字符串整体', S.normalize('乱七八糟').reminders.stand.everyMin === 60);
ok('数组', S.normalize([1, 2, 3]).miniMetric === 'cache');
ok('嵌套为 null', S.normalize({ reminders: null }).reminders.water.on === true);
ok('嵌套为字符串', S.normalize({ reminders: 'x' }).reminders.eyes.everyMin === 40);

console.log('\n[3] 数值裁剪');
ok('everyMin 太小 -> 5', S.normalize({ reminders: { water: { everyMin: 0 } } }).reminders.water.everyMin === 5);
ok('everyMin 太大 -> 240', S.normalize({ reminders: { water: { everyMin: 9999 } } }).reminders.water.everyMin === 240);
ok('everyMin 负数 -> 5', S.normalize({ reminders: { water: { everyMin: -30 } } }).reminders.water.everyMin === 5);
ok('everyMin 小数取整', S.normalize({ reminders: { water: { everyMin: 45.6 } } }).reminders.water.everyMin === 46);
ok('everyMin 字符串数字可用', S.normalize({ reminders: { water: { everyMin: '30' } } }).reminders.water.everyMin === 30);
ok('everyMin NaN -> 默认', S.normalize({ reminders: { water: { everyMin: 'abc' } } }).reminders.water.everyMin === 45);
ok('thresholdPct 上限 99', S.normalize({ reminders: { memHigh: { thresholdPct: 200 } } }).reminders.memHigh.thresholdPct === 99);
ok('thresholdPct 下限 50', S.normalize({ reminders: { memHigh: { thresholdPct: 1 } } }).reminders.memHigh.thresholdPct === 50);
ok('sustain 范围 1..30', S.normalize({ reminders: { memHigh: { sustain: 100 } } }).reminders.memHigh.sustain === 30);
ok('cooldownMin 范围 1..180', S.normalize({ reminders: { memHigh: { cooldownMin: 0 } } }).reminders.memHigh.cooldownMin === 1);

console.log('\n[3b] 自定义分钟数不被吸附到固定档位');
ok('37 分钟保持 37', S.normalize({ reminders: { water: { everyMin: 37 } } }).reminders.water.everyMin === 37);
ok('7 分钟保持 7', S.normalize({ reminders: { stand: { everyMin: 7 } } }).reminders.stand.everyMin === 7);
ok('119 分钟保持 119', S.normalize({ reminders: { eyes: { everyMin: 119 } } }).reminders.eyes.everyMin === 119);
ok('1 分钟被抬到下限 5', S.normalize({ reminders: { water: { everyMin: 1 } } }).reminders.water.everyMin === 5);

console.log('\n[4] 布尔与枚举');
ok('on 字符串 "true" 退回默认（严格布尔）',
   S.normalize({ reminders: { water: { on: 'true' } } }).reminders.water.on === true);
ok('on = false 被保留',
   S.normalize({ reminders: { water: { on: false } } }).reminders.water.on === false);
ok('miniMetric 非法值退回 cache', S.normalize({ miniMetric: 'disk' }).miniMetric === 'cache');
ok('miniMetric = mem 保留', S.normalize({ miniMetric: 'mem' }).miniMetric === 'mem');

console.log('\n[4b] 首屏视图 uiDefault（1.6.0 新增）');
ok('默认 compact（极简）', d.uiDefault === 'compact', d.uiDefault);
ok('full 被保留', S.normalize({ uiDefault: 'full' }).uiDefault === 'full');
ok('remember 被保留', S.normalize({ uiDefault: 'remember' }).uiDefault === 'remember');
ok('非法值退回 compact', S.normalize({ uiDefault: 'wide' }).uiDefault === 'compact');
ok('非字符串退回 compact', S.normalize({ uiDefault: 1 }).uiDefault === 'compact');
ok('null 退回 compact', S.normalize({ uiDefault: null }).uiDefault === 'compact');
ok('未设置时退回 compact', S.normalize({}).uiDefault === 'compact');
ok('uiDefault 不影响 ui 本身', S.normalize({ uiDefault: 'full' }).ui.cache === false);

console.log('\n[5] 未知字段被丢弃');
const withExtra = S.normalize({ hack: 1, reminders: { water: { everyMin: 30, evil: 'x' } } });
ok('顶层未知键丢弃', withExtra.hack === undefined);
ok('嵌套未知键丢弃', withExtra.reminders.water.evil === undefined);
ok('已知键正常保留', withExtra.reminders.water.everyMin === 30);

console.log('\n[6] 序列化往返');
const cfg = S.normalize({ reminders: { stand: { on: false, everyMin: 90 } } });
const rt = S.parse(S.stringify(cfg));
ok('roundtrip 一致', JSON.stringify(rt) === JSON.stringify(cfg));
ok('坏 JSON 回默认', S.parse('{oops').reminders.water.everyMin === 45);
ok('空串回默认', S.parse('').autoCollapse === true);

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
