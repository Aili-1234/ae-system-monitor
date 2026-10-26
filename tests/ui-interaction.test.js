/* ui-interaction.test.js — 提示框交互与首屏视图的行为测试（1.6.0）
 *
 * 为什么要有这个文件：
 *   1.5.0 引入了带动作按钮的提示框（保护保存成功后可以「取回上一版」），
 *   但 CSS 里 .toast 的 pointer-events:none 从来没在 .show 时恢复回去，
 *   结果按钮渲染得出来、却永远按不动。
 *
 *   这类 bug 光靠「读代码觉得没问题」发现不了 —— 必须真的点一下。
 *   本文件用纯 Node 造一个最小 DOM（零第三方依赖），把 toast 的
 *   真实行为跑一遍。
 *
 * 覆盖：
 *   A. 提示框落在面板内的容器里，不是 body
 *   B. 动作按钮真的能点，点了会执行回调并消失
 *   C. pointer-events 在 show 之后恢复为 auto
 *   D. 没有动作按钮的提示框，点空白也会消失
 *   E. 同屏最多留 3 条
 *   F. 首屏视图：compact / full / remember 三种模式的首屏状态
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

/* ---------------- 最小假 DOM ----------------
 * 只实现 toast 用到的那几个 API：createElement / appendChild / removeChild /
 * classList / textContent / onclick / children / parentNode。
 * 重点是 classList —— pointer-events 的 bug 就藏在那里。 */
function makeEl(tag) {
  const el = {
    tagName: tag,
    _classes: [],
    _text: '',
    children: [],
    parentNode: null,
    style: {},
    hidden: false,
    onclick: null,
    classList: {
      add(c) { if (el._classes.indexOf(c) < 0) el._classes.push(c); },
      remove(c) { const i = el._classes.indexOf(c); if (i >= 0) el._classes.splice(i, 1); },
      contains(c) { return el._classes.indexOf(c) >= 0; },
      toggle(c, on) { if (on === undefined) { el.classList.contains(c) ? el.classList.remove(c) : el.classList.add(c); } else if (on) el.classList.add(c); else el.classList.remove(c); }
    },
    get className() { return el._classes.join(' '); },
    set className(v) { el._classes = String(v).split(/\s+/).filter(Boolean); },
    get textContent() { return el._text; },
    set textContent(v) { el._text = v; },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    setAttribute() {},
    getAttribute() { return null; }
  };
  return el;
}

const doc = makeEl('body');
doc.createElement = tag => makeEl(tag);
doc.getElementById = id => (id === 'toastHost' ? doc.toastHost : null);
doc.toastHost = makeEl('div');
doc.toastHost.id = 'toastHost';
doc.body = doc;

global.document = doc;

/* 真实时序：提示框是「先淡出、再移除」。
   setTimeout 被重写成「立即执行」会把两段合并，测试就看不出区别了。
   这里改成记录回调、由测试自己决定何时执行。 */
let timers = [];
global.requestAnimationFrame = fn => fn();
global.setTimeout = (fn, ms) => { timers.push({ fn: fn, ms: ms || 0 }); return timers.length; };
global.clearTimeout = id => { if (timers[id - 1]) timers[id - 1].fn = null; };

/* 把「所有待执行的定时器」立刻跑一遍（模拟时间推进） */
function flushTimers() {
  const pending = timers.splice(0, timers.length);
  pending.forEach(t => { if (t.fn) t.fn(); });
}

/* ---------------- 从 main.js 里抠出 toast 实现 ----------------
 * main.js 是一个 IIFE，toast 是内部函数，不能直接 require。
 * 这里用源码抽取：找到 function toast(...) 的源码体，
 * 放进一个函数里 eval，拿到一个可以独立调用的 toast。
 * 这样做的好处是：测的就是真正上线的那段代码，不是复制一份。 */
function extractToast(src) {
  const start = src.indexOf('function toast(msg, action)');
  if (start < 0) return null;
  // 找到函数体的结束：逐字符配平大括号
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return null;
  const body = src.slice(start, end + 1);
  // eslint-disable-next-line no-new-func
  const factory = new Function('document', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', '$',
    'return (' + body.replace(/^function toast/, 'function') + ')');
  const $ = id => doc.getElementById(id);
  return factory(doc, global.requestAnimationFrame, global.setTimeout, global.clearTimeout, $);
}

