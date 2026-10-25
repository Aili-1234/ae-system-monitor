/* ============================================================
 * trend-margin.test.js — 采样双字段：缓存字节 + 余量
 *   node tests/trend-margin.test.js
 *
 * 要钉住的语义（这是 ② 修改的全部理由）：
 *   1) ETA 的「被除数」是余量、斜率也必须是余量的 —— 撞线的是余量，不是缓存。
 *      旧实现用缓存斜率除余量，单位都不是一回事。
 *   2) 缓存斜率只用来解释「是不是缓存在吃盘」。两者背离时必须说清是别的东西。
 *   3) 老历史没有 m，必须原样退回旧算法 —— 不假装有数据。
 * ============================================================ */
const path = require('path');
const T = require(path.join(__dirname, '..', 'js', 'trend.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const GB = 1073741824;
const MIN = 60000;

function H() { return []; }
function hist(rows) {
  // rows: [分钟, 缓存GB, 余量GB|null]
  return rows.map(r => ({ t: r[0] * MIN, b: r[1] * GB, m: r[2] }));
}

console.log('\n[1] push 记下余量，缺省为 null');
{
  const h = H();
  T.push(h, 0, 5 * GB, { marginGB: 38.24 });
  ok('存了 m', h[0].m === 38.2, h[0].m);
  ok('0.1 GB 精度（38.24 → 38.2）', h[0].m === 38.2);

  const h2 = H();
  T.push(h2, 0, 5 * GB);
  ok('没给 marginGB → m = null', h2[0].m === null, h2[0].m);

  const h3 = H();
  T.push(h3, 0, 5 * GB, { marginGB: null });
  ok('显式 null → m = null（NaN 不算）', h3[0].m === null);

  const h4 = H();
  T.push(h4, 0, 5 * GB, { marginGB: NaN });
  ok('NaN → m = null', h4[0].m === null);
}

console.log('\n[2] 去重规则：只有「缓存和余量都没变」才算没信息');
{
  const h = H();
  T.push(h, 0, 5 * GB, { marginGB: 38 });
  T.push(h, 2 * MIN, 5 * GB, { marginGB: 38 });          // 都没变
  ok('都没变 → 不新增', h.length === 1, h.length);

  T.push(h, 4 * MIN, 5 * GB, { marginGB: 30 });          // 缓存没变，余量掉了 8 GB
  ok('缓存不变但余量变了 → 必须记下来', h.length === 2, h.length);
  ok('新点带上了新余量', h[1].m === 30, h[1].m);
}

console.log('\n[3] marginRate：至少要 2 个带 m 的点、跨度 ≥ 10 分钟');
{
  ok('空历史 → 不 ok', T.marginRate([], 3600000).ok === false);
  ok('只有 1 个点 → 不 ok', T.marginRate(hist([[0, 5, 38]]), 3600000).ok === false);

  const h = hist([[0, 5, 38], [5, 5.2, 37]]);
  ok('跨度 5 分钟 → 不 ok（样本不足）', T.marginRate(h, 3600000).ok === false, T.marginRate(h, 3600000).spanMs);

  const h2 = hist([[0, 5, 38], [60, 6, 36]]);
  const r = T.marginRate(h2, 7200000);
  ok('跨度 60 分钟 → ok', r.ok === true);
  ok('消耗 2 GB/h', Math.abs(r.perHour - 2) < 1e-9, r.perHour);
}

console.log('\n[4] marginRate：跳过没有 m 的老点，不污染统计');
{
  const h = [
    { t: 0, b: 5 * GB, m: null },             // 老点
    { t: 30 * MIN, b: 5.5 * GB, m: 37 },
    { t: 90 * MIN, b: 6 * GB, m: 35 }
  ];
  const r = T.marginRate(h, 2 * 3600000);
  ok('只数带 m 的点', r.points === 2, r.points);
  ok('斜率用 37→35（60 分钟）= 2 GB/h', Math.abs(r.perHour - 2) < 1e-9, r.perHour);
}

console.log('\n[5] marginRate：窗口外的点不参与');
{
  const h = hist([[0, 5, 38], [60, 5.5, 30], [180, 6, 28]]);
  const r = T.marginRate(h, 2 * 3600000);   // 只看最近 2 小时 → 60~180
  ok('窗口内跨度 2 小时', Math.abs(r.spanMs - 120 * MIN) < 1, r.spanMs / MIN);
  ok('用 30→28（1 GB/h），不是 38→28（3.3）', Math.abs(r.perHour - 1) < 1e-9, r.perHour);
}

console.log('\n[6] describe：缓存在吃盘时，ETA 用余量斜率（不是缓存斜率）');
{
  // 缓存 +1 GB/h，余量 −2 GB/h：若用缓存斜率会算成 36 小时，正解是 18 小时
  const h = hist([[0, 5, 38], [60, 6, 36]]);
  const d = T.describe(h, 36);
  ok('ETA = 18 小时（余量斜率）', d.etaHours === 18, d.etaHours);
  ok('文案含 18 小时', /18 小时后耗尽余量/.test(d.text), d.text);
  ok('文案显示缓存增速', /\+1\.0 GB\/h/.test(d.text), d.text);
  ok('18 小时内 → warn', d.level === 'warn', d.level);
}

console.log('\n[7] describe：缓存没涨、磁盘在掉 → 明确指出是别的东西');
{
  const h = hist([[0, 5, 38], [60, 5, 36]]);
  const d = T.describe(h, 36);
  ok('不给「缓存未增长」这种误导文案', !/^缓存未增长/.test(d.text), d.text);
  ok('说清缓存未增长', /缓存未增长/.test(d.text), d.text);
  ok('提醒可能是其它程序', /其它程序/.test(d.text), d.text);
  ok('仍然给 ETA', d.etaHours === 18, d.etaHours);
  ok('旧实现在这里会完全不给 ETA（这正是要修的）', d.etaHours !== undefined);
}

console.log('\n[8] describe：缓存在涨但只解释小部分 → 报差额');
{
  // 缓存 +0.4 GB/h，余量 −2 GB/h → 缓存只占 20%
  const h = hist([[0, 5, 38], [60, 5.4, 36]]);
  const d = T.describe(h, 36);
  ok('文案同时给两个速率', /缓存 \+0\.4 GB\/h/.test(d.text) && /磁盘 −2\.0 GB\/h/.test(d.text), d.text);
  ok('点出差额来自其它程序', /差额来自其它程序/.test(d.text), d.text);
  ok('ETA 仍按余量算 = 18 小时', d.etaHours === 18, d.etaHours);
}

console.log('\n[9] describe：余量没在减少 → 不硬编 ETA');
{
  const h = hist([[0, 5, 38], [60, 6, 38]]);
  const d = T.describe(h, 38);
  ok('没有 etaHours 或为 undefined', d.etaHours === undefined, String(d.etaHours));
  ok('说明余量未下降', /余量暂未下降/.test(d.text), d.text);
  ok('level 不是 warn', d.level === 'flat', d.level);
}

console.log('\n[10] describe：余量已为负 → 直接说清楚');
{
  const h = hist([[0, 5, -6], [60, 5.2, -8.2]]);
  const d = T.describe(h, -8.2);
  ok('level = bad', d.level === 'bad', d.level);
  ok('文案含"已为负"', /已为负/.test(d.text), d.text);
  ok('文案含负值', /−8\.2 GB/.test(d.text), d.text);
}

console.log('\n[11] 没有 m 的老历史 → 退回旧算法，逐字不变');
{
  const legacy = [
    { t: 0, b: 5 * GB },
    { t: 60 * MIN, b: 6 * GB }
  ];
  const d = T.describe(legacy, 36);
  ok('旧文案：↑ +1.0 GB/h · 约 36 小时后耗尽余量',
     d.text === '↑ +1.0 GB/h · 约 36 小时后耗尽余量', d.text);
  ok('旧 level = up（36 小时不告警）', d.level === 'up', d.level);

  const flat = [{ t: 0, b: 5 * GB }, { t: 60 * MIN, b: 5 * GB }];
  ok('旧的"缓存未增长"仍在（没有 m 时只能这么说）',
     T.describe(flat, 36).text === '缓存未增长', T.describe(flat, 36).text);

  const short = [{ t: 0, b: 5 * GB }, { t: 3 * MIN, b: 5.1 * GB }];
  ok('样本不足仍是"采样中"', /采样中（3 分钟）/.test(T.describe(short, 36).text), T.describe(short, 36).text);
}

console.log('\n[12] 只有部分点有 m 时，够 2 个点就用新算法');
{
  const h = [
    { t: 0, b: 5 * GB, m: null },
    { t: 60 * MIN, b: 6 * GB, m: 36 },
    { t: 120 * MIN, b: 7 * GB, m: 34 }
  ];
  const d = T.describe(h, 34);
  ok('用余量斜率（−2 GB/h）→ 17 小时', d.etaHours === 17, d.etaHours);
  ok('返回里带 marginRate', !!d.marginRate && d.marginRate.points === 2, d.marginRate && d.marginRate.points);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
