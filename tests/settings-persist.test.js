/* settings-persist.test.js — 设置持久化测试（1.7.5）
 *
 * 背景：1.7.4 及以前设置只写 localStorage。CEP 面板的 localStorage 由 CEF profile
 * 管理，进程退出时刷盘时机不由页面控制 —— 完全退出 AE 再打开，设置可能回到默认。
 * 1.7.5 改成「文件为主，localStorage 为兜底」。
 *
 * 这些测试验证的是「换一个进程还能不能读到」—— 所以每个场景都新建一份
 * 假的 fs/localStorage 环境重新跑一遍 loadCfg，而不是原地断言。
 * 只依赖 js/main.js 暴露的 __cfgPersist 测试钩子，不去模拟整个面板 DOM。
 */
const path = require('path');
const fsReal = require('fs');
const osReal = require('os');
const pathReal = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

// —— 取 main.js 暴露的持久化内核 ——
const HOOK = path.join(__dirname, '..', 'js', 'main.js');
const src = fsReal.readFileSync(HOOK, 'utf8');

// main.js 是 IIFE，需要 window/document。用 _no-ae-sim 同类的最小 shim。
function makeEnv(opts) {
  opts = opts || {};
  const store = {};                       // 假 localStorage
  const disk = {};                        // 假文件系统
  const calls = { written: 0, read: 0 };

  const fakeFs = {
    existsSync: p => Object.prototype.hasOwnProperty.call(disk, p),
    readFileSync: p => {
      if (!Object.prototype.hasOwnProperty.call(disk, p)) {
        const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e;
      }
      calls.read++;
      return disk[p];
    },
    writeFileSync: (p, s) => {
      if (opts.writeThrows) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; }
      disk[p] = String(s); calls.written++;
    },
    mkdirSync: () => {},
    appendFileSync: () => {},
    statSync: () => ({ size: 0 }),
  };

  const localStorageShim = {
    getItem: k => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { if (opts.lsThrows) throw new Error('ls full'); store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };

  return { store, disk, calls, fakeFs, localStorageShim };
}

/* 把 main.js 里那段持久化函数抽出来跑 —— 不加载整个面板。
   做法：从源码里截取 cfgFilePath / readCfgFile / writeCfgFile / loadCfg / saveCfg，
   配一个最小作用域执行。这样测的是真实源码，而不是抄一份实现。 */
function extract() {
  const start = src.indexOf('function cfgFilePath()');
  const end = src.indexOf('/* ---------------- 基础工具 ---------------- */');
  if (start < 0 || end < 0 || end < start) throw new Error('找不到持久化代码段，main.js 结构变了');
  return src.slice(start, end);
}

const PERSIST_SRC = extract();

function build(opts) {
  opts = opts || {};
  const env = makeEnv(opts);
  const Settings = require('../js/settings.js');
  // 模拟 CEP：Node 可用
  const scope = {
    hasNode: opts.hasNode !== false,
    fs: opts.hasNode === false ? null : env.fakeFs,
    pathmod: pathReal,
    os: { homedir: () => pathReal.join('C:', 'Users', 'tester') },
    process: { platform: opts.platform || 'win32' },
    localStorage: env.localStorageShim,
    Settings: Settings,
    USR: null,
  };
  // localDataDir 是持久化段之外的依赖，这里按平台给一份等价实现
  scope.localDataDir = function () {
    if (!scope.hasNode) return '';
    const home = scope.os.homedir();
    return scope.process.platform === 'win32'
      ? pathReal.join(home, 'AppData', 'Local', 'AESystemMonitor')
      : (scope.process.platform === 'darwin'
          ? pathReal.join(home, 'Library', 'Logs', 'AESystemMonitor')
          : pathReal.join(home, '.cache', 'AESystemMonitor'));
  };

  const api2 = new Function(
    'hasNode', 'fs', 'pathmod', 'os', 'process', 'localStorage', 'Settings', 'localDataDir', 'CFG_KEY',
    PERSIST_SRC +
    '\nreturn { loadCfg: loadCfg, saveCfg: saveCfg, cfgFilePath: cfgFilePath,' +
    ' getUSR: function(){ return USR; }, setUSR: function(u){ USR = u; } };'
  )(scope.hasNode, scope.fs, scope.pathmod, scope.os, scope.process,
    scope.localStorage, scope.Settings, scope.localDataDir, 'sysmon.cfg');

  return { env, api: api2, Settings, scope };
}

