/* 回归测试：复现 CEP(--enable-nodejs + --mixed-context) 下的加载条件
 * 关键点：页面上下文里同时存在 window 和 module。
 * 旧写法会只走 CommonJS 分支，导致 window.AECache 为 undefined。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const os = require('os');

const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'ae-cache.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  -> ' + extra : ''}`);
};

/* ---------- 场景 A：CEP 页面（window + module 同时存在） ---------- */
console.log('[A] 模拟 CEP 页面环境（window + module 都在）');
const winA = {};
winA.window = winA;                      // 让 window.window === window
const sandboxA = {
  window: winA,
  module: { exports: {} },               // CEP 注入的 Node module
  exports: {},
  require: require,
  process: process,
  Buffer: Buffer,
  console: console,
};
sandboxA.global = sandboxA;
vm.createContext(sandboxA);
vm.runInContext(code, sandboxA);

ok('window.AECache 已挂载', typeof sandboxA.window.AECache === 'object', typeof sandboxA.window.AECache);
ok('window.AECache.create 可调用', typeof sandboxA.window.AECache?.create === 'function');
ok('module.exports 也挂上了', typeof sandboxA.module.exports?.create === 'function');
ok('两处拿到的是同一个对象', sandboxA.window.AECache === sandboxA.module.exports);

/* 用面板里的真实调用方式跑一遍 */
if (sandboxA.window.AECache) {
  const AE = sandboxA.window.AECache.create({ fs, os, path, Buffer });
  const p = AE.loadPrefs();
  ok('CEP 环境下能读到 AE 2024 偏好', !!p, p ? p.path.split('\\').pop() : 'null');
  if (p) {
    ok('上限 = 149 GB', p.maxSizeGB === 149, p.maxSizeGB);
    ok('路径已解码', !/"[0-9A-F]{4,}"/.test(p.folder), p.folder);
    const dir = AE.resolveCacheDir(p.folder, AE.verShort(p.ver));
    ok('缓存目录命中', /Disk Cache.*\.noindex$/i.test(dir));
  }
}

/* ---------- 场景 B：纯浏览器（只有 window，无 module） ---------- */
console.log('\n[B] 模拟纯浏览器（只有 window）');
const winB = {};
winB.window = winB;
const sandboxB = { window: winB, console: console, Buffer: Buffer };
vm.createContext(sandboxB);
vm.runInContext(code, sandboxB);
ok('window.AECache 已挂载', typeof sandboxB.window.AECache?.create === 'function');

/* ---------- 场景 C：纯 Node require（测试用通道） ---------- */
console.log('\n[C] 纯 Node require');
delete require.cache[require.resolve('../js/ae-cache.js')];
const modC = require('../js/ae-cache.js');
ok('module.exports.create 可用', typeof modC.create === 'function');
ok('不污染全局 AECache', typeof global.AECache === 'undefined');

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
