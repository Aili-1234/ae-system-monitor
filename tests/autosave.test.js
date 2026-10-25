/* ============================================================
 * autosave.test.js — 读取 AE 自带「自动保存」配置（真实偏好文件）
 *   node tests/autosave.test.js
 * 本机无 AE 偏好时自动跳过，不视为失败。
 * ============================================================ */
const fs = require('fs'), os = require('os'), path = require('path');
const AECache = require(path.join(__dirname, '..', 'js', 'ae-cache.js'));
const AE = AECache.create({ fs, os, path, Buffer });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

console.log('\n[1] 定位 *indep-general.txt');
const p = AE.loadAutoSavePrefs();
if (!p) {
  console.log('  SKIP  未找到 indep-general 偏好文件（本机可能未安装 AE）');
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(0);
}

console.log('  文件: ' + p.path);
ok('后缀为 indep-general.txt', /indep-general\.txt$/i.test(p.path));
ok('版本号形如 24.2', /^\d+\.\d+$/.test(p.ver), p.ver);
ok('文件真实存在', fs.existsSync(p.path));

console.log('\n[2] 配置项解析');
ok('自动保存已开启', p.enabled === true, p.enabled);
ok('间隔 = 20 分钟', p.intervalMin === 20, p.intervalMin);
ok('保留 5 个版本', p.maxVers === 5, p.maxVers);
ok('渲染完成后也存', p.afterRender === true, p.afterRender);

console.log('\n[3] 目录中的十六进制用户名被正确还原');
ok('不含十六进制残留', !/\\"[0-9A-F]{6,}\\"/.test(p.folder), p.folder);
ok('解码为「李」', p.folder.indexOf('李') >= 0 || p.folder.indexOf(os.userInfo().username) >= 0, p.folder);
ok('路径以 Documents 结尾段', /Documents[\\\/]Adobe[\\\/]After Effects$/.test(p.folder), p.folder);

console.log('\n[4] 最新自动保存文件');
const latest = AE.latestAutoSave(p.folder);
if (latest === null) {
  // 目录还没被创建 = 从未触发过自动保存，这在本机是真实状态
  ok('目录不存在时返回 null 而不是抛错', true, '目录未创建或为空');
  ok('确实未创建', !fs.existsSync(p.folder), p.folder);
} else {
  ok('返回文件名', typeof latest.name === 'string' && latest.name.length > 0, latest.name);
  ok('是 .aep/.aepx', /\.aepx?$/i.test(latest.name), latest.name);
  ok('时间戳为正数', latest.mtime > 0, new Date(latest.mtime).toLocaleString('zh-CN'));
  ok('体积为正数', latest.size > 0, latest.size);
}

console.log('\n[5] 异常输入不崩');
ok('空目录参数返回 null', AE.latestAutoSave('') === null);
ok('不存在的目录返回 null', AE.latestAutoSave('Z:\\nope\\nope') === null);
ok('传入 undefined 返回 null', AE.latestAutoSave(undefined) === null);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