const mainJs = read('js/main.js');
const toast = extractToast(mainJs);
const css = read('css/style.css');

console.log('[1] 能从 main.js 里抠出真实的 toast 实现');
ok('main.js 里有 function toast', !!toast);
ok('抠出来的实现不是 undefined', typeof toast === 'function');

if (typeof toast === 'function') {
  console.log('\n[2] 提示框落在面板内的容器里');
  doc.toastHost.children.length = 0;
  toast('测试提示');
  ok('提示框挂到了 #toastHost', doc.toastHost.children.length === 1,
     'toastHost.children=' + doc.toastHost.children.length);
  ok('提示框不在 body 上', doc.children.length === 0);
  const t0 = doc.toastHost.children[0];
  ok('提示框有 toast 类名', t0.className.indexOf('toast') >= 0, t0.className);
  ok('show 状态已加上', t0.classList.contains('show'));
  ok('消息文本正确',
     t0.children[0] && t0.children[0].textContent === '测试提示');
  ok('消息元素带 toast-msg 类（与按钮分开，按钮不被挤没）',
     t0.children[0] && t0.children[0].className.indexOf('toast-msg') >= 0);

  console.log('\n[3] 动作按钮真的能点（1.5.0 的真 bug）');
  doc.toastHost.children.length = 0;
  let ran = 0;
  const t1 = toast('保存成功', { label: '取回上一版', run: function () { ran++; } });
  const btn = t1.children[1];
  ok('渲染出了按钮', !!btn, btn && btn.className);
  ok('按钮类名是 toast-action', btn && btn.className.indexOf('toast-action') >= 0);
  ok('按钮文字是动作标签', btn && btn.textContent === '取回上一版');
  ok('按钮绑了 onclick', typeof btn.onclick === 'function');
  btn.onclick({ stopPropagation: function () {} });
  ok('点一下回调被执行了', ran === 1, 'ran=' + ran);
  ok('点完先淡出（show 移除）', !t1.classList.contains('show'));
  flushTimers();                      // 时间推进 → 淡出结束，真正移除
  ok('淡出结束后提示框被移除', doc.toastHost.children.indexOf(t1) < 0);

  console.log('\n[4] 没有动作按钮的提示框，点空白也会消失');
  doc.toastHost.children.length = 0;
  const t2 = toast('纯提示，无按钮');
  t2.onclick();
  ok('空白点击触发关闭（先淡出）', !t2.classList.contains('show'));
  flushTimers();
  ok('淡出结束后提示框被移除', doc.toastHost.children.indexOf(t2) < 0);

  console.log('\n[5] 同屏最多留 3 条');
  doc.toastHost.children.length = 0;
  for (let i = 0; i < 6; i++) toast('第 ' + i + ' 条');
  ok('只留了 3 条', doc.toastHost.children.length === 3,
     '剩 ' + doc.toastHost.children.length + ' 条');
  ok('留的是最新的三条',
     doc.toastHost.children[0].children[0].textContent === '第 3 条',
     doc.toastHost.children[0].children[0].textContent);
}

console.log('\n[6] CSS：pointer-events 必须能恢复（静态侧）');
ok('.toast 默认 pointer-events:none',
   /\.toast\s*\{[^}]*pointer-events:\s*none/.test(css));
ok('.toast.show 里有 pointer-events:auto',
   /\.toast\.show\s*\{[^}]*pointer-events:\s*auto/.test(css));
ok('.toast 没有用 position:fixed（否则会溢出面板）',
   !/\.toast\s*\{[^}]*position:\s*fixed/.test(css));
ok('存在 .bottom-stack 容器',
   /\.bottom-stack\s*\{/.test(css));
ok('.bottom-stack 左右贴边（宽度 = 面板宽）',
   /\.bottom-stack\s*\{[^}]*left:\s*0[^}]*right:\s*0/.test(css));

console.log('\n[7] 首屏视图：三种模式的首屏状态');
const settings = require('../js/settings.js');
const S = settings;

