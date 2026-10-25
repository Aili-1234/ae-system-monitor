/* ============================================================
 * autosave.test.js — 读取 AE 自带「自动保存」配置
 *   node tests/autosave.test.js
 *
 * 用 tests/_fixture.js 造一份假 AE 偏好，不再依赖本机是否装了 AE：
 * 换机器、换 Node 版本、在 CI 上跑，结果都一致。
 * ============================================================ */
const fs = require('fs'), path = require('path');
const AECache = require(path.join(__dirname, '..', 'js', 'ae-cache.js'));
const { makeFixture, CN_USER } = require('./_fixture.js');

const fx = makeFixture();
const AE = AECache.create({ fs, os: fx.osStub, path, Buffer });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

console.log('\n[1] 定位 *indep-general.txt');
const p = AE.loadAutoSavePrefs();
ok('能读到偏好', !!p, p ? p.path.split(/[\\/]/).pop() : 'null');
if (!p) {
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  fx.cleanup();
  process.exit(1);
}

ok('后缀为 indep-general.txt', /indep-general\.txt$/i.test(p.path));
ok('版本号形如 24.2', /^\d+\.\d+$/.test(p.ver), p.ver);
ok('文件真实存在', fs.existsSync(p.path));

console.log('\n[2] 配置项解析');
ok('自动保存已开启', p.enabled === true, p.enabled);
ok('间隔 = 20 分钟', p.intervalMin === 20, p.intervalMin);
ok('保留 5 个版本', p.maxVers === 5, p.maxVers);
ok('渲染完成后不存', p.afterRender === false, p.afterRender);

console.log('\n[3] 目录中的十六进制用户名被正确还原');
ok('不含十六进制残留', !/"[0-9A-F]{6,}"/.test(p.folder), p.folder);
ok('解码为「李」', p.folder.indexOf(CN_USER) >= 0, p.folder);
ok('路径以 Auto-Save 结尾', /Auto-Save$/.test(p.folder), p.folder);
ok('与 fixture 目录一致',
   path.normalize(p.folder) === path.normalize(fx.autoSaveFolder));

console.log('\n[4] 最新自动保存文件');
const latest = AE.latestAutoSave(p.folder);
ok('返回文件名',
   !!latest && typeof latest.name === 'string' && latest.name.length > 0,
   latest && latest.name);
ok('是 .aep/.aepx', !!latest && /\.aepx?$/i.test(latest.name), latest && latest.name);
ok('时间戳为正数', !!latest && latest.mtime > 0,
   latest && new Date(latest.mtime).toLocaleString('zh-CN'));
ok('体积为正数', !!latest && latest.size > 0, latest && latest.size);

console.log('\n[5] 异常输入不崩');
ok('空目录参数返回 null', AE.latestAutoSave('') === null);
ok('不存在的目录返回 null', AE.latestAutoSave('Z:\\nope\\nope') === null);
ok('传入 undefined 返回 null', AE.latestAutoSave(undefined) === null);

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
fx.cleanup();
process.exit(fail ? 1 : 0);
