/* reminder.test.js — 提醒调度测试（注入假时钟，瞬间跨越数小时）
 * 重点：间隔边界、关闭再开启、稍后提醒、阈值连续判定、冷却
 */
const R = require('../js/reminder.js');
const S = require('../js/settings.js');

const MIN = 60000;
let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

// 只开指定规则，其余关闭，避免互相干扰
function cfgOnly(keep) {
  const c = S.defaults();
  for (const id of ['water', 'stand', 'eyes', 'mem', 'memHigh']) {
    c.reminders[id].on = (id === keep);
  }
  return c;
}
function mk() {
  const box = { t: 0 };
  const eng = R.create({ now: () => box.t });
  return { eng, box };
}
const ids = list => list.map(x => x.id).join(',');

console.log('[1] 起始不立即触发');
{
  const { eng, box } = mk();
  const c = cfgOnly('water');   // 45 分钟
  ok('刚启动时静默', eng.tick(c, {}).length === 0);
  box.t = 44 * MIN;
  ok('44 分钟仍未触发', eng.tick(c, {}).length === 0);
  box.t = 45 * MIN - 1;
  ok('差 1 毫秒不触发', eng.tick(c, {}).length === 0);
  box.t = 45 * MIN;
  ok('整 45 分钟触发 water', ids(eng.tick(c, {})) === 'water');
}

console.log('\n[2] 触发后重新计时');
{
  const { eng, box } = mk();
  const c = cfgOnly('water');
  box.t = 45 * MIN; eng.tick(c, {});
  box.t = 89 * MIN;
  ok('89 分钟不再触发（已重置基准）', eng.tick(c, {}).length === 0);
  box.t = 90 * MIN;
  ok('90 分钟再次触发', ids(eng.tick(c, {})) === 'water');
}

console.log('\n[3] 关闭再开启不会一开就连响');
{
  const { eng, box } = mk();
  const c = cfgOnly('water');
  c.reminders.water.on = false;
  box.t = 3 * 60 * MIN;                 // 关闭状态下过了 3 小时
  ok('关闭期间不触发', eng.tick(c, {}).length === 0);

  c.reminders.water.on = true;
  ok('刚开启时不触发', eng.tick(c, {}).length === 0);
  box.t = 3 * 60 * MIN + 44 * MIN;
  ok('开启后未满间隔不触发', eng.tick(c, {}).length === 0);
  box.t = 3 * 60 * MIN + 45 * MIN;
  ok('开启后满 45 分钟触发', ids(eng.tick(c, {})) === 'water');
}

console.log('\n[4] 稍后提醒');
{
  const { eng, box } = mk();
  const c = cfgOnly('water');
  box.t = 45 * MIN;
  ok('先正常触发一次', ids(eng.tick(c, {})) === 'water');

  eng.snooze('water', 10);
  box.t = 45 * MIN + 9 * MIN;
  ok('9 分钟后还在等待', eng.tick(c, {}).length === 0);
  box.t = 45 * MIN + 10 * MIN;
  ok('10 分钟后立即补响', ids(eng.tick(c, {})) === 'water');
  ok('补响后不会连响', eng.tick(c, {}).length === 0);
}

console.log('\n[5] 内存偏高：必须连续命中');
{
  const { eng, box } = mk();
  const c = cfgOnly('memHigh');        // threshold 90, sustain 3, cooldown 15
  box.t = 1000;
  ok('第 1 次超阈值不触发', eng.tick(c, { memPct: 95 }).length === 0);
  ok('第 2 次仍不触发', eng.tick(c, { memPct: 93 }).length === 0);
  ok('第 3 次触发', ids(eng.tick(c, { memPct: 91 })) === 'memHigh');
}
{
  const { eng, box } = mk();
  const c = cfgOnly('memHigh');
  box.t = 1000;
  eng.tick(c, { memPct: 95 });
  eng.tick(c, { memPct: 95 });
  ok('中途回落到 80% 则清零', eng.tick(c, { memPct: 80 }).length === 0);
  ok('之后单次超标不足以触发', eng.tick(c, { memPct: 95 }).length === 0);
  ok('再攒一次也不够', eng.tick(c, { memPct: 95 }).length === 0);
  ok('攒满 3 次才触发', ids(eng.tick(c, { memPct: 95 })) === 'memHigh');
}

console.log('\n[6] 阈值提醒的冷却');
{
  const { eng, box } = mk();
  const c = cfgOnly('memHigh');
  box.t = 1000;
  eng.tick(c, { memPct: 95 }); eng.tick(c, { memPct: 95 });
  ok('首次触发', ids(eng.tick(c, { memPct: 95 })) === 'memHigh');

  box.t = 1000 + 5 * MIN;
  for (let k = 0; k < 4; k++) eng.tick(c, { memPct: 95 });
  ok('冷却期内即使连续超标也不响', eng.tick(c, { memPct: 95 }).length === 0);

  box.t = 1000 + 16 * MIN;
  ok('冷却结束后若仍偏高，立即补报一次',
     ids(eng.tick(c, { memPct: 95 })) === 'memHigh');
}
{
  // 对照：冷却期内回落过，则冷却结束后必须重新攒满 sustain 次
  const { eng, box } = mk();
  const c = cfgOnly('memHigh');
  box.t = 1000;
  eng.tick(c, { memPct: 95 }); eng.tick(c, { memPct: 95 });
  ok('先触发一次', ids(eng.tick(c, { memPct: 95 })) === 'memHigh');

  box.t = 1000 + 3 * MIN;
  ok('回落到 70% 不算数', eng.tick(c, { memPct: 70 }).length === 0);

  box.t = 1000 + 16 * MIN;   // 冷却已过，但证据被清零
  ok('冷却结束 + 第 1 次超标：不响', eng.tick(c, { memPct: 95 }).length === 0);
  ok('第 2 次：不响', eng.tick(c, { memPct: 95 }).length === 0);
  ok('第 3 次：才响', ids(eng.tick(c, { memPct: 95 })) === 'memHigh');
}