// 复刻 main.js 里 initialCardState 的逻辑（同一个语义，独立实现以免自证）
function initialCardState(usr) {
  const mode = (usr && usr.uiDefault) ? usr.uiDefault : 'compact';
  if (mode === 'full') return { cache: true, mem: true, disk: true, guard: true };
  if (mode === 'compact') return { cache: false, mem: false, disk: false, guard: false };
  const u = (usr && usr.ui) ? usr.ui : {};
  return { cache: !!u.cache, mem: !!u.mem, disk: !!u.disk, guard: !!u.guard };
}

const compact = initialCardState(S.normalize({ uiDefault: 'compact' }));
ok('compact：四项全收起',
   !compact.cache && !compact.mem && !compact.disk && !compact.guard);
const full = initialCardState(S.normalize({ uiDefault: 'full' }));
ok('full：四项全展开',
   full.cache && full.mem && full.disk && full.guard);
const remember = initialCardState(S.normalize({
  uiDefault: 'remember',
  ui: { cache: true, mem: false, disk: true, guard: false }
}));
ok('remember：沿用上次的状态',
   remember.cache === true && remember.mem === false &&
   remember.disk === true && remember.guard === false);
const rememberAll = initialCardState(S.normalize({
  uiDefault: 'remember',
  ui: { cache: true, mem: true, disk: true, guard: true }
}));
ok('remember：上次全展开就全展开',
   rememberAll.cache && rememberAll.mem && rememberAll.disk && rememberAll.guard);

console.log('\n[8] uiDefault 不会被 normalize 悄悄丢掉');
ok('normalize 保留 uiDefault=full', S.normalize({ uiDefault: 'full' }).uiDefault === 'full');
const round = S.parse(S.stringify(S.normalize({ uiDefault: 'remember' })));
ok('序列化往返后仍是 remember', round.uiDefault === 'remember');
ok('脏值退回 compact', S.normalize({ uiDefault: '???' }).uiDefault === 'compact');

console.log('\n[9] 极简（小窗）模式下按钮仍在显示框内');
ok('小窗下提示框按钮占满宽度（横向不溢出）',
   /body\.compact \.toast-action\s*\{[^}]*width:\s*100%/.test(css));
ok('小窗下提示框改竖排（文字与按钮分行）',
   /body\.compact \.toast\s*\{[^}]*flex-direction:\s*column/.test(css));
ok('小窗下提醒按钮横排占满',
   /body\.compact \.rm-act button\s*\{[^}]*flex:\s*1 1 auto/.test(css));
ok('小窗下提醒条改两行网格并贴底（提示框叠在上方）',
   /body\.compact \.remind\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:\s*"ico txt"\s*"act act"/.test(css) &&
   /body\.compact \.bottom-stack\s*\{[^}]*flex-direction:\s*column-reverse/.test(css));
ok('两种模式的长消息都限高（不挤掉按钮；1.7.0 max() → calc + 146px 断点）',
   /body\.compact \.rm-txt span\s*\{[^}]*max-height/.test(css) &&
   /body:not\(\.compact\) \.rm-txt span\s*\{[^}]*max-height:\s*calc\(100vh - 110px\)/.test(css) &&
   /@media \(max-height: 146px\)\s*\{[^}]*body:not\(\.compact\) \.rm-txt span\s*\{[^}]*max-height:\s*3\.6em/.test(css));
ok('展开态正文自己滚，按钮仍在视口内（两种模式矮面板都反过来贴底）',
   /body\.compact \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*calc\(100vh - 79px\)[^}]*overflow-y:\s*auto/.test(css) &&
   /body:not\(\.compact\) \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*none/.test(css) &&
   /@media \(max-height: 240px\)\s*\{[^}]*body:not\(\.compact\) \.bottom-stack\s*\{[^}]*flex-direction:\s*column-reverse/.test(css));

console.log('\n[10] 极简模式的消息切换');
{
  const R = require('../js/reminder.js');
  const item = R.create({ now: () => 0 });
  const c = S.defaults();
  c.reminders.water.on = true;
  c.reminders.stand.on = false;
  c.reminders.eyes.on = false;
  c.reminders.mem.on = false;
  const eng = R.create({ now: () => 0 });
  // 把时钟推进到 46 分钟，触发喝水
  let t = 0;
  const eng2 = R.create({ now: () => t });
  t = 46 * 60000;
  const fired = eng2.tick(c, {});
  ok('触发了喝水提醒', fired.length === 1 && fired[0].id === 'water', JSON.stringify(fired.map(f => f.id)));
  ok('有短消息', fired[0].shortMsg && fired[0].shortMsg.length > 0, fired[0].shortMsg);
  ok('短消息明显更短', fired[0].shortMsg.length < fired[0].msg.length,
     fired[0].shortMsg.length + ' < ' + fired[0].msg.length);
  ok('完整消息保留（能点开看）', fired[0].msg.length > fired[0].shortMsg.length);
}

