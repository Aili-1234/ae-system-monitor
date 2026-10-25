/* ============================================================
 * prefs-version.test.js — 偏好文件必须与「运行中的 AE 版本」对齐
 *   node tests/prefs-version.test.js
 *
 * 为什么这件事必须测：
 *   本机 AE 23（上限 115 GB）与 24（上限 149 GB）并存。
 *   若永远取最高版本，开 2023 时 panel 会用 24 的配额算 fillPct 与 marginGB，
 *   而错的方向是「填充率偏低、余量偏高」—— 面板看起来比实际更安全。
 *   这类错不会报错、不会崩溃，只会让人放心地踩坑。
 *
 * 本测试用临时目录造出「两个版本都有偏好」的现场，不依赖本机装没装 AE。
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AECache = require(path.join(ROOT, 'js', 'ae-cache.js'));
const AE = AECache.create({ fs, os, path, Buffer });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* ---- 造一个假的偏好根目录 ---- */
function prefsText(quota, buf, folder) {
  return [
    '["Disk Cache Controls"]',
    '\t"Enabled 2" = "1"',
    '\t"Folder 7" = "' + folder + '"',
    '\t"Max Size 3" = "' + quota + '"',
    '',
    '["Additional Disk Cache Controls"]',
    '\t"Minimum Volume Free Space (Gigabytes)" = "' + buf + '"',
    ''
  ].join('\n');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-prefs-'));
const PREFS = path.join(TMP, 'prefs');
fs.mkdirSync(path.join(PREFS, '23.0'), { recursive: true });
fs.mkdirSync(path.join(PREFS, '24.2'), { recursive: true });
fs.writeFileSync(path.join(PREFS, '23.0', 'Adobe After Effects 23.0 设置.txt'),
  prefsText('115', '10', 'C:\\Temp\\AE'), 'utf8');
fs.writeFileSync(path.join(PREFS, '24.2', 'Adobe After Effects 24.2 设置.txt'),
  prefsText('149', '20', 'D:\\Cache'), 'utf8');

console.log('\n[1] 版本号归一化（24.2.1 → 24.2）');
ok('verShort(24.2.1)', AE.verShort('24.2.1') === '24.2', AE.verShort('24.2.1'));
ok('verShort(24)', AE.verShort('24') === '24');
ok('verShort(空)', AE.verShort('') === '');

console.log('\n[2] 精确匹配：各读各的，不串台');
const p24 = AE.loadPrefs('24.2.1', { root: PREFS });
const p23 = AE.loadPrefs('23.0.1', { root: PREFS });
ok('24.2 存在', !!p24);
ok('运行 24.2.1 → 读 24.2', p24 && p24.ver === '24.2', p24 && p24.ver);
ok('运行 24.2.1 → 配额 149', p24 && p24.maxSizeGB === 149, p24 && p24.maxSizeGB);
ok('运行 24.2.1 → 标记为精确匹配', p24 && p24.verMatched === true);
ok('运行 23.0.1 → 读 23.0', p23 && p23.ver === '23.0', p23 && p23.ver);
ok('运行 23.0.1 → 配额 115（不是 149）', p23 && p23.maxSizeGB === 115, p23 && p23.maxSizeGB);
ok('运行 23.0.1 → 标记为精确匹配', p23 && p23.verMatched === true);
ok('缓冲也各取各的（24=20 / 23=10）',
   p24.bufferGB === 20 && p23.bufferGB === 10, p24.bufferGB + ' / ' + p23.bufferGB);
ok('缓存盘路径各取各的（D: / C:）',
   p24.folder === 'D:\\Cache' && p23.folder === 'C:\\Temp\\AE', p24.folder + ' / ' + p23.folder);

console.log('\n[3] 精确目录没有偏好文件 → 回退但不静默');
fs.unlinkSync(path.join(PREFS, '23.0', 'Adobe After Effects 23.0 设置.txt'));
const p23b = AE.loadPrefs('23.0.1', { root: PREFS });
ok('回退后仍能读到值', !!p23b);
ok('落到 24.2', p23b && p23b.ver === '24.2', p23b && p23b.ver);
ok('verMatched = false（界面要据此警告）', p23b && p23b.verMatched === false);
ok('runVer 记为 23.0（提示文案要用）', p23b && p23b.runVer === '23.0', p23b && p23b.runVer);

console.log('\n[4] 运行更高版本但没有它的目录 → 退到不高于它的最高版本');
const p25 = AE.loadPrefs('25.2.0', { root: PREFS });
ok('25.2 → 24.2', p25 && p25.ver === '24.2', p25 && p25.ver);
ok('标记不匹配', p25 && p25.verMatched === false);

console.log('\n[5] 运行更低版本且它和它以下都没有 → 才退到全局最高');
const p22 = AE.loadPrefs('22.0', { root: PREFS });
ok('22.0 → 24.2（全局最高）', p22 && p22.ver === '24.2', p22 && p22.ver);
ok('标记不匹配', p22 && p22.verMatched === false);

console.log('\n[6] 拿不到 app.version（首帧没问到 AE）');
const pUnknown = AE.loadPrefs('', { root: PREFS });
ok('仍能读到值', !!pUnknown);
ok('取全局最高 24.2', pUnknown && pUnknown.ver === '24.2', pUnknown && pUnknown.ver);
ok('verMatched = null（不知道，所以不报警）', pUnknown && pUnknown.verMatched === null);
const pNoArg = AE.loadPrefs();
ok('无参调用不抛错（向后兼容）', pNoArg === null || typeof pNoArg === 'object');

console.log('\n[7] 一个版本都没有 → 返回 null，不编造');
const EMPTY = path.join(TMP, 'empty');
fs.mkdirSync(EMPTY, { recursive: true });
ok('空目录返回 null', AE.loadPrefs('24.2', { root: EMPTY }) === null);

console.log('\n[8] 缓存目录定位：strict 不跨版本兜底');
const host = os.hostname();
const base = path.join(TMP, 'cachebase');
function mkCache(ver) {
  const d = path.join(base, 'Adobe', 'After Effects', ver, 'Disk Cache - ' + host + '.noindex');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'a.aecache'), 'x');
  return d;
}
const dir24 = mkCache('24.2');
const dir23 = mkCache('23.0');
// 让 23.0 的目录更新，模拟「较新改动」——旧逻辑的深度兜底会挑它
const old = new Date(Date.now() - 86400000);
fs.utimesSync(dir24, old, old);

ok('strict 精确命中 24.2', AE.resolveCacheDir(base, '24.2', { strict: true }) === dir24);
ok('strict 精确命中 23.0', AE.resolveCacheDir(base, '23.0', { strict: true }) === dir23);
ok('strict 对不存在的版本返回空（不跨版本猜）',
   AE.resolveCacheDir(base, '22.0', { strict: true }) === '');
ok('非 strict 才允许深度兜底', AE.resolveCacheDir(base, '22.0') !== '');
ok('深度兜底会挑最近改动的目录（所以不能给 strict 用）',
   AE.resolveCacheDir(base, '22.0') === dir23);

console.log('\n[9] 两个版本的缓存目录都要能被枚举出来');
const others = AE.otherVersionCacheDirs(base, dir23);
ok('排除当前目录', others.indexOf(dir23) < 0, others.length + ' 个');
ok('包含另一个版本', others.indexOf(dir24) >= 0);

/* ---- 清理 ---- */
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
