/* ============================================================
 * guard-crash.test.js — 崩溃判定的 v2 信号：提交内存 + 崩溃历史
 *   node tests/guard-crash.test.js
 *
 * 为什么单独一组：
 *   这两条信号不是「拍脑袋加的权重」，各自有依据，改错了不会报错、只会悄悄失准，
 *   所以要用断言把「依据」本身钉住：
 *
 *   1) 提交内存（commit）优先于物理内存占用率
 *      AE 最常见的崩溃提示是 "Unable to allocate XXX MB of memory" —— 分配失败。
 *      分配失败撞的是提交上限，不是物理余量。Adobe 社区里有 96/128 GB 的机器
 *      在内存只用 40% 时照样每 20 分钟报这个错。
 *      → 所以 commit 权重 45，物理内存降到 20（仍保留，代价不对称）。
 *
 *   2) 崩溃历史 → 不稳定期
 *      崩溃常成簇出现。WER 的 AppCrash 记录能拿到确切时间，
 *      24 小时内崩过就把保存门槛调低（用户设的 10 分钟不改，只是有效值减半）。
 *
 *   fixture 全部用假时钟，不依赖 AE、不依赖本机 WER。
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
const ev = (o, t) => G.create().evaluate(S(o), t || T0);

console.log('\n[1] 提交内存：内存侧的主信号');
{
  const r92 = ev({ commitPct: 92 });
  ok('commit 92 → 直接高危（hard=2）', r92.hard === 2, r92.hard);
  ok('commit 92 → 风险 45', r92.risk === 45, r92.risk);
  ok('commit 92 → 等级 high', r92.level === 'high', r92.level);
  ok('理由写明"再分配可能失败"', /提交内存 92%/.test(r92.reasons.join('|')), r92.reasons.join('|'));

  const r80 = ev({ commitPct: 80 });
  ok('commit 80 → 至少留意', r80.level === 'watch', r80.level);
  ok('commit 80 → 风险 28', r80.risk === 28, r80.risk);

  const r70 = ev({ commitPct: 70 });
  ok('commit 70 → 风险 12，不升等级', r70.risk === 12 && r70.level === 'ok', r70.risk + '/' + r70.level);

  ok('commit 缺失 → 不加分', ev({}).risk === 0, ev({}).risk);
  ok('commit null → 不加分', ev({ commitPct: null }).risk === 0);
}

console.log('\n[2] 物理内存降权，但极端情况仍会拦住');
{
  const r = ev({ memPct: 95 });
  ok('物理 95 → 风险只有 20（旧模型是 45）', r.risk === 20, r.risk);
  ok('物理 95 仍是 hard=2（误存只卡一下，漏存丢工作）', r.hard === 2, r.hard);
  ok('物理 95 等级仍 high', r.level === 'high', r.level);

  const r2 = ev({ memPct: 86 });
  ok('物理 86 → 风险 12', r2.risk === 12, r2.risk);
  const r3 = ev({ memPct: 76 });
  ok('物理 76 → 风险 6', r3.risk === 6, r3.risk);
}

console.log('\n[3] commit 与物理同时高 → 只有 commit 算主项，不重复计满');
{
  const r = ev({ commitPct: 95, memPct: 97 });
  ok('两者叠加后封顶 100', r.risk === 65, r.risk);
  ok('理由里两条都在', r.reasons.length === 2, r.reasons.join(' | '));
}

console.log('\n[4] 崩溃历史：近 6 小时');
{
  const r = ev({ crashHoursAgo: 3 });
  ok('3 小时前崩过 → +22', r.risk === 22, r.risk);
  ok('至少留意', r.level === 'watch', r.level);
  ok('理由含"崩过"', /崩过/.test(r.reasons.join('|')), r.reasons.join('|'));
  ok('文案用分钟/小时，不是小数', /小时/.test(r.reasons.join('|')));

  const r2 = ev({ crashHoursAgo: 0.5 });
  ok('半小时前崩过 → 文案用"分钟"', /分钟/.test(r2.reasons.join('|')), r2.reasons.join('|'));
}

console.log('\n[5] 崩溃历史：6~24 小时');
{
  const r = ev({ crashHoursAgo: 12 });
  ok('12 小时前崩过 → +12', r.risk === 12, r.risk);
  ok('仍算不稳定期', r.unstable === true);
  ok('风险 12 不升到留意（要别的信号一起）', r.level === 'ok', r.level);
}

console.log('\n[6] 崩溃历史：超过 24 小时不算');
{
  const r = ev({ crashHoursAgo: 30 });
  ok('30 小时前 → 不加分', r.risk === 0, r.risk);
  ok('stable 期', r.unstable === false);
  ok('无崩溃记录 → 不加分也不报错', ev({ crashHoursAgo: null }).risk === 0);
}

console.log('\n[7] 不稳定期：积压上限减半（默认 10 → 5 分钟）');
{
  const stable = ev({ crashHoursAgo: 48 });
  ok('稳定期：有效上限 10 分钟', stable.holdMin === 10, stable.holdMin);

  const hot = ev({ crashHoursAgo: 2 });
  ok('不稳定期：有效上限 5 分钟', hot.holdMin === 5, hot.holdMin);

  // 假时钟：改动攒了 6 分钟
  const g1 = G.create();
  g1.evaluate(S({ projDirty: true, crashHoursAgo: 48 }), T0);            // 记下 dirtySince
  const a = g1.evaluate(S({ projDirty: true, crashHoursAgo: 48 }), T0 + 6 * MIN);
  ok('稳定期 6 分钟：不保存', a.shouldSave === false, a.blocked);

  const g2 = G.create();
  g2.evaluate(S({ projDirty: true, crashHoursAgo: 2 }), T0);
  const b = g2.evaluate(S({ projDirty: true, crashHoursAgo: 2 }), T0 + 6 * MIN);
  ok('不稳定期 6 分钟：保存', b.shouldSave === true, b.why + '/' + b.risk);
}

console.log('\n[8] 不稳定期：风险阈值下降（60 → 45）');
{
  const stable = ev({ crashHoursAgo: 48 });
  ok('稳定期阈值 60', stable.riskSave === 60, stable.riskSave);

  const hot = ev({ crashHoursAgo: 2 });
  ok('不稳定期阈值 45', hot.riskSave === 45, hot.riskSave);

  // 只靠 commit 80（28 分）+ 崩溃当天（12 分）= 40：稳定期不存，不稳定期也不够
  const mid = ev({ commitPct: 80, crashHoursAgo: 12 });
  ok('40 分：稳定期不保存', ev({ commitPct: 80 }).risk === 28);
  ok('40 分：不稳定期仍未到 45', mid.risk === 40 && mid.level === 'watch', mid.risk + '/' + mid.level);

  // commit 80 + 近 6 小时崩过 = 50：不稳定期过线，稳定期不过
  const s1 = ev({ commitPct: 80, crashHoursAgo: 48 });
  const s2 = ev({ commitPct: 80, crashHoursAgo: 5 });
  ok('50 分：稳定期不保存', s1.shouldSave === false, s1.risk);
  ok('50 分：不稳定期保存', s2.shouldSave === true, s2.risk);
}

console.log('\n[9] 有效阈值的下限保护（不让设置互相顶穿）');
{
  const low = G.create({ riskSave: 40 }).evaluate(S({ crashHoursAgo: 1 }), T0);
  ok('riskSave 设 40 时不稳定期不会低于 40', low.riskSave === 40, low.riskSave);

  const tight = G.create({ holdMin: 1 }).evaluate(S({ crashHoursAgo: 1 }), T0);
  ok('holdMin 设 1 时不稳定期仍 >= 2', tight.holdMin === 2, tight.holdMin);
}

console.log('\n[10] 边界：正好 24 小时算不稳定，24.1 小时不算');
{
  ok('24.0h → unstable', ev({ crashHoursAgo: 24 }).unstable === true);
  ok('24.1h → stable', ev({ crashHoursAgo: 24.1 }).unstable === false);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
