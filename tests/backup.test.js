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
  ok('格式 YYYYMMDD-HHmmss-mmm（带毫秒）', /^\d{8}-\d{6}-\d{3}$/.test(s), s);
  ok('能被字典序比较（新 > 旧）', B.stamp(T + 1000) > B.stamp(T), B.stamp(T) + ' < ' + B.stamp(T + 1000));
  ok('同一秒内的两次保存也不同名（1.6.1）',
     B.stamp(T) !== B.stamp(T + 1) && B.stamp(T + 1) > B.stamp(T), B.stamp(T) + ' / ' + B.stamp(T + 1));
  ok('补零（个位数月日时分秒）', B.stamp(Date.UTC(2026, 0, 2, 3, 4, 5)).slice(4, 8) !== '142', B.stamp(Date.UTC(2026, 0, 2, 3, 4, 5)));
  ok('毫秒补三位（5ms → 005）', /-005$/.test(B.stamp(Date.UTC(2026, 9, 25, 9, 40, 5, 5))), B.stamp(Date.UTC(2026, 9, 25, 9, 40, 5, 5)));
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
  const taken = [B.backupName('D:\\x\\工程.aep', T)];
  ok('和已有副本撞名时自动加 -2（1.6.1）',
     /-2\.aep$/.test(B.backupName('D:\\x\\工程.aep', T, taken)), B.backupName('D:\\x\\工程.aep', T, taken));
  const taken2 = taken.concat([B.backupName('D:\\x\\工程.aep', T, taken)]);
  ok('连 -2 也被占时加 -3（1.6.1）',
     /-3\.aep$/.test(B.backupName('D:\\x\\工程.aep', T, taken2)), B.backupName('D:\\x\\工程.aep', T, taken2));
  ok('没撞名时原样返回（1.6.1）', B.backupName('D:\\x\\工程.aep', T, []) === B.backupName('D:\\x\\工程.aep', T));
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

/* ============================================================
 * [8] 逐份取回：按下标取会取错人（1.6.2 的 P0）
 *
 * 面板那一行展开后是**渲染那一刻**的快照。用户看到 3 行，点了第 2 行 ——
 * 但点击发生在之后，这中间文件系统随时可能变：
 *   · 保护保存又落进一份（列表头部多一个，全体下标 +1）
 *   · 轮转删掉最老的（尾部少一个）
 *   · 用户在 AE 里另存，ST.projectPath 换了，整份列表换人
 *
 * 早先按钮带的是下标，点击时再拿它去查一遍**重读**的列表：
 * 同一个下标，在变过位的列表里指向的是**另一份副本**。
 * 用户点的是 14:32，拿回来的可能是 11:05 —— 而界面不会给他任何提示。
 * 这类 bug 在「什么都不变」时永远测不出来，所以这里直接把变化注入进去。
 * ============================================================ */
console.log('\n[8] 逐份取回：认路径，不认下标');
{
  const P = (n, t) => ({ name: n, path: 'D:\\x\\bk\\' + n, size: 1000, mtime: t, old: false });
  // 用户展开时看到的（最新的在最前）
  const shown = [P('c__1430.aep', 300), P('b__1105.aep', 200), P('a__0900.aep', 100)];

  ok('展开时能看到 3 份', B.recent(shown, 3).length === 3);

  // 用户点了第 2 行（b__1105）。此刻重读列表：新的一份 c__1500 落在最前，全体下移。
  const after = [P('d__1500.aep', 400)].concat(shown);

  // 旧写法：拿点击时的下标 1 去查**重读**的列表
  const byIndex = after[1];
  ok('按下标取会取到错的那一份（这就是 P0）',
     byIndex.path !== shown[1].path && byIndex.path === 'D:\\x\\bk\\c__1430.aep',
     '点的是 b__1105.aep，拿回的是 ' + byIndex.name);

  // 新写法：按路径认身份
  const byPath = B.pickByPath(after, shown[1].path);
  ok('按路径取：漂移后仍取回用户点的那一份',
     byPath && byPath.path === shown[1].path, byPath && byPath.name);

  // 反向漂移：轮转把最老的删了，列表变短
  const shrunk = shown.slice(0, 2);
  ok('列表变短也认得出', B.pickByPath(shrunk, shown[1].path).path === shown[1].path);
  ok('被删掉的那份返回 null（明确告知，不静默取错一份）',
     B.pickByPath(shrunk, shown[2].path) === null);

  // 工程切换：整份列表换人
  const other = [P('z__1600.aep', 500)];
  ok('换了工程的列表里找不到旧的 path',
     B.pickByPath(other, shown[1].path) === null);

  // 边界
  ok('空 path 返回 null（不给「恰巧第一份」）', B.pickByPath(shown, '') === null);
  ok('null path 返回 null', B.pickByPath(shown, null) === null);
  ok('空列表安全', B.pickByPath([], shown[0].path) === null);
  ok('列表里的空洞不炸', B.pickByPath([null, undefined, shown[0]], shown[0].path) === shown[0]);
  ok('同一 path 出现两次时返回第一个', B.pickByPath([shown[0], shown[0]], shown[0].path) === shown[0]);

  // 新旧目录同名副本不会互相冒充：path 不同就是不同的人
  const dup = { name: shown[0].name, path: 'E:\\old\\' + shown[0].name, size: 9, mtime: 1, old: true };
  ok('旧目录里的同名副本不冒充新目录那份（path 不同）',
     B.pickByPath([dup, shown[0]], shown[0].path).path === shown[0].path);
}