console.log('\n[7] 定时内存播报带实时数字');
{
  const { eng, box } = mk();
  const c = cfgOnly('mem');            // 30 分钟
  box.t = 30 * MIN;
  const list = eng.tick(c, { memPct: 73.4, memUsed: 11.7 * 1073741824, memTotal: 16 * 1073741824 });
  ok('触发 mem', ids(list) === 'mem');
  ok('消息含百分比', /73%/.test(list[0].msg), list[0].msg);
  ok('消息含用量', /GB/.test(list[0].msg), list[0].msg);
}

console.log('\n[8] 多条同时到期');
{
  const { eng, box } = mk();
  const c = S.defaults();
  c.reminders.stand.on = false;
  c.reminders.mem.on = false;
  c.reminders.memHigh.on = false;
  // water 45 / eyes 40，都开着
  box.t = 60 * MIN;
  const got = ids(eng.tick(c, { memPct: 50 }));
  ok('返回两条', got === 'water,eyes', got);
}

console.log('\n[9] 异常输入不崩');
{
  const { eng, box } = mk();
  box.t = 10 * MIN;
  ok('tick(null)', eng.tick(null, {}).length === 0);
  ok('tick({})', eng.tick({}, {}).length === 0);
  ok('cfg 缺 reminders', eng.tick({ reminders: null }, {}).length === 0);
  ok('ctx 为 null 时不崩', eng.tick(S.defaults(), null).length === 0);

  const { eng: e2, box: b2 } = mk();
  const c = cfgOnly('memHigh');
  b2.t = 1000;
  ok('ctx 无 memPct 时不触发阈值提醒', e2.tick(c, {}).length === 0);
  ok('ctx memPct 为 NaN 也安全', e2.tick(c, { memPct: NaN }).length === 0);
}

console.log('\n[10] 每条提醒都有图标与文案');
{
  const { eng, box } = mk();
  const out = {};
  ['water', 'stand', 'eyes', 'mem'].forEach(k => {
    const { eng: e, box: b } = mk();
    const c = cfgOnly(k);
    b.t = c.reminders[k].everyMin * MIN;
    const l = e.tick(c, { memPct: 60, memUsed: 8e9, memTotal: 16e9 });
    out[k] = l[0];
  });
  ok('water 有图标+文案', !!out.water && !!out.water.icon && out.water.msg.length > 5, out.water && out.water.msg);
  ok('stand 有图标+文案', !!out.stand && !!out.stand.icon && out.stand.msg.length > 5);
  ok('eyes 有图标+文案', !!out.eyes && out.eyes.msg.indexOf('20') >= 0);
  ok('mem 有图标+文案', !!out.mem && !!out.mem.icon);
  ok('level 默认 info', out.water.level === 'info');
}

console.log('\n[11] snapshot 只读快照');
{
  const { eng, box } = mk();
  const c = cfgOnly('water');
  box.t = 45 * MIN; eng.tick(c, {});
  const s = eng.snapshot();
  ok('记录了 lastFired', s.lastFired.water === 45 * MIN);
  s.lastFired.water = 0;
  ok('改快照不影响内部状态', eng.snapshot().lastFired.water === 45 * MIN);
}

console.log('\n[12] 渲染期间丢弃提醒，事后不补响');
{
  // 面板在渲染时会把 tick 的结果直接丢掉（不展示）。
  // 这条测试守住的正是"丢弃"这个动作的安全性：
  // 引擎在丢弃时已经推进了计时，所以渲染两小时结束后不会一口气补响一串。
  const { eng, box } = mk();
  const c = cfgOnly('water');          // 45 分钟

  box.t = 0; eng.tick(c, {});
  box.t = 46 * MIN;
  ok('到点了，产出一条', ids(eng.tick(c, {})) === 'water');

  box.t = 47 * MIN;
  ok('丢弃后立刻不再产出（没有补响）', eng.tick(c, {}).length === 0);

  // 模拟渲染持续 2 小时：每分钟 tick 一次，结果全部丢弃
  let muted = 0;
  for (let t = 48; t <= 168; t++) {
    box.t = t * MIN;                   // 必须推进时钟，否则这条测试等于什么都没测
    muted += eng.tick(c, {}).length;
  }
  ok('2 小时渲染期间静音 2 条（45 分钟一次，91 与 136 分）', muted === 2, muted);

  const after = eng.tick(c, {});
  ok('渲染结束后不会瞬间连响', after.length === 0, after.length);
}

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
