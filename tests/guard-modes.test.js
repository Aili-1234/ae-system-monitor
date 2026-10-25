/* ============================================================
 * guard-modes.test.js — 崩溃保护档位：推荐、预设、窗口、不稳定期
 *   node tests/guard-modes.test.js
 *
 * 要钉住的四件事：
 *   1) 装好后「按本机崩溃史自动选档」的规则：0–1 次→稳定、2–4→偶发、≥5→高频
 *   2) 每个档位写进设置的具体数值（用户能在抽屉里看到它们真的变了）
 *   3) 崩溃窗口按档位走：稳定机崩一次值得警惕三天，高频机三小时前崩过只是日常
 *   4) quiet 档不进入不稳定期 —— 否则「别打扰我」和「更勤保存」自相矛盾
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
    commitPct: 30,
    marginGB: 100,
    cacheFillPct: 10,
    hostAlive: true
  }, o || {});
}
const ev = (mode, o, t) => G.create({ mode: mode }).evaluate(S(o), t || T0);

console.log('\n[1] 按本机崩溃史推荐档位');
{
  ok('读不到历史 → 偶发（中间档）', G.recommend(null).mode === 'occasional', G.recommend(null).mode);
  ok('历史为 null 时有说明', /读不到/.test(G.recommend(null).reason), G.recommend(null).reason);

  ok('0 次 → 稳定', G.recommend({ count30: 0 }).mode === 'stable');
  ok('1 次 → 稳定', G.recommend({ count30: 1 }).mode === 'stable');
  ok('2 次 → 偶发', G.recommend({ count30: 2 }).mode === 'occasional');
  ok('4 次 → 偶发', G.recommend({ count30: 4 }).mode === 'occasional');
  ok('5 次 → 高频', G.recommend({ count30: 5 }).mode === 'frequent');
  ok('12 次 → 高频', G.recommend({ count30: 12 }).mode === 'frequent');

  ok('理由里带次数', /12 次/.test(G.recommend({ count30: 12 }).reason), G.recommend({ count30: 12 }).reason);
  ok('0 次的理由是"没有记录"', /没有崩溃记录/.test(G.recommend({ count30: 0 }).reason));
  ok('推荐带 count30 便于界面显示', G.recommend({ count30: 3 }).count30 === 3);
}

console.log('\n[2] 档位对应的设置数值（会被写进 settings）');
{
  const st = G.preset('stable');
  ok('稳定：15 分 / 60 分', st.holdMin === 15 && st.riskSave === 60, st.holdMin + '/' + st.riskSave);
  const oc = G.preset('occasional');
  ok('偶发：10 分 / 60 分（等于旧默认，老用户无感）', oc.holdMin === 10 && oc.riskSave === 60, oc.holdMin + '/' + oc.riskSave);
  const fr = G.preset('frequent');
  ok('高频：5 分 / 45 分', fr.holdMin === 5 && fr.riskSave === 45, fr.holdMin + '/' + fr.riskSave);
  const qt = G.preset('quiet');
  ok('安静：20 分 / 70 分', qt.holdMin === 20 && qt.riskSave === 70, qt.holdMin + '/' + qt.riskSave);
  ok('非法档位退回偶发', G.preset('nonsense').mode === 'occasional');
  ok('返回里带 mode', G.preset('frequent').mode === 'frequent');
}

console.log('\n[3] 崩溃窗口按档位走');
{
  // 稳定：dayH=72，48 小时前崩过仍计 12 分
  const s48 = ev('stable', { crashHoursAgo: 48 });
  ok('稳定机 48 小时前崩过 → 12 分', s48.risk === 12, s48.risk);
  ok('稳定机 48 小时前仍是"近期"', /近期崩过/.test(s48.reasons.join('|')), s48.reasons.join('|'));
  ok('稳定机 30 小时前不算"刚崩过"（hot=24）', /近期/.test(ev('stable', { crashHoursAgo: 30 }).reasons.join('|')));
  ok('稳定机 80 小时前 → 0 分', ev('stable', { crashHoursAgo: 80 }).risk === 0);
  ok('稳定机 20 小时前 → 刚崩过 22 分', ev('stable', { crashHoursAgo: 20 }).risk === 22);

  // 偶发：沿用旧的 6/24
  ok('偶发 30 小时前 → 0 分（窗口只有 24）', ev('occasional', { crashHoursAgo: 30 }).risk === 0);
  ok('偶发 10 小时前 → 12 分', ev('occasional', { crashHoursAgo: 10 }).risk === 12);
  ok('偶发 3 小时前 → 22 分', ev('occasional', { crashHoursAgo: 3 }).risk === 22);

  // 高频：3/12
  ok('高频 5 小时前 → 12 分', ev('frequent', { crashHoursAgo: 5 }).risk === 12);
  ok('高频 2 小时前 → 22 分', ev('frequent', { crashHoursAgo: 2 }).risk === 22);
  ok('高频 20 小时前 → 0 分（窗口只有 12）', ev('frequent', { crashHoursAgo: 20 }).risk === 0);

  ok('返回里带当前档位', ev('frequent', {}).mode === 'frequent');
}

console.log('\n[4] 不稳定期：不同档位收紧的程度不同');
{
  const stable = ev('stable', { crashHoursAgo: 10 });
  ok('稳定机进入不稳定期', stable.unstable === true);
  ok('稳定机积压上限 15 → 8 分钟', stable.holdMin === 8, stable.holdMin);
  ok('稳定机阈值 60 → 45', stable.riskSave === 45, stable.riskSave);

  const freq = ev('frequent', { crashHoursAgo: 2 });
  ok('高频机积压 5 → 3 分钟', freq.holdMin === 3, freq.holdMin);
  ok('高频机阈值 45 → 40（下限保护）', freq.riskSave === 40, freq.riskSave);

  const quiet = ev('quiet', { crashHoursAgo: 2 });
  ok('安静档不进不稳定期', quiet.unstable === false, quiet.unstable);
  ok('安静档积压仍是 20 分钟', quiet.holdMin === 20, quiet.holdMin);
  ok('安静档阈值仍是 70', quiet.riskSave === 70, quiet.riskSave);
  ok('安静档仍会给崩溃计分（只是不额外收紧）', quiet.risk === 22, quiet.risk);
}

console.log('\n[5] 配置归一化');
{
  ok('缺省档位是偶发', G.normalize({}).mode === 'occasional', G.normalize({}).mode);
  ok('非法档位退回偶发', G.normalize({ mode: 'turbo' }).mode === 'occasional');
  ok('合法档位保留', G.normalize({ mode: 'quiet' }).mode === 'quiet');
  ok('档位不影响数值裁剪', G.normalize({ mode: 'quiet', holdMin: 999 }).holdMin === 120);
}

console.log('\n[6] 档位与其它信号共存');
{
  // 高频机：阈值 45，commit 80（28 分）+ 近 2 小时崩过（22 分）= 50 → 过线
  const r = G.create({ mode: 'frequent' }).evaluate(S({ commitPct: 80, crashHoursAgo: 2 }), T0);
  ok('高频机 50 分即触发保存', r.shouldSave === true, r.risk + '/' + r.blocked);
  ok('原因是 risk', r.why === 'risk', r.why);

  // 同样的信号，安静档阈值 70 → 不触发
  const q = G.create({ mode: 'quiet' }).evaluate(S({ commitPct: 80, crashHoursAgo: 2 }), T0);
  ok('安静档 50 分不触发', q.shouldSave === false, q.risk + '/' + q.blocked);

  // 稳定档没有崩溃史时，一切照旧
  const none = G.create({ mode: 'stable' }).evaluate(S({ crashHoursAgo: null }), T0);
  ok('没有崩溃记录时不额外加分', none.risk === 0, none.risk);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