/* 假 fs：只实现 atomicCopy 用到的那几个方法，用来注入「写一半 / 字节数不符 / rename 失败」。
 * 这几个失败在真机上等于「断电 / 磁盘满 / 权限被拒」，手动测不出来，只能注入。 */
function fakeFs(opt) {
  opt = opt || {};
  const f = {};
  f[opt.src] = { size: opt.srcSize !== undefined ? opt.srcSize : 1000 };
  if (opt.stalePart) f[opt.stalePart] = { size: 7 };
  return {
    files: f,
    existsSync(p) { return p in f; },
    unlinkSync(p) { delete f[p]; },
    copyFileSync(src, part) {
      if (opt.copyThrows) throw new Error(opt.copyThrows);
      f[part] = { size: opt.wroteSize !== undefined ? opt.wroteSize : (f[src] ? f[src].size : 0) };
    },
    statSync(p) {
      if (!(p in f)) throw new Error('ENOENT: ' + p);
      return { size: f[p].size };
    },
    renameSync(from, to) {
      if (opt.renameThrows) throw new Error(opt.renameThrows);
      if (to in f) throw new Error('EEXIST: ' + to);
      f[to] = f[from]; delete f[from];
    }
  };
}
const SRC = '/p/工程.aep', DEST = '/b/工程__20261025-174055-123.aep';

console.log('\n[8] 原子落盘：（1.6.1）先写 .part 再 rename，失败不留残档');
{
  const fs1 = fakeFs({ src: SRC });
  const r1 = B.atomicCopy(fs1, path, SRC, DEST);
  ok('成功时返回 ok', r1.ok === true, r1.err);
  ok('成功时只有最终文件、没有 .part',
     (DEST in fs1.files) && !((DEST + '.part') in fs1.files));

  const fs2 = fakeFs({ src: SRC, wroteSize: 300 });
  const r2 = B.atomicCopy(fs2, path, SRC, DEST);
  ok('字节数不符时 fail 且带说明', r2.ok === false && /大小校验未通过/.test(r2.err || ''), r2.err);
  ok('字节数不符时不留最终文件，也不留 .part',
     !(DEST in fs2.files) && !((DEST + '.part') in fs2.files));

  const fs3 = fakeFs({ src: SRC, copyThrows: '磁盘已满' });
  const r3 = B.atomicCopy(fs3, path, SRC, DEST);
  ok('copy 抛错时 fail 且保留原错误', r3.ok === false && /磁盘已满/.test(r3.err || ''), r3.err);

  const fs4 = fakeFs({ src: SRC, renameThrows: 'EPERM' });
  const r4 = B.atomicCopy(fs4, path, SRC, DEST);
  ok('rename 失败时 fail', r4.ok === false && /EPERM/.test(r4.err || ''), r4.err);
  ok('rename 失败时清掉 .part，不留半成品',
     !(DEST in fs4.files) && !((DEST + '.part') in fs4.files));

  const fs5 = fakeFs({ src: SRC, stalePart: DEST + '.part' });
  const r5 = B.atomicCopy(fs5, pathmod2(), SRC, DEST);
  ok('上次残留的 .part 会被先清掉再重写', r5.ok === true && fs5.files[DEST + '.part'] === undefined);
}

function pathmod2() { return path; }

console.log('\n[9] 最近 n 份（面板只摊开最近 3 份）');
{
  const all = ['c__2026.aep', 'b__2026.aep', 'a__2026.aep'];
  ok('不足 3 份时原样返回', B.recent(all, 3).join(',') === all.join(','));
  ok('超过 3 份只留前 3 份', B.recent(['e', 'd', 'c', 'b', 'a'], 3).join(',') === 'e,d,c');
  ok('空列表与 null 都安全', B.recent([], 3).length === 0 && B.recent(null, 3).length === 0);
  ok('n 非法时至少给 1 份', B.recent(['b', 'a'], 0).length === 1 && B.recent(['b', 'a'], 'x').length === 1);
  ok('不修改原数组', (function () { const src = ['b', 'a']; B.recent(src, 1); return src.length === 2; })());
}


/* ---------- [新] pickRoot（1.6.4）：自定义落点不可用时必须退回默认并报 fellback ---------- */
console.log('\n[新] pickRoot 落点决策');
{
  const yes = () => true, no = () => false;

  let r = B.pickRoot('', 'D:\\默认', yes);
  ok('没填自定义 -> 默认落点、不算回退', r.root === 'D:\\默认' && !r.custom && !r.fellback, JSON.stringify(r));

  r = B.pickRoot('  E:\\备份  ', 'D:\\默认', yes);
  ok('填了且可用 -> 用它，并去掉空白', r.root === 'E:\\备份' && r.custom && !r.fellback, JSON.stringify(r));

  r = B.pickRoot('E:\\备份', 'D:\\默认', no);
  ok('填了但不可用 -> 退回默认并标记 fellback（面板要如实显示）',
     r.root === 'D:\\默认' && !r.custom && r.fellback, JSON.stringify(r));

  r = B.pickRoot('E:\\备份', '', no);
  ok('不可用且没有默认根 -> root 为空（调用方据此不出目录，而不是写到奇怪的相对路径）',
     r.root === '' && r.fellback, JSON.stringify(r));

  r = B.pickRoot(123, 'D:\\默认', no);
  ok('非字符串当成没填（不把数字拼进路径）', r.root === 'D:\\默认' && !r.fellback, JSON.stringify(r));

  r = B.pickRoot('E:\\备份', 'D:\\默认', null);
  ok('没注入可用性判定时按可用处理（纯函数不应自己猜盘在不在）',
     r.root === 'E:\\备份' && r.custom, JSON.stringify(r));
}
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
