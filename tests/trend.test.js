/* ============================================================
 * trend.test.js — 缓存增速与"还能撑多久"（假时钟）
 *   node tests/trend.test.js
 * ============================================================ */
const path = require('path');
const T = require(path.join(__dirname, '..', 'js', 'trend.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
const MIN = 60000;
const GB = 1073741824;
const T0 = 1600000000000;

// 按「每分钟涨 rateGB」造一串采样
function series(rateGBPerMin, minutes, stepMin) {
  const h = [];
  for (let m = 0; m <= minutes; m += (stepMin || 1)) {
    T.push(h, T0 + m * MIN, (10 + rateGBPerMin * m) * GB);
  }
  return h;
}

console.log('\n[1] 采样太密要丢弃');
{
  const h = [];
  T.push(h, T0, 1 * GB);
  T.push(h, T0 + 1000, 2 * GB);        // 只隔 1 秒
  ok('1 秒后的采样被丢弃', h.length === 1, h.length);
  T.push(h, T0 + 61000, 2 * GB);
  ok('1 分钟后的采样被接受', h.length === 2, h.length);
  T.push(h, T0 + 122000, 2 * GB);
  ok('数值没变且间隔短 -> 不重复记', h.length === 2, h.length);
}

console.log('\n[2] 非法输入不污染历史');
{
  const h = [];
  T.push(h, T0, 1 * GB);
  T.push(h, NaN, 2 * GB);
  T.push(h, T0 + 120000, NaN);
  T.push(h, T0 + 180000, -1);
  ok('NaN / 负数都被拒', h.length === 1, h.length);
  ok('空历史也不崩', T.push(null, T0, 1 * GB).length === 1);
}

console.log('\n[3] 增速计算');
{
  // 每分钟涨 0.01 GB -> 每小时 0.6 GB
  const h = series(0.01, 60);
  const r = T.rate(h);
  ok('样本足够', r.ok === true);
  ok('方向为上涨', r.dir === 'up', r.dir);
  ok('增速 ≈ 0.6 GB/h', Math.abs(r.perHour - 0.6) < 0.001, r.perHour.toFixed(4));
  ok('跨度 60 分钟', Math.round(r.spanMs / MIN) === 60, Math.round(r.spanMs / MIN));
}

console.log('\n[4] 样本不足不给结论');
{
  const h = series(0.05, 5);          // 只有 5 分钟
  const r = T.rate(h);
  ok('不足 10 分钟 -> ok=false', r.ok === false, Math.round(r.spanMs / MIN) + ' 分钟');
  const d = T.describe(h, 50);
  ok('界面文案为「采样中」', /采样中/.test(d.text), d.text);

  ok('单点也不给结论', T.rate(series(0.05, 0)).ok === false);
  ok('空历史不崩', T.rate([]).ok === false && T.rate(null).ok === false);
}

console.log('\n[5] 缓存回落的处理');
{
  const h = [];
  for (let m = 0; m <= 30; m++) T.push(h, T0 + m * MIN, (20 - 0.1 * m) * GB);
  const r = T.rate(h);
  ok('方向为下降', r.dir === 'down', r.dir);
  const d = T.describe(h, 50);
  ok('文案说「回落」', /回落/.test(d.text), d.text);
  ok('回落时不给 ETA', d.etaHours === undefined, d.etaHours);
}

console.log('\n[6] 零增长的判定');
{
  const h = [];
  for (let m = 0; m <= 30; m += 2) T.push(h, T0 + m * MIN, 5 * GB);
  const r = T.rate(h);
  ok('方向为平', r.dir === 'flat', r.dir);
  ok('文案说「未增长」', /未增长/.test(T.describe(h, 50).text), T.describe(h, 50).text);
  ok('不增长的 ETA 为 Infinity', T.eta(50, 0) === Infinity);
}

console.log('\n[7] ETA 计算');
{
  ok('余量 12 GB / 1.2 GB/h = 10 小时', T.eta(12, 1.2) === 10);
  ok('余量已为负 -> 0', T.eta(-3, 1.2) === 0);
  ok('参数缺失 -> null', T.eta(NaN, 1) === null && T.eta(5, NaN) === null);

  const h = series(0.02, 60);          // 1.2 GB/h
  const d = T.describe(h, 12);
  ok('一小时内的积压会标黄', d.level === 'warn', d.level);
  ok('文案含「约 10 小时后」', /约 10 小时后/.test(d.text), d.text);

  const d2 = T.describe(h, 24 * 5);    // 5 天量
  ok('远期积压不标黄', d2.level === 'up', d2.level);

  // 缓存盘还没定位到（余量未知）时，只报增速，不编造 ETA
  const d3 = T.describe(h, NaN);
  ok('余量未知时不出现「约 —」', !/约 —/.test(d3.text), d3.text);
  ok('余量未知时仍报增速', /\+1\.2 GB\/h/.test(d3.text), d3.text);
}

console.log('\n[8] 百分比与时间格式化');
{
  ok('0.6 GB/h', T.fmtRate(0.6) === '+0.6 GB/h', T.fmtRate(0.6));
  ok('负值用减号', T.fmtRate(-2.4) === '−2.4 GB/h', T.fmtRate(-2.4));
  ok('极小的值显示 0', T.fmtRate(0.001) === '0 GB/h', T.fmtRate(0.001));
  ok('分钟级', T.fmtEta(0.5) === '30 分钟后', T.fmtEta(0.5));
  ok('小时级', T.fmtEta(10) === '10 小时后', T.fmtEta(10));
  ok('天级', T.fmtEta(72) === '3 天后', T.fmtEta(72));
  ok('很久以后', T.fmtEta(24 * 200) === '3 个月以上', T.fmtEta(24 * 200));
  ok('不增长', T.fmtEta(Infinity) === '不再增长', T.fmtEta(Infinity));
}

console.log('\n[9] 窗口裁剪：老数据不能影响当前判断');
{
  const h = [];
  // 前 3 小时猛涨，最近 1 小时完全不动
  for (let m = 0; m <= 180; m += 5) T.push(h, T0 + m * MIN, (1 + 0.5 * m) * GB);
  for (let m = 181; m <= 240; m += 5) T.push(h, T0 + m * MIN, (1 + 0.5 * 180) * GB);

  const all = T.rate(h, 24 * 3600000);
  const recent = T.rate(h, 60 * MIN);
  ok('看全天会算出正增长', all.perHour > 1, all.perHour.toFixed(2));
  ok('看最近 1 小时是零增长', Math.abs(recent.perHour) < 0.01, recent.perHour.toFixed(3));
  ok('默认窗口为 2 小时', T.WINDOW === 2 * 3600000);
}

console.log('\n[10] 历史长度上限');
{
  const h = [];
  for (let m = 0; m < 1000; m++) T.push(h, T0 + m * MIN, m * GB);
  ok('不超过 480 点', h.length === 480, h.length);
  ok('保留的是最新的点', h[h.length - 1].b === 999 * GB, h[h.length - 1].b / GB);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
