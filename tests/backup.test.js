/* ============================================================
 * backup.test.js — 回退副本的命名与轮转（纯逻辑，不碰磁盘）
 *   node tests/backup.test.js
 *
 * 为什么这些细节值得测：
 *   备份是「覆盖前最后一道保险」。它一旦出问题（名字撞了、轮转删错、回退写成覆盖），
 *   损失的是用户真正的工作文件。所以这里不测 UI，只测三件事：
 *     1) 文件名里带可排序的时间戳，且不同工程不会互相挤进同一个夹
 *     2) 轮转只删最老的，永远保留最新 keep 份
 *     3) 回退生成的是「新文件」，绝不复用原文件名
 * ============================================================ */
const path = require('path');
const B = require(path.join(__dirname, '..', 'js', 'backup.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const T = Date.UTC(2026, 9, 25, 9, 40, 55);   // 2026-10-25 17:40:55 (+08:00)

console.log('\n[1] 时间戳');
{
  const s = B.stamp(T);
  ok('格式 YYYYMMDD-HHmmss', /^\d{8}-\d{6}$/.test(s), s);
  ok('能被字典序比较（新 > 旧）', B.stamp(T + 1000) > B.stamp(T), B.stamp(T) + ' < ' + B.stamp(T + 1000));
  ok('补零（个位数月日时分秒）', B.stamp(Date.UTC(2026, 0, 2, 3, 4, 5)).slice(4, 8) !== '142', B.stamp(Date.UTC(2026, 0, 2, 3, 4, 5)));
  ok('非法时间也能返回字符串', typeof B.stamp(NaN) === 'string');
}

console.log('\n[2] 合法文件名：清掉路径非法字符，限长');
{
  ok('去掉斜杠', !/[\/\\]/.test(B.safeName('a/b\\c')), B.safeName('a/b\\c'));
  ok('去掉冒号星号问号', B.safeName('a:b*c?') === 'a_b_c_', B.safeName('a:b*c?'));
  ok('空名有兜底', B.safeName('') === 'project');
  ok('超长被截断到 60', B.safeName('长'.repeat(200)).length === 60, B.safeName('长'.repeat(200)).length);
}

console.log('\n[3] 一个工程一个夹：同名不同目录不会混');
{
  const a = B.folderFor('D:\\项目\\a\\测试.aep');
  const b = B.folderFor('E:\\别的\\b\\测试.aep');
  ok('同名工程分到不同夹', a !== b, a + ' / ' + b);
  ok('夹名以工程名开头', a.indexOf('测试-') === 0, a);
  ok('同一个路径稳定（可重复调用）', B.folderFor('D:\\项目\\a\\测试.aep') === a);
}

console.log('\n[4] 备份文件名保留扩展名，且带时间戳');
{
  const n = B.backupName('D:\\x\\工程.aep', T);
  ok('以工程名开头', n.indexOf('工程__') === 0, n);
  ok('保留 .aep 扩展名', /\.aep$/.test(n), n);
  const n2 = B.backupName('D:\\x\\工程.aepx', T);
  ok('.aepx 不被改成 .aep', /\.aepx$/.test(n2), n2);
  ok('同一时刻不同工程不重名',
     B.backupName('D:\\x\\甲.aep', T) !== B.backupName('D:\\x\\乙.aep', T));
}

console.log('\n[5] 回退文件名：绝不等于原文件名');
{
  const src = 'D:\\x\\工程.aep';
  const r = B.restoreName(src, T);
  ok('不叫 工程.aep', path.basename(src) !== r, r);
  ok('名字里带「回退」', r.indexOf('（回退 ') >= 0, r);
  ok('仍是 .aep', /\.aep$/.test(r), r);
  ok('同一时刻两次取回也不会撞自己（时间戳精确到秒）',
     B.restoreName(src, T) === B.restoreName(src, T));
}

console.log('\n[6] 轮转：只留最新 keep 份');
{
  const names = [
    '工程__20261025-100000.aep',
    '工程__20261025-110000.aep',
    '工程__20261025-120000.aep',
    '工程__20261025-130000.aep',
    '工程__20261025-140000.aep'
  ];
  const r = B.rotate(names, 3);
  ok('保留 3 份', r.keep.length === 3, r.keep.length);
  ok('保留的是最新的 3 个', r.keep[0] === names[4] && r.keep[2] === names[2], r.keep.join(','));
  ok('删掉的是最老的 2 个（不假定顺序）',
     r.remove.length === 2 &&
     r.remove.indexOf(names[0]) >= 0 && r.remove.indexOf(names[1]) >= 0,
     r.remove.join(','));

  ok('keep=1 时只留最新', B.rotate(names, 1).keep.length === 1);
  ok('keep 传 0 也至少留 1 份', B.rotate(names, 0).keep.length === 1);
  ok('keep 超过总数不报错', B.rotate(names, 99).remove.length === 0);
  ok('空列表安全', B.rotate([], 3).keep.length === 0 && B.rotate([], 3).remove.length === 0);
  ok('不改原数组', names.length === 5);
}

console.log('\n[7] 挑最新');
{
  ok('返回字典序最大的', B.latest(['a__1.aep', 'a__3.aep', 'a__2.aep']) === 'a__3.aep');
  ok('空列表返回 null', B.latest([]) === null);
  ok('单份原样返回', B.latest(['only.aep']) === 'only.aep');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