/* ---------------- 刷新闸门不许被异常钉死（P0，2026-10-26）----------------
 * 起因：面板能在真机 AE + 真 CEP 上被**一次异常永久卡死**。
 *   实测（注入实验，连点 ⟳ 三次）：只有第一拍越过 `if (ST.busy) return`，
 *   后两拍全被挡在闸门外（3 次点击只过 1 次），静置 8 秒也不恢复，
 *   只有重载面板才救得回来。
 *   根因：`ST.busy = true` 之后只有 Promise.all 链上挂了 .catch；
 *   同步区（renderMem / drawSpark / renderDisks / updateDisks …）与
 *   `readAE` 的回调体**都不在任何 catch 里** —— 任何一处抛出，busy 永久为 true。
 *
 * 测法沿用本文件既有套路：**从 main.js 抠出真实的三段实现**
 * （refreshFail / guardRefresh / refresh），喂桩依赖后真跑。
 * 同步区抛异常时整个过程是纯同步的，不必等 Promise。
 * 尺子 = 「第几次调用真的越过了闸门」：
 *   破损代码 1（第 1 次越过，异常把 busy 钉死，后两次在闸门就被挡）
 *   修复代码 3
 */
console.log('\n[11] 刷新闸门不被异常钉死（P0）');

function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return end < 0 ? null : src.slice(start, end + 1);
}

const FN_DEPS = ['ST', 'CFG', 'AE', '$', 'readMem', 'updateDisks', 'updateCommit', 'renderMem',
  'drawSpark', 'renderDisks', 'readAE', 'toast', 'renderRenderBadge', 'startTimer',
  'deriveCachePath', 'computeMetrics', 'renderCache', 'scanCache', 'scanMedia',
  'scanOtherVersions', 'sampleCache', 'evaluateGuard', 'renderAll', 'console'];

function buildRefresh(over) {
  const parts = ['refreshFail', 'guardRefresh', 'refresh']
    .map(n => extractFn(mainJs, 'function ' + n + '('));
  if (parts.some(p => !p)) return null;
  const stub = () => {};
  const base = {
    ST: { busy: false, interval: 0, mem: null, hist: [], proj: {}, cache: {},
          prefs: null, prefsFor: '', autoSave: null, crashAt: 0, prevRq: 0,
          renderMuted: 0, lastAutoSaved: null, lastAutoSavedAt: 0 },
    CFG: { histMax: 60 },
    AE: null,                 // 所有 AE 调用都写在 `AE &&` 后面，桩不必实现
    $: () => ({ classList: { remove: stub, add: stub }, style: {}, textContent: '' }),
    readMem: () => null, updateDisks: stub, updateCommit: stub, renderMem: stub,
    drawSpark: stub, renderDisks: stub, readAE: stub, toast: stub,
    renderRenderBadge: stub, startTimer: stub, deriveCachePath: stub,
    computeMetrics: stub, renderCache: stub,
    scanCache: () => Promise.resolve(), scanMedia: () => Promise.resolve(),
    scanOtherVersions: () => Promise.resolve(),
    sampleCache: stub, evaluateGuard: stub, renderAll: stub,
    console: { error: stub }
  };
  const cfg = Object.assign(base, over || {});
  const factory = new Function(...FN_DEPS, parts.join('\n') + '\nreturn refresh;');
  return factory(...FN_DEPS.map(k => cfg[k]));
}

