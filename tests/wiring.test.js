/* wiring.test.js — 接线一致性测试
 * 手写 HTML + JS 绑定时最容易出的错：ID 拼错、脚本漏引、顺序颠倒。
 * 这些错误在 Node 里跑不出来，但装进 AE 就会白屏或点了没反应。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const html = read('index.html');
const mainJs = read('js/main.js');
const css = read('css/style.css');
const manifest = read('CSXS/manifest.xml');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

console.log('[1] 脚本引用与加载顺序');
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
ok('引用了 7 个脚本', scripts.length === 7, scripts.join(' -> '));
ok('每个脚本文件都存在', scripts.every(s => fs.existsSync(path.join(ROOT, s))));
const order = ['js/ae-cache.js', 'js/settings.js', 'js/reminder.js', 'js/guard.js', 'js/trend.js', 'js/backup.js', 'js/main.js'];
ok('依赖顺序正确', JSON.stringify(scripts) === JSON.stringify(order), scripts.join(','));
ok('guard.js 早于 main.js', scripts.indexOf('js/guard.js') < scripts.indexOf('js/main.js'));
ok('trend.js 早于 main.js', scripts.indexOf('js/trend.js') < scripts.indexOf('js/main.js'));
ok('未引用已删除的 notify.js', !/notify\.js/.test(html) && !fs.existsSync(path.join(ROOT, 'js/notify.js')));
ok('main.js 不依赖声音模块', !/SysmonNotify/.test(mainJs));

console.log('\n[2] main.js 里引用的元素 ID 都存在于 HTML');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = [...new Set([...mainJs.matchAll(/\$\('([^']+)'\)/g)].map(m => m[1]))];
const missing = used.filter(u => !ids.has(u));
ok(`引用了 ${used.length} 个 ID，无缺失`, missing.length === 0, missing.length ? missing.join(', ') : '全部命中');

console.log('\n[3] HTML 里的 ID 没有重复');
const all = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const dup = all.filter((v, i) => all.indexOf(v) !== i);
ok('无重复 ID', dup.length === 0, dup.length ? dup.join(', ') : '无');

console.log('\n[4] label / for 指向真实控件');
const fors = [...html.matchAll(/\bfor="([^"]+)"/g)].map(m => m[1]);
const badFor = fors.filter(f => !ids.has(f));
ok(`${fors.length} 个 label 全部指向存在控件`, badFor.length === 0, badFor.join(', ') || 'OK');

console.log('\n[5] 关键结构齐备');
['miniView', 'miniRing', 'miniPct', 'miniLabel', 'miniExpand', 'miniCfg',
 'drawer', 'mask', 'dwClose', 'dwReset',
 'remindBar', 'rmIco', 'rmTitle', 'rmMsg', 'rmSnooze', 'rmOk',
 'btnCompact', 'btnCfg', 'kMargin',
 'gdLevel', 'gdState', 'gdBar', 'gdReason', 'gdAeSave',
 'cbGuard', 'cbGuardWrite', 'inGuardHold', 'inGuardRisk', 'inGuardCool',
 'cacheRate', 'renderBadge'].forEach(id => {
  ok('存在 #' + id, ids.has(id));
});

console.log('\n[6] 设置抽屉的控件成套');
const pairs = [['cbWater','inWater'],['cbStand','inStand'],['cbEyes','inEyes'],['cbMem','inMem']];
pairs.forEach(p => {
  ok(`${p[0]} + ${p[1]} 都存在`, ids.has(p[0]) && ids.has(p[1]));
  const num = new RegExp(`id="${p[1]}"[^>]*min="(\\d+)"[^>]*max="(\\d+)"`).exec(html);
  ok(`  ${p[1]} 带 min/max 约束`, !!num, num ? `${num[1]}..${num[2]}` : '缺失');
});

console.log('\n[7] 时间输入允许自由填写（不是下拉档位）');
pairs.forEach(p => {
  const tag = new RegExp(`<input[^>]*id="${p[1]}"[^>]*>`).exec(html);
  ok(`${p[1]} 是 number 输入`, !!tag && /type="number"/.test(tag[0]));
  ok(`  ${p[1]} 有 step=1`, !!tag && /step="1"/.test(tag[0]));
});

console.log('\n[8] CSS 覆盖新增的界面');
['.mini', 'body.compact', '.drawer', '.mask', '.remind', '.row', '.grp', '.mini-ring',
 '.gd-line', '.gd-bar', '.hint', '.card-hd-r.lv-high', '.crate', '.badge.mute'].forEach(sel => {
  ok('样式中存在 ' + sel, css.indexOf(sel) >= 0);
});
ok('极简：没有卡片底色变量残留', css.indexOf('--card') < 0);
ok('极简：进度条改用 1px 分隔线基调', /--line:/.test(css));

console.log('\n[8b] 崩溃保护的设置项成套且可自由填数');
['inGuardHold', 'inGuardRisk', 'inGuardCool'].forEach(id => {
  const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(html);
  ok(`${id} 是 number 输入`, !!tag && /type="number"/.test(tag[0]));
  ok(`  ${id} 带 min/max`, !!tag && /min="\d+"/.test(tag[0]) && /max="\d+"/.test(tag[0]));
});
ok('设置里有 crashGuard 分支', read('js/settings.js').indexOf('crashGuard') >= 0);
ok('main.js 使用 guard 模块', /SysmonGuard/.test(mainJs));
ok('保存走 host.jsx 的 sysmon_save', /sysmon_save/.test(mainJs) && /function sysmon_save/.test(read('jsx/host.jsx')));
ok('未保存工程不会被自动写入', /untitled/.test(read('js/guard.js')) && /untitled/.test(read('jsx/host.jsx')));
ok('保存不会弹另存为对话框', !/sysmon_save\s*\([^)]*File/.test(read('jsx/host.jsx')) && !/saveWithDialog/.test(read('jsx/host.jsx')));

console.log('\n[9] manifest 允许折叠成窄条 / 版本覆盖');
ok('MinSize 宽度 <= 120', /<Width>(\d+)<\/Width>/.test(manifest) &&
   (() => { const m = [...manifest.matchAll(/<Width>(\d+)<\/Width>/g)]; const min = Math.min(...m.map(x => +x[1])); return min <= 120; })());
ok('仍开启 --enable-nodejs', manifest.indexOf('--enable-nodejs') >= 0);
ok('Host 下探到 AE CC 2018 (15.0)', /Version="\[15\.0,99\.9\]"/.test(manifest));
ok('Host 上限为 99.9（覆盖未来版本）', /Version="\[15\.0,99\.9\]"/.test(manifest));
ok('RequiredRuntime 降到 CEP 7', /<RequiredRuntime Name="CSXS" Version="7\.0"/.test(manifest));

console.log('\n[9b] 安装脚本覆盖旧版 CEP 的调试开关');
const installBat = read('install.bat');
ok('写入 CSXS 6（AE CC 2015.3）', /for %%V in \(6 7 8 9 10 11 12\)/.test(installBat));
ok('写入 CSXS 12（AE 2025+）', installBat.indexOf('12') >= 0);

console.log('\n[10] 声音已彻底移除');
ok('设置里无 sound 字段', read('js/settings.js').indexOf('sound') < 0);
ok('提醒引擎不播放声音', read('js/reminder.js').indexOf('SoundPlayer') < 0);
ok('main.js 不调用播放', !/\.play\(/.test(mainJs));

console.log('\n[11] 提示框落在显示框内、动作按钮可点（1.6.0）');
ok('HTML 有 #toastHost 容器', ids.has('toastHost'));
ok('HTML 有底部堆叠容器 #bottomStack', ids.has('bottomStack'));
ok('#toastHost 在 #bottomStack 内',
   /id="bottomStack"[\s\S]*?id="toastHost"/.test(html));
ok('#remindBar 在 #bottomStack 内（与提示框不打架）',
   /id="bottomStack"[\s\S]*?id="remindBar"/.test(html));
ok('提示框不再用 position:fixed 挂在 body 上',
   !/\.toast\s*\{[^}]*position:\s*fixed/.test(css));
ok('提示框容器不脱离面板（fixed 的堆叠层宽度=面板宽）',
   /\.bottom-stack\s*\{[^}]*position:\s*fixed[^}]*left:\s*0[^}]*right:\s*0/.test(css));
ok('.toast.show 恢复 pointer-events:auto（按钮才点得到）',
   /\.toast\.show\s*\{[^}]*pointer-events:\s*auto/.test(css));
ok('.toast 初始 pointer-events:none（未显示时不挡路）',
   /\.toast\s*\{[^}]*pointer-events:\s*none/.test(css));
ok('提醒条不再 position:fixed（改在堆叠层内）',
   !/\.remind\s*\{[^}]*position:\s*fixed/.test(css));
ok('main.js 把提示框挂到 #toastHost（不是 body）',
   /var host = \$\('toastHost'\)/.test(mainJs));
ok('main.js 不再 document.body.appendChild(t) 挂提示框',
   !/document\.body\.appendChild\(t\)/.test(mainJs));
ok('提示框按钮有点击处理', /btn\.onclick\s*=/.test(mainJs));
ok('提示框消息与按钮分开两个元素（按钮不会被挤没）',
   /className = 'toast-msg'/.test(mainJs) && /className = 'toast-action'/.test(mainJs));

console.log('\n[12] 首屏视图可配置（1.6.0）');
ok('设置里有 selUiDefault 控件', ids.has('selUiDefault'));
ok('控件提供三个选项',
   ['compact', 'full', 'remember'].every(v => new RegExp(`value="${v}"`).test(html)));
ok('settings.js 里有 uiDefault 默认值', /uiDefault:\s*'compact'/.test(read('js/settings.js')));
ok('settings.js 的 schema 校验 uiDefault',
   /uiDefault:\s*\{\s*type:\s*'enum',\s*values:\s*\['compact',\s*'full',\s*'remember'\]\s*\}/.test(read('js/settings.js')));
ok('main.js 有 applyUiDefault', /function applyUiDefault\(\)/.test(mainJs));
ok('init 时应用 uiDefault', /applyUiDefault\(\);/.test(mainJs));
ok('设置抽屉回填 uiDefault', /selUiDefault'\)\.value = USR\.uiDefault/.test(mainJs));
ok('设置抽屉写入 uiDefault', /uiDefault:\s*\$\('selUiDefault'\)\.value/.test(mainJs));
ok('每处 normalize 都带回 uiDefault（否则会被重置）',
   (mainJs.match(/Settings\.normalize\(\{/g) || []).length ===
   (mainJs.match(/uiDefault:\s*USR\.uiDefault|uiDefault:\s*\$\('selUiDefault'\)\.value/g) || []).length,
   (mainJs.match(/Settings\.normalize\(\{/g) || []).length + ' 处 normalize / ' +
   (mainJs.match(/uiDefault:\s*USR\.uiDefault|uiDefault:\s*\$\('selUiDefault'\)\.value/g) || []).length + ' 处带 uiDefault');

console.log('\n[13] 极简 / 正常两种模式的提醒优化（1.6.0）');
ok('提醒条与小窗都有紧凑样式', /body\.compact \.remind\s*\{/.test(css));
ok('小窗下提醒条改竖排（横排会挤爆窄面板）',
   /body\.compact \.remind\s*\{[^}]*flex-direction:\s*column/.test(css));
ok('小窗下动作按钮横排并占满宽度',
   /body\.compact \.rm-act\s*\{[^}]*flex-direction:\s*row/.test(css) &&
   /body\.compact \.rm-act button\s*\{[^}]*flex:\s*1 1 auto/.test(css));
ok('小窗下提示框也改竖排',
   /body\.compact \.toast\s*\{[^}]*flex-direction:\s*column/.test(css));
ok('小窗下提示框按钮占满宽度',
   /body\.compact \.toast-action\s*\{[^}]*width:\s*100%/.test(css));
ok('小窗下长消息被限制高度（否则按钮被挤出）',
   /body\.compact \.rm-txt span\s*\{[^}]*max-height/.test(css));
ok('展开态解除高度限制（用户点开要能看全）',
   /body\.compact \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*none/.test(css));
ok('reminder.js 产出 shortMsg', /shortMsg:\s*buildShortMessage/.test(read('js/reminder.js')));
ok('小窗模式用短消息', /compact && it\.shortMsg/.test(mainJs));
ok('点标题可切换长短消息', /function toggleRemindMsg\(\)/.test(mainJs));
ok('rmTitle 绑定了切换', /rmTitle'\)\.addEventListener\('click', toggleRemindMsg\)/.test(mainJs));
ok('提醒设置有状态摘要', ids.has('remindSummary'));
ok('摘要会被回填', /syncRemindSummary\(\)/.test(mainJs));
ok('摘要在输入时实时预览', /previewRemindSummary/.test(mainJs));
ok('有常用间隔预设按钮', ids.has('btnRemindPreset'));
ok('预设按钮已绑定', /btnRemindPreset'\)\.addEventListener\('click', applyRemindPreset\)/.test(mainJs));

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
