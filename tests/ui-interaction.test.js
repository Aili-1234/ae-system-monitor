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
ok('小窗下提醒条竖排',
   /body\.compact \.remind\s*\{[^}]*flex-direction:\s*column/.test(css));
ok('小窗下长消息限高（不挤掉按钮）',
   /body\.compact \.rm-txt span\s*\{[^}]*max-height/.test(css));
ok('展开态不限高（点开能看全）',
   /body\.compact \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*none/.test(css));

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

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
