/* ============================================================
 * guard.test.js — 崩溃前保护的判定逻辑（假时钟，无需 AE）
 *   node tests/guard.test.js
 * ============================================================ */
const path = require('path');
const G = require(path.join(__dirname, '..', 'js', 'guard.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const MIN = 60000;
const T0 = 1600000000000;

function mk(cfg) {
  const g = G.create(cfg);
  const box = { t: T0 };
  return { g, box, at: (min) => T0 + min * MIN };
}

// 默认状态：已保存的工程、有改动、内存 50%、余量充足
function S(o) {
  return Object.assign({
    projOpen: true,
    projPath: 'C:\\work\\demo.aep',
    projDirty: true,
    renderActive: false,
    memPct: 50,
    marginGB: 100,
    cacheFillPct: 10,
    hostAlive: true
  }, o || {});
}

console.log('\n[1] 不该动手的情况');
{
  const { g } = mk();
  ok('没有改动 -> clean，不保存', (() => {
    const r = g.evaluate(S({ projDirty: false }), T0);
    return !r.shouldSave && r.blocked === 'clean';
  })(), g.evaluate(S({ projDirty: false }), T0).blocked);

  ok('未保存过的工程 -> untitled（弹对话框比不存更糟）', (() => {
    const r = g.evaluate(S({ projPath: '' }), T0);
    return !r.shouldSave && r.blocked === 'untitled';
  })());

  ok('未打开工程 -> no-project', g.evaluate(S({ projOpen: false }), T0).blocked === 'no-project');
  ok('改动状态未知 -> unknown', g.evaluate(S({ projDirty: null }), T0).blocked === 'unknown');
  ok('总开关关闭 -> off', G.create({ on: false }).evaluate(S({ memPct: 99 }), T0).blocked === 'off');
  ok('低风险且未到积压时限 -> not-yet', g.evaluate(S(), T0).blocked === 'not-yet', g.evaluate(S(), T0).blocked);
}

console.log('\n[2] 积压超时触发（hold）');
{
  const { g } = mk({ holdMin: 10 });
  g.evaluate(S(), T0);
  const r9 = g.evaluate(S(), T0 + 9 * MIN);
  ok('9 分钟还不存', !r9.shouldSave, r9.blocked);
  const r10 = g.evaluate(S(), T0 + 10 * MIN);
  ok('满 10 分钟立即存', r10.shouldSave && r10.why === 'hold', r10.why);
  ok('理由里写明了积压时长', r10.reasons.some(x => x.includes('积压')), r10.reasons.join(' | '));
}

console.log('\n[3] 高风险立即触发（risk）');
{
  const { g } = mk();
  // v2 起物理内存降权为 20（辅助信号）：AE 的崩溃是分配失败，看提交上限而非物理余量。
  // 这里同时钉住两件事，防止以后有人「顺手」把权重改回去：
  const r = g.evaluate(S({ memPct: 95, marginGB: -3 }), T0);
  ok('物理内存 95 + 余量 -3 → 60（20+40）', r.risk === 60, r.risk);
  ok('等级 high', r.level === 'high', r.level);
  ok('立即保存且原因为 risk', r.shouldSave && r.why === 'risk', r.why);
  ok('两条理由都列出', r.reasons.length === 2, r.reasons.join(' | '));

  const r2 = G.create().evaluate(S({ commitPct: 95, marginGB: -3 }), T0);
  ok('提交内存 95 + 余量 -3 → 85（45+40）', r2.risk === 85, r2.risk);
}

console.log('\n[4] 风险分级与权重');
{
  const { g } = mk();
  const lv = (p) => g.evaluate(S({ memPct: p }), T0).level;
  ok('内存 50% -> ok', lv(50) === 'ok', lv(50));
  ok('内存 80% -> ok（单次轻微信号不惊动）', lv(80) === 'ok', lv(80));
  ok('内存 87% -> watch', lv(87) === 'watch', lv(87));
  // 关键：最危险的单信号必须直接判高危，不能被加权总分平均成「留意」
  ok('内存 93% -> high', lv(93) === 'high', lv(93));
  ok('磁盘余量为负 -> high', g.evaluate(S({ marginGB: -0.5 }), T0).level === 'high');

  const rk = (o) => G.create().evaluate(S(o), T0).risk;
  ok('内存越高风险越高', rk({ memPct: 95 }) > rk({ memPct: 87 }) && rk({ memPct: 87 }) > rk({ memPct: 80 }));
  ok('余量为负比余量偏薄更危险', rk({ marginGB: -1 }) > rk({ marginGB: 3 }));
  ok('缓存填满计 10 分', rk({ cacheFillPct: 99 }) === 10, rk({ cacheFillPct: 99 }));

  // 全部信号拉满（心跳需连续两次才算），风险必须封顶 100 而不是溢出
  const g2 = mk().g;
  const hot = S({ memPct: 99, marginGB: -50, cacheFillPct: 100, hostAlive: false });
  g2.evaluate(hot, T0);
  const all = g2.evaluate(hot, T0 + 1000);
  ok('风险封顶 100', all.risk === 100, all.risk);
  ok('封顶后仍为高危', all.level === 'high');

  ok('余量为 NaN 时不报错也不加分', rk({ marginGB: NaN }) === 0, rk({ marginGB: NaN }));
  ok('余量为 null 时不加分', rk({ marginGB: null }) === 0, rk({ marginGB: null }));
}

console.log('\n[5] 心跳丢失需要连续两次才算');
{
  const { g } = mk();
  const r1 = g.evaluate(S({ hostAlive: false }), T0);
  ok('只丢 1 次不计风险', r1.missStreak === 1 && r1.risk === 0, r1.risk);
  const r2 = g.evaluate(S({ hostAlive: false }), T0 + 3000);
  ok('连续 2 次计 30 分', r2.missStreak === 2 && r2.risk === 30, r2.risk);
  const r3 = g.evaluate(S({ hostAlive: true }), T0 + 6000);
  ok('恢复响应后清零', r3.missStreak === 0 && r3.risk === 0, r3.risk);
}

console.log('\n[6] 冷却与重复保存');
{
  const { g } = mk({ cooldownMin: 2 });
  const hot = S({ memPct: 95, marginGB: -3 });

  const r0 = g.evaluate(hot, T0);
  ok('首次判定就保存', r0.shouldSave);
  g.markSaved(T0);

  const r1 = g.evaluate(hot, T0 + 1 * MIN);
  ok('1 分钟后仍在冷却期', !r1.shouldSave && r1.blocked === 'cooldown', r1.blocked);
  ok('给出还需等待的时长', r1.waitMs === 1 * MIN, r1.waitMs);

  const r2 = g.evaluate(hot, T0 + 2 * MIN);
  ok('满 2 分钟可以再存', r2.shouldSave, r2.blocked);
}

console.log('\n[7] 渲染期间跳过');
{
  const { g } = mk();
  const r = g.evaluate(S({ renderActive: true, memPct: 96, marginGB: -5 }), T0);
  ok('渲染中不动手', !r.shouldSave && r.blocked === 'rendering', r.blocked);
  ok('但仍报出高风险', r.level === 'high', r.level);
}

console.log('\n[8] 只提示不写入');
{
  const { g } = mk({ autoSave: false });
  const r = g.evaluate(S({ memPct: 95, marginGB: -3 }), T0);
  ok('不保存', !r.shouldSave);
  ok('但建议保存', r.suggest === true);
  ok('原因标为仅提示', r.blocked === 'suggest-only', r.blocked);
}

console.log('\n[9] 状态复位');
{
  const { g } = mk({ holdMin: 10 });
  g.evaluate(S(), T0);
  g.evaluate(S(), T0 + 12 * MIN);
  g.markSaved(T0 + 12 * MIN);
  const r = g.evaluate(S({ projDirty: false }), T0 + 13 * MIN);
  ok('保存后积压清零', r.dirtySince === 0 && r.dirtyMin === 0, r.dirtySince);
  ok('随后干净状态不触发', r.blocked === 'clean');

  const r2 = g.evaluate(S({ projDirty: true }), T0 + 13 * MIN);
  ok('新改动重新从此刻计时', r2.dirtySince === T0 + 13 * MIN, r2.dirtySince);

  g.reset();
  ok('reset 清空全部计时', g.snapshot().dirtySince === 0 && g.snapshot().lastSaveAt === 0);
}

console.log('\n[10] 配置校验');
{
  const c = G.normalize({ holdMin: 0, riskSave: 999, cooldownMin: -5 });
  ok('holdMin 下限 1', c.holdMin === 1, c.holdMin);
  ok('riskSave 上限 100', c.riskSave === 100, c.riskSave);
  ok('cooldownMin 下限 1', c.cooldownMin === 1, c.cooldownMin);
  ok('脏数据回默认', G.normalize({ holdMin: 'abc' }).holdMin === 10);
  ok('riskSave 调低后更早触发', G.create({ riskSave: 40 }).evaluate(S({ memPct: 95 }), T0).shouldSave === true);
}

console.log('\n[11] 长时间运行不会写盘风暴');
{
  // 持续高危 + 用户一直在改，模拟 60 分钟真实采样
  const { g } = mk({ cooldownMin: 2, holdMin: 10 });
  let saves = 0;
  for (let t = 0; t <= 60 * MIN; t += 3000) {
    const r = g.evaluate(S({ memPct: 95 }), T0 + t);
    if (r.shouldSave) { saves++; g.markSaved(T0 + t); }
  }
  ok('60 分钟内不超过冷却能允许的次数', saves <= 31, saves + ' 次');
  ok('确实在持续保存而不是一次都不动', saves >= 25, saves + ' 次');
}

console.log('\n[12] 存完之后变干净就停手');
{
  const { g } = mk();
  let saves = 0, dirty = true;
  for (let t = 0; t <= 30 * MIN; t += 3000) {
    const r = g.evaluate(S({ memPct: 95, projDirty: dirty }), T0 + t);
    if (r.shouldSave) { saves++; g.markSaved(T0 + t); dirty = false; }
  }
  ok('只保存了一次', saves === 1, saves + ' 次');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