console.log('[1] 默认：没有任何存档时用默认设置');
{
  const { env, api, Settings } = build();
  api.setUSR(null);
  api.loadCfg();
  ok('空环境 -> 默认主题 mint', api.getUSR().ui.theme === 'mint', api.getUSR().ui.theme);
  ok('空环境 -> 默认喝水 45 分', api.getUSR().reminders.water.everyMin === 45);
}

console.log('\n[2] 写入：设置会落到文件，同时留一份 localStorage');
{
  const { env, api, Settings } = build();
  api.loadCfg();
  const u = api.getUSR();
  u.ui.theme = 'black';
  api.setUSR(u);
  api.saveCfg();

  const p = api.cfgFilePath();
  ok('cfgFilePath 非空（Windows 路径）', !!p, p);
  ok('路径含 AESystemMonitor\\settings.json', /AESystemMonitor[\\\/]settings\.json$/.test(p), p);
  ok('文件已写入', !!env.disk[p], Object.keys(env.disk));
  ok('localStorage 也写了一份（兜底）', !!env.store['sysmon.cfg']);
  const fromFile = JSON.parse(env.disk[p]);
  ok('文件里 ui.theme = black', fromFile.ui.theme === 'black', fromFile.ui.theme);
  ok('两通道内容一致',
     env.disk[p] === env.store['sysmon.cfg']);
}

console.log('\n[3] 关键场景：进程退出后重新加载（文件优先）');
{
  // 第一次进程：设为 black
  const a = build();
  a.api.loadCfg();
  const u = a.api.getUSR(); u.ui.theme = 'black'; a.api.setUSR(u); a.api.saveCfg();
  const savedFile = a.env.disk[a.api.cfgFilePath()];

  // 第二次进程：同样的文件，但 localStorage 是「旧的 / 空的」
  // —— 这正是 CEP 退出后丢 localStorage 而文件还在的情形
  const b = build();
  b.env.disk[b.api.cfgFilePath()] = savedFile;   // 带上文件
  b.env.store['sysmon.cfg'] = JSON.stringify(a.Settings.defaults()); // localStorage 是旧值
  b.api.loadCfg();
  ok('重启后从文件读到 black（没被旧 localStorage 覆盖）',
     b.api.getUSR().ui.theme === 'black', b.api.getUSR().ui.theme);
}

console.log('\n[4] localStorage 完全丢失时，文件仍能救回设置');
{
  const a = build();
  a.api.loadCfg();
  const u = a.api.getUSR();
  u.ui.theme = 'azure';
  u.reminders.water.everyMin = 37;
  u.crashGuard.holdMin = 30;
  a.api.setUSR(u); a.api.saveCfg();
  const savedFile = a.env.disk[a.api.cfgFilePath()];

  const b = build();
  b.env.disk[b.api.cfgFilePath()] = savedFile;
  // localStorage 空 —— 模拟 CEF 把 profile 清了/换了
  b.api.loadCfg();
  const got = b.api.getUSR();
  ok('主题保住 azure', got.ui.theme === 'azure', got.ui.theme);
  ok('喝水间隔保住 37', got.reminders.water.everyMin === 37, got.reminders.water.everyMin);
  ok('holdMin 保住 30', got.crashGuard.holdMin === 30, got.crashGuard.holdMin);
}

console.log('\n[5] 老版本升级迁移：只有 localStorage 时搬进文件');
{
  const S = require('../js/settings.js');
  const b = build();
  const legacy = S.defaults(); legacy.ui.theme = 'lotus';
  b.env.store['sysmon.cfg'] = JSON.stringify(legacy);
  // 文件不存在（老用户）
  b.api.loadCfg();
  ok('升级后读到了老设置 lotus', b.api.getUSR().ui.theme === 'lotus', b.api.getUSR().ui.theme);
  const p = b.api.cfgFilePath();
  ok('老设置已迁移写入文件', !!b.env.disk[p]);
  if (b.env.disk[p]) {
    ok('迁移内容主题正确', JSON.parse(b.env.disk[p]).ui.theme === 'lotus');
  }
}