/* 点 ⟳ 三次，返回「异常逃出 refresh 的次数」；hits 由抛异常的桩自己数。 */
function gateRig(over, label) {
  const hits = { n: 0 };
  const boom = function () { hits.n++; throw new Error('BOOM'); };
  const ov = Object.assign({}, over);
  if (ov.syncBoom) ov.renderMem = boom;
  if (ov.cbBoom) { ov.readAE = fn => fn({}); ov.renderCache = boom; }
  const run = buildRefresh(ov);
  if (typeof run !== 'function') {
    ok(label + '：能抠出 refreshFail / guardRefresh / refresh', false, 'main.js 里缺其中之一');
    ok(label + '：3 次点击都越过闸门', false, '--');
    return;
  }
  let escaped = 0;
  for (let i = 0; i < 3; i++) { try { run(); } catch (e) { escaped++; } }
  ok(label + '：3 次点击都越过闸门（异常不许把 busy 钉死）',
     hits.n === 3, '越过 ' + hits.n + ' 次 / 3');
  ok(label + '：异常不再逃出 refresh（被兜住）', escaped === 0, escaped + ' 次逃逸');
}

ok('main.js 有 refreshFail（异常复位 busy 的唯一入口）',
   /function refreshFail/.test(mainJs));
ok('readAE 的回调体被 guardRefresh 包住（异步回调里的异常也抓得住）',
   /readAE\(guardRefresh\(function/.test(mainJs));
gateRig({ syncBoom: true }, '同步区抛异常');
gateRig({ cbBoom: true }, '回调体抛异常');


/* ---------------- [12] 刷新链异常后 busy 必须复位（1.6.3 审计的 P0） ----------------
 * 症状：refresh() 的 ST.busy 门只在 Promise.all(...).then/.catch 两个回调里复位。
 *       只要那段前置逻辑（renderMem / drawSpark / renderDisks）抛一次异常，
 *       busy 就永久为 true —— 面板停止刷新，连手动点 ⟳ 都进不去，只能重载面板。
 * 做法：把 refreshFail / guardRefresh 从 main.js 里**抠出来真跑一遍**（与 [1] 的 toast 同一手法）。 */
console.log('\n[12] 刷新链异常后 busy 必须复位（P0）');
{
  const pick = (sig) => {
    const p = mainJs.indexOf('function ' + sig);
    if (p < 0) return null;
    let i = mainJs.indexOf('{', p), depth = 0, end = -1;
    for (let k = i; k < mainJs.length; k++) {
      if (mainJs[k] === '{') depth++;
      else if (mainJs[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    }
    return end < 0 ? null : mainJs.slice(p, end + 1);
  };
  const a = pick('refreshFail'), b = pick('guardRefresh');
  ok('main.js 里有 refreshFail 与 guardRefresh', !!a && !!b);
  ok('readAE 的回调被 guardRefresh 包住（回调是异步跑的，外面的 try 抓不到它）',
     /readAE\(guardRefresh\(function/.test(mainJs));
  ok('前置段自己有 try/catch 且 catch 里 return（不再往下走到 readAE）',
     /\} catch \(e\) \{[\r\n\s]*refreshFail\(e\);\s*[\r\n\s]*return;/.test(mainJs));

  if (a && b) {
    const body = (a + '\n' + b)
      .replace('function refreshFail', 'var refreshFail = function')
      .replace('function guardRefresh', 'var guardRefresh = function');
    const factory = new Function('ST', 'console',
      body + '\nreturn { refreshFail: refreshFail, guardRefresh: guardRefresh };');
    const ST = { busy: true };
    const G = factory(ST, { error() {} });
    ok('抠出来的两个函数都可用', typeof G.refreshFail === 'function' && typeof G.guardRefresh === 'function');

    ST.busy = true;
    let threw = false;
    try { G.guardRefresh(function () { throw new Error('模拟渲染期异常'); })({}); }
    catch (e) { threw = true; }
    ok('回调抛异常时不往外冒（不炸掉 readAE 的回调链）', !threw);
    ok('busy 被复位成 false（这个 P0 的核心）', ST.busy === false, 'busy=' + ST.busy);

    ST.busy = true;
    let got = null;
    G.guardRefresh(function (info) { got = info; })({ project: 'x' });
    ok('回调正常时参数照传、busy 不动（不误伤成功路径）',
       !!got && got.project === 'x' && ST.busy === true);
  }
}

/* ---------------- [13] GB 数值必须按 GB 显示（1.6.6） ----------------
 * 用户报的：小窗「还能写」显示 142B，而缓存盘实际还有 142 GB。
 * 这里不是比对字符串有没有改，而是把 fmtBytes / miBytes / miGB 抠出来**真跑一遍**：
 * 同一台机器上的 142 GB，旧写法给「142B」、新写法给「142GB」—— 能观察到差别，才算钉住。 */
console.log('\n[13] GB 数值必须按 GB 显示');
{
  const parts = ['fmtBytes', 'miBytes', 'miGB']
    .map(n => extractFn(mainJs, 'function ' + n + '('));
  if (parts.some(x => !x)) {
    ok('能抠出 fmtBytes / miBytes / miGB', false, 'main.js 里缺其中之一');
    ok('miGB(142) 显示成 142GB', false, '--');
  } else {
    const factory = new Function('GB',
      parts.join('\n') + '\nreturn { fmtBytes: fmtBytes, miBytes: miBytes, miGB: miGB };');
    const F = factory(1073741824);
    ok('能抠出 fmtBytes / miBytes / miGB', typeof F.miGB === 'function');
    ok('miGB(142) === "142GB"（用户报的那一格）', F.miGB(142) === '142GB', '得到 ' + F.miGB(142));
    ok('miBytes(142) === "142B"（旧写法就是这个 —— 反向证明这组测试看得出差别）',
       F.miBytes(142) === '142B', '得到 ' + F.miBytes(142));
    ok('miGB 内部确实 ×GB（等价于 miBytes(142 * GB)）',
       F.miGB(142) === F.miBytes(142 * 1073741824));
    ok('小数也走 GB：miGB(0.5) === "512MB"', F.miGB(0.5) === '512MB', '得到 ' + F.miGB(0.5));
    ok('非数字给 "--"（不显示 NaN）', F.miGB(NaN) === '--' && F.miGB(undefined) === '--');
    ok('字节字段不受影响：miBytes(142 * GB) 仍是 "142GB"',
       F.miBytes(142 * 1073741824) === '142GB' && F.miBytes(512) === '512B');
  }
}

console.log('\n[新 14] 面板主题：把 main.js 里那段主题代码抠出来真跑（不靠静态断言猜）');
{
  const mainText = read('js/main.js');
  const a = mainText.indexOf('  function themeList() {');
  const b = mainText.indexOf('  /* 三个下拉的选项由 MINI_MAIN / MINI_SUB 生成');
  const themeSrc = (a >= 0 && b > a) ? mainText.slice(a, b) : '';
  ok('能从 main.js 里抠出主题代码块', themeSrc.indexOf('function applyTheme') >= 0 && themeSrc.length > 500);

  const bodyStub = { attrs: {}, style: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const docStub = { body: bodyStub };
  const settsStub = {
    THEMES: ['mint', 'azure', 'lotus', 'gray', 'pink'],
    THEME_LABELS: { mint: '薄荷绿', azure: '天青蓝', lotus: '藕紫', gray: '灰色', pink: '淡粉' },
    THEME_DOTS: { mint: '#7fbf9a', azure: '#63b3d4', lotus: '#a99ad0', gray: '#a8a8a8', pink: '#dda3b8' },
    normalize(cfg) { return cfg; }
  };
  function api(usr) {
    const f = new Function('document', '$', 'Settings', 'USR', 'saveCfg',
      themeSrc + '; return { applyTheme: applyTheme, setTheme: setTheme };');
    return f(docStub, () => null, settsStub, usr, () => {});
  }

  api({ ui: { theme: 'pink' } }).applyTheme();
  ok('applyTheme 把当前主题写到 body 的 data-theme 上', bodyStub.attrs['data-theme'] === 'pink', bodyStub.attrs['data-theme']);

  const t2 = api({ ui: { theme: 'mint' } });
  t2.setTheme('azure');
  ok('setTheme 换主题：立刻写进 body（不用重开面板）', bodyStub.attrs['data-theme'] === 'azure', bodyStub.attrs['data-theme']);

  t2.setTheme('rainbow');
  ok('白名单外的主题被忽略（写坏值不生效）', bodyStub.attrs['data-theme'] === 'azure', bodyStub.attrs['data-theme']);

  bodyStub.attrs['data-theme'] = '';
  api({ ui: {} }).applyTheme();
  ok('设置里没有主题时落到默认薄荷绿', bodyStub.attrs['data-theme'] === 'mint', bodyStub.attrs['data-theme']);
}

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
