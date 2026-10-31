/* ============================================================
 * hostjsx.test.js — 在 Node 里用「假的 AE 对象」执行真实的 ExtendScript
 *
 * 为什么值得写：
 *   ExtendScript 里的属性名打错（比如把 dirty 写成 isDirty）不会报语法错，
 *   只会默默返回 undefined —— 装进 AE 才发现「永远是 -1」，极难排查。
 *   这里把 main.js 里内联的 JSX 和 host.jsx 的函数都取出来真跑一遍。
 * ============================================================ */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mainJs = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
const hostJsx = fs.readFileSync(path.join(ROOT, 'jsx', 'host.jsx'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 面板侧同一个解析器（与 main.js 的 parseKV 保持一致） */
function parseKV(s) {
  const o = {};
  const str = String(s === undefined || s === null ? '' : s).trim();
  if (!str) return null;
  for (const part of str.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    let v = part.slice(eq + 1);
    if (k === 'p' || k === 'v' || k === 'err') { try { v = decodeURIComponent(v); } catch (e) {} }
    else v = Number(v);
    o[k] = v;
  }
  return o;
}

/* ---------- 1. 取出 main.js 里内联的状态读取脚本 ---------- */
const MARK_START = 'var jsx = ';
const MARK_END = "'})()';";
const i0 = mainJs.indexOf(MARK_START);
const i1 = mainJs.indexOf(MARK_END, i0);
if (i0 < 0 || i1 < 0) {
  console.log('  FAIL  未能在 main.js 中定位内联 JSX');
  process.exit(1);
}
const expr = mainJs.slice(i0 + MARK_START.length, i1 + MARK_END.length);
const inlineJsx = eval(expr);

console.log('\n[1] 内联状态脚本（readAE）拿到了什么');
function runState(app) {
  const fn = new Function('app', 'encodeURIComponent', 'return ' + inlineJsx);
  return parseKV(fn(app, encodeURIComponent));
}

const fullApp = {
  version: '24.2.1',
  project: {
    numItems: 12,
    file: { fsName: 'D:\\work\\demo.aep' },
    dirty: true,
    revision: 7,
    renderQueue: { rendering: false }
  }
};
let s = runState(fullApp);
ok('版本号', s.v === '24.2.1', s.v);
ok('有工程 ok=1', s.ok === 1, s.ok);
ok('工程路径', s.p === 'D:\\work\\demo.aep', s.p);
ok('素材项数', s.n === 12, s.n);
ok('dirty 读到 1', s.d === 1, s.d);
ok('revision 读到 7', s.r === 7, s.r);
ok('未在渲染 rq=0', s.rq === 0, s.rq);

const cleanApp = {
  version: '24.2.1',
  project: { numItems: 3, file: { fsName: 'C:\\a.aep' }, dirty: false, revision: 9, renderQueue: { rendering: true } }
};
s = runState(cleanApp);
ok('干净工程 d=0', s.d === 0, s.d);
ok('渲染中 rq=1', s.rq === 1, s.rq);

// AE 17.5 以下没有 dirty 属性 —— 必须降级成 -1，不能当成「干净」
const oldApp = { version: '16.1', project: { numItems: 2, file: { fsName: 'C:\\b.aep' }, revision: 4, renderQueue: {} } };
s = runState(oldApp);
ok('无 dirty 属性时 d=-1', s.d === -1, s.d);
ok('仍能拿到 revision 作为兜底', s.r === 4, s.r);

const untitled = { version: '24.2.1', project: { numItems: 1, file: null, dirty: true, revision: 1, renderQueue: {} } };
s = runState(untitled);
ok('未保存工程路径为空', s.p === '', JSON.stringify(s.p));
ok('未保存工程仍有 dirty', s.d === 1);

s = runState({ version: '24.2.1', project: null });
ok('无工程时 ok=0', s.ok === 0, s.ok);
ok('无工程时 d=-1', s.d === -1, s.d);
ok('无工程时仍拿到版本号', s.v === '24.2.1', s.v);

s = runState({ version: '24.2.1', get project() { throw new Error('boom'); } });
ok('project 抛错时降级', s.ok === 0 && s.d === -1, JSON.stringify(s));

// 中文路径必须能完整往返
const cnApp = { version: '24.2.1', project: { numItems: 1, file: { fsName: 'D:\\项目\\李的工程.aep' }, dirty: true, revision: 2, renderQueue: {} } };
s = runState(cnApp);
ok('中文路径往返无损', s.p === 'D:\\项目\\李的工程.aep', s.p);

/* ---------- 2. host.jsx 的两个函数 ---------- */
console.log('\n[2] host.jsx 的状态函数');
function loadHost(app) {
  const fn = new Function('app', 'encodeURIComponent', hostJsx + '\nreturn { info: sysmon_getInfo, state: sysmon_projState, save: sysmon_save };');
  return fn(app, encodeURIComponent);
}

const h = loadHost(fullApp);
let o = parseKV(h.state());
ok('projState.ok = 1', o.ok === 1, o.ok);
ok('projState.d = 1', o.d === 1, o.d);
ok('projState.r = 7', o.r === 7, o.r);
ok('projState.rq = 0', o.rq === 0, o.rq);

const gi = parseKV(h.info());
ok('getInfo 版本号', gi.v === '24.2.1', gi.v);
ok('getInfo 工程路径', gi.p === 'D:\\work\\demo.aep', gi.p);

console.log('\n[3] host.jsx 的保存函数');
let saveCalls = 0;
const saveApp = {
  version: '24.2.1',
  project: {
    numItems: 5,
    file: { fsName: 'D:\\work\\demo.aep' },
    dirty: true,
    revision: 7,
    renderQueue: { rendering: false },
    save: function () { saveCalls++; this.dirty = false; this.revision = 8; }
  }
};
const hs = loadHost(saveApp);
o = parseKV(hs.save());
ok('调用了一次 save()', saveCalls === 1, saveCalls);
ok('保存成功 ok=1', o.ok === 1, o.ok);
ok('保存后 dirty 变 0', o.d === 0, o.d);
ok('保存后 revision 变 8', o.r === 8, o.r);
ok('返回耗时字段', typeof o.ms === 'number', o.ms);

let untitledSaveCalls = 0;
const untitledApp = {
  version: '24.2.1',
  project: { numItems: 1, file: null, dirty: true, revision: 1, renderQueue: {}, save: function () { untitledSaveCalls++; } }
};
o = parseKV(loadHost(untitledApp).save());
ok('未保存工程不调用 save()', untitledSaveCalls === 0, untitledSaveCalls);
ok('返回 untitled 错误', o.err === 'untitled', o.err);

o = parseKV(loadHost({ version: '24.2.1', project: null }).save());
ok('无工程返回 no-project', o.err === 'no-project', o.err);

const hErr = loadHost({
  version: '24.2.1',
  project: {
    numItems: 1, file: { fsName: 'Z:\\ro.aep' }, dirty: true, revision: 1, renderQueue: {},
    save: function () { throw new Error('disk full'); }
  }
});
o = parseKV(hErr.save());
ok('save 抛错时被捕获', o.ok === 0 && /disk full/.test(o.err), o.err);

console.log('\n[4] 兼容性约束');
const saveFnSrc = hostJsx.slice(hostJsx.indexOf('function sysmon_save'), hostJsx.indexOf('/* CEP 会执行'));
ok('save() 未传 File 参数', /app\.project\.save\(\)/.test(saveFnSrc));
ok('未使用 saveWithDialog', saveFnSrc.indexOf('saveWithDialog') < 0);
// ExtendScript 是 ES3，老版本 AE 没有全局 JSON
ok('host.jsx 不依赖 JSON', !/\bJSON\b/.test(hostJsx.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('内联 JSX 不依赖 JSON', inlineJsx.indexOf('JSON') < 0);
ok('内联 JSX 不使用箭头函数', inlineJsx.indexOf('=>') < 0);
ok('内联 JSX 不使用 let/const', !/\b(let|const)\s/.test(inlineJsx));

/* ---------- 5. sysmon_purge：用假 app 真跑一遍（属性名打错会在这里露馅） ---------- */
{
  const box = new Function('app', 'encodeURIComponent',
    hostJsx + '\nreturn { purge: sysmon_purge };');
  const calls = [];
  const fakeApp = {
    version: '24.2.1',
    findMenuCommandId: function (name) {
      return name === 'Purge>All Memory & Disk Cache' ? 4242 : 0;
    },
    executeCommand: function (id) { calls.push(id); return true; }
  };
  const api = box(fakeApp, encodeURIComponent);
  const r1 = parseKV(api.purge());
  ok('找到清理菜单并执行', r1 && r1.ok === 1 && calls[0] === 4242, JSON.stringify(r1));
  ok('回报菜单 id（不用猜哪个名字命中了）', r1 && r1.id === 4242, r1 && r1.id);
  ok('耗时是数字毫秒', r1 && typeof r1.ms === 'number' && r1.ms >= 0, r1 && r1.ms);

  const bare = { version: '24.2.1' };
  const api2 = box(bare, encodeURIComponent);
  const r2 = parseKV(api2.purge());
  ok('没有清理入口时 ok=0 且带原因', r2 && r2.ok === 0 && String(r2.err).length > 0,
    r2 && r2.err);
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