console.log('\n[6] 文件损坏时不崩，回退可用的那一份');
{
  const S = require('../js/settings.js');
  const b = build();
  b.env.disk[b.api.cfgFilePath()] = '{这不是合法 JSON';
  const good = S.defaults(); good.ui.theme = 'mist';
  b.env.store['sysmon.cfg'] = JSON.stringify(good);
  let threw = false;
  try { b.api.loadCfg(); } catch (e) { threw = true; }
  ok('解析坏文件不抛错', !threw);
  ok('退回默认（parse 对坏输入的既定行为）', b.api.getUSR().ui.theme === 'mint', b.api.getUSR().ui.theme);
}

console.log('\n[7] 写盘失败不阻断：localStorage 仍兜住');
{
  const a = build({ writeThrows: true });
  a.api.loadCfg();
  const u = a.api.getUSR(); u.ui.theme = 'pink'; a.api.setUSR(u);
  let threw = false;
  try { a.api.saveCfg(); } catch (e) { threw = true; }
  ok('写文件抛错时 saveCfg 不向外抛', !threw);
  ok('localStorage 仍写成功', !!a.env.store['sysmon.cfg']);
  const back = JSON.parse(a.env.store['sysmon.cfg']);
  ok('兜底里主题是 pink', back.ui.theme === 'pink', back.ui.theme);
}

console.log('\n[8] localStorage 写失败也不崩');
{
  const a = build({ lsThrows: true });
  a.api.loadCfg();
  const u = a.api.getUSR(); u.ui.theme = 'azure'; a.api.setUSR(u);
  let threw = false;
  try { a.api.saveCfg(); } catch (e) { threw = true; }
  ok('localStorage 抛错时 saveCfg 不向外抛', !threw);
  ok('文件仍然写成功（主通道不依赖它）', !!a.env.disk[a.api.cfgFilePath()]);
}

console.log('\n[9] 非 CEP / 无 Node：退回纯 localStorage，行为与改前一致');
{
  const a = build({ hasNode: false });
  ok('cfgFilePath 返回空串（无文件通道）', a.api.cfgFilePath() === '', a.api.cfgFilePath());
  a.api.loadCfg();
  const u = a.api.getUSR(); u.ui.theme = 'black'; a.api.setUSR(u); a.api.saveCfg();
  ok('无 Node 时写进 localStorage', JSON.parse(a.env.store['sysmon.cfg']).ui.theme === 'black');
  ok('无 Node 时不产生文件', Object.keys(a.env.disk).length === 0, Object.keys(a.env.disk));

  const b = build({ hasNode: false });
  b.env.store['sysmon.cfg'] = JSON.stringify((() => { const S = require('../js/settings.js'); const x = S.defaults(); x.ui.theme = 'black'; return x; })());
  b.api.loadCfg();
  ok('无 Node 时能从 localStorage 读回', b.api.getUSR().ui.theme === 'black', b.api.getUSR().ui.theme);
}

console.log('\n[10] 两个通道对齐：文件较新时纠正过期的 localStorage');
{
  const S = require('../js/settings.js');
  const b = build();
  const fresh = S.defaults(); fresh.ui.theme = 'pinkwhite';
  b.env.disk[b.api.cfgFilePath()] = JSON.stringify(fresh);
  const stale = S.defaults(); stale.ui.theme = 'mint';
  b.env.store['sysmon.cfg'] = JSON.stringify(stale);

  b.api.loadCfg();
  ok('读到的是文件里的 pinkwhite', b.api.getUSR().ui.theme === 'pinkwhite', b.api.getUSR().ui.theme);
  ok('localStorage 被纠齐（不再是 mint）',
     JSON.parse(b.env.store['sysmon.cfg']).ui.theme === 'pinkwhite',
     JSON.parse(b.env.store['sysmon.cfg']).ui.theme);
}

console.log('\n' + '='.repeat(56));
console.log(`===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);