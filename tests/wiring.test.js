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
const settings = read('js/settings.js');

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
 'bkList', 'miniStats', 'ms1', 'ms2', 'mi1', 'mi2', 'ml1', 'ml2', 'mv1', 'mv2',
 'miMain', 'selSub1', 'selSub2', 'miniHint',
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
['.mini', 'body.compact', '.drawer', '.mask', '.remind', '.row', '.grp', '.mini-ring', '.bkl-r', '.mini-stats',
 '.gd-line', '.gd-bar', '.hint', '.card-hd-r.lv-high', '.crate', '.badge.mute'].forEach(sel => {
  ok('样式中存在 ' + sel, css.indexOf(sel) >= 0);
});
ok('极简：没有卡片底色变量残留', css.indexOf('--card') < 0);
ok('极简：进度条改用 1px 分隔线基调', /--line:/.test(css));

console.log('\n[8a] 回退副本列表与极简占用行（1.6.2）');
ok('#bkList 在保护卡体内', /id="bdGuard"[\s\S]*?id="bkList"/.test(html));
ok('#bkList 默认收起', /id="bkList"[^>]*\shidden/.test(html));
ok('#miniStats 在小窗里且在按钮行之前',
   /id="miniView"[\s\S]*?id="miniStats"[\s\S]*?class="mini-row"/.test(html));
ok('main.js 只列最近 3 份', /BK_LIST_N\s*=\s*3/.test(mainJs));
ok('main.js 有逐份取回 restorePick', /function restorePick\s*\(/.test(mainJs));
ok('main.js 有列表渲染 renderBackupList', /function renderBackupList\s*\(/.test(mainJs));
ok('main.js 有短时间戳 stampShort', /function stampShort\s*\(/.test(mainJs));
ok('main.js 有小窗占用行 renderMiniStats', /function renderMiniStats\s*\(/.test(mainJs));
ok('分数由 Backup.recent 收口', /Backup\.recent\(/.test(mainJs));
ok('backup.js 导出 recent', /recent:\s*recent/.test(read('js/backup.js')));
ok('窄面板下隐藏尺寸列（.bkl.narrow）', /\.bkl\.narrow/.test(css));
ok('取回按钮带 data-bk 以逐份定位', /data-bk="/.test(mainJs));
ok('点行展开：bkHint 绑了 click', /bkHintEl\.addEventListener/.test(mainJs));

/* [8a-2] 恰是 1.6.2 引入列表后才可能出的漏洞：收起动作只挂在成功路径上。
 * renderBackup() 有三条提前返回（无 Node / 备份已关 / 工程未保存），
 * 它们都只换 el.textContent 就 return 了 —— 用户点开的列表会原地留着，
 * 文字说着「已关闭」，下面 ↺ 还点得动。断言把「收起」钉在三条 return 之前。 */
ok('renderBackup 把「收起列表」放在提前返回之前',
   /if \(bkListOpen\)\s*\{[\s\S]*?early\.hidden = true[\s\S]*?\}\s*\n\s*if \(!Backup \|\| !hasNode\)/.test(mainJs));
ok('三条提前返回都清掉 clickable（不再显示可点）',
   (mainJs.match(/classList\.remove\('clickable'\)/g) || []).length >= 3);
ok('空列表分支也走 renderBackupList（会收起并清空）',
   /if \(!list\.length\)[\s\S]*?renderBackupList\(list\)/.test(mainJs));
ok('逐份取回按 path 认那一份，不再按下标',
   /Backup\.pickByPath\(/.test(mainJs) && /data-bk="' \+ key/.test(mainJs));
ok('按钮不再带下标（data-bk 值来自 path）',
   !/data-bk="' \+ i \+/.test(mainJs));
ok('backup.js 导出 pickByPath', /pickByPath:\s*pickByPath/.test(read('js/backup.js')));

/* [8a-2] 小窗占用行必须挂在**数值**的节拍上（renderCache / renderMem），不能在 renderMini 里。
 *
 * 这条断言是审计逼出来的：1.6.2 第一版把 renderMiniStats() 留在 renderMini() 末尾，
 * 注释却写着「独立于 renderMini、该跟数值的节拍走」—— 注释描述的是意图，代码是另一回事。
 * 当下能刷新纯属巧合（renderCache/renderMem 各自末尾恰好调了 renderMini）。
 * 一旦有人照注释给 renderMini 加「百分比没变就不重绘」的短路（drawSpark 已有同款先例），
 * 这两行会静静停在旧值上。所以把「挂在谁末尾」钉成断言，而不是靠注释自觉。 */
const miniFn = mainJs.slice(mainJs.indexOf('function renderMini()'),
                            mainJs.indexOf('function renderMiniStats()'));
ok('renderMini 内部不再调用 renderMiniStats（解耦）',
   !/renderMiniStats\(\)/.test(miniFn));
ok('renderCache 末尾刷新占用行',
   /function renderCache\(\)[\s\S]*?renderMiniStats\(\);[\s\S]*?\n  \}/.test(mainJs));
ok('renderMem 末尾刷新占用行',
   /function renderMem\(\)[\s\S]*?renderMiniStats\(\);[\s\S]*?\n  \}/.test(mainJs));
ok('占用行至少有两个刷新点（不是只挂在一条链上）',
   (mainJs.match(/renderMiniStats\(\);/g) || []).length >= 2);

/* [8a-3] 小窗占用行的排版（用户：两列往中间靠一点、带些图标）。
 * 旧实现是 width:100% + space-between + 右列右对齐 —— 两列被顶到面板左右两侧，
 * 窗口一宽就显得空；改成整组居中 + gap 随宽度收缩，并给两列各配一个内联图标。 */
ok('小窗占用行两列各带一个内联图标',
   /id="ms1"[\s\S]{0,240}?<svg class="mi"/.test(html) &&
   /id="ms2"[\s\S]{0,240}?<svg class="mi"/.test(html));
ok('占用行整组居中（不再顶到两侧）',
   /\.mini-stats \{[\s\S]*?justify-content: center/.test(css) &&
   !/\.mini-stats \.ms:last-child \{ text-align: right/.test(css));
ok('两列间距随面板宽度连续自适应（1.7.0 去 flex gap → 子元素 margin；1.7.1 变量改视口单位）',
   /\.mini-stats \.ms \+ \.ms \{ margin-left: var\(--mini-gap-x\); \}/.test(css) &&
   /--mini-gap-x: calc\(4px \+ 4vw\)/.test(css));
ok('图标跟占用一起变色', /\.mini-stats \.ms\.on \.mi/.test(css) && /\.mini-stats \.ms\.bad \.mi/.test(css));

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

console.log('\n[8c] 回退副本落点可改（1.6.4）');
{
  const settings = read('js/settings.js');
  const backup = read('js/backup.js');
  ok('设置里新增 backupDir（默认空串 = 用默认位置）',
     /backupDir: ''/.test(settings) && /backupDir:\s*\{ type: 'str'/.test(settings));
  ok('路径字符串只清理语义、不判合法性（normStr 处理引号与结尾分隔符）',
     /function normStr/.test(settings) && /charAt\(0\) === '"'/.test(settings));
  ok('main.js 读的是归一化后的 crashGuard.backupDir',
     /function customBackupDir\(\)/.test(mainJs) && /crashGuard\.backupDir/.test(mainJs));
  ok('落点决策走 Backup.pickRoot（单测覆盖的那一份，不在接线层重写）',
     /Backup\.pickRoot\(/.test(mainJs) && /function pickRoot/.test(backup) && /pickRoot: pickRoot/.test(backup));
  ok('自定义目录不可用时退回默认位置并标记（不是静默跳过备份）',
     /function defaultBackupDirFor/.test(mainJs) && /fellback/.test(backup) && /ST\.bkFallback = /.test(mainJs));
  ok('默认位置里的老副本仍会被列出（只读扫一遍，标注来源）',
     /scan\(defDir, '默认位置'\)/.test(mainJs) && /scan\(legacyBackupDirFor\(projectPath\), '旧位置'\)/.test(mainJs));
  ok('列表行标的是这一份自己的来源', /b\.note \?/.test(mainJs) && !/b\.old \?/.test(mainJs));
  ok('落点不可用时出声一次（不静默退回）', /function bkDirWarn/.test(mainJs) && /bkDirWarn\(\)/.test(mainJs));
  ok('目录选择走 CEP 的 showOpenDialog，拿不到就如实提示手动填',
     /window\.cep\.fs\.showOpenDialog/.test(mainJs) && /不支持目录选择，请手动填写路径/.test(mainJs));
  ok('设置抽屉有「副本目录」一行 + 两个按钮，且排在备份开关之后',
     /id="cbBackup"[\s\S]{0,1200}?id="inBkDir"[\s\S]{0,1200}?id="btnBkDirPick"[\s\S]{0,600}?id="btnBkDirReset"/.test(html));
  ok('路径输入框独占且可收缩（不跟小控件挤成竖排）',
     /\.row #inBkDir \{[\s\S]*?flex: 1 1 auto/.test(css));
  ok('「用默认」把值清空并立刻应用', /mergeGuardCfg\(\{ backupDir: '' \}\)/.test(mainJs));
}

console.log('\n[8d] 小窗主/次显示可选（1.6.5）');
{
  ok('设置里有主显示 + 两个次显示下拉与说明行',
     ['selMetric', 'selSub1', 'selSub2', 'miniHint'].every(id => ids.has(id)));
  ok('下拉选项由 settings 的清单生成（不在 HTML 里手写第二份）',
     /buildMiniOptions/.test(mainJs) && /MINI_MAIN/.test(mainJs) && /MINI_SUB/.test(mainJs)
     && !/<option value="cache">/.test(html));
  ok('init 里真的建了选项', /buildMiniOptions\(\);/.test(mainJs));
  ok('settings 导出清单与去重函数',
     /MINI_MAIN: MINI_MAIN/.test(settings) && /MINI_SUB: MINI_SUB/.test(settings)
     && /MINI_UNITS: MINI_UNITS/.test(settings) && /fixMini: fixMini/.test(settings));
  ok('主/次重复的判定在 settings（界面只写结果）',
     /function fixMini/.test(settings) && /function miniFamily/.test(settings)
     && /Settings\.fixMini\(/.test(mainJs));
  ok('老值 cache / mem 有迁移别名',
     /alias: \{ cache: 'cache_pct', mem: 'mem_free_pct' \}/.test(settings));
  ok('两格改成动态插槽，没选的格子不占位置',
     /id="ms1"/.test(html) && /id="ms2"/.test(html)
     && /\.mini-stats \.ms\[hidden\] \{ display: none/.test(css));
  ok('主显示的标签前也带图标（换指标后仍认得出来）',
     /id="miMain"/.test(html) && /miSetIcon\(\$\('miMain'\)/.test(mainJs)
     && /\.mini-label \.mi \{/.test(css));
  ok('图标只在键变了才重写 DOM（每 3 秒刷一次，别反复 innerHTML）',
     /data-mi/.test(mainJs) && /getAttribute\('data-mi'\)/.test(mainJs));
  ok('七个图标都在：缓存 / 内存 / 所需 / 盘 / 还能写 / 增速 / 距耗尽',
     ['cache', 'mem', 'need', 'disk', 'left', 'rate', 'eta'].every(k => new RegExp(k + ":\\s*'").test(mainJs)));
  ok('选完立刻生效（不必回抽屉按确定）',
     /function applyMiniChoice/.test(mainJs) && /addEventListener\('change', applyMiniChoice\)/.test(mainJs));
  ok('渲染签名带上次显示（否则改设置不重绘）',
     /USR\.miniMetric \+ '\|' \+ USR\.miniSub1/.test(mainJs));
}
console.log('\n[8e] GB 数值不许走字节格式化（1.6.6 修「还能写 142B」）');
ok('main.js 有 miGB（GB 数值专用：内部 ×GB 后再交给 miBytes）',
   /function miGB\(/.test(mainJs));
ok('还能写（leftGB）走 miGB',
   mainJs.indexOf('miGB(ST.cache.leftGB)') >= 0);
ok('AE 所需（needGB）走 miGB',
   mainJs.indexOf('miGB(ST.cache.needGB)') >= 0);
ok('盘余量（driveFreeGB）走 miGB',
   mainJs.indexOf('miGB(ST.cache.driveFreeGB)') >= 0);
ok('三个 GB 字段都不再走 miBytes（这正是 142 GB 显示成 142B 的原因）',
   mainJs.indexOf('miBytes(ST.cache.leftGB)') < 0 &&
   mainJs.indexOf('miBytes(ST.cache.needGB)') < 0 &&
   mainJs.indexOf('miBytes(ST.cache.driveFreeGB)') < 0);
ok('字节字段仍留在 miBytes（没有一刀切全改 miGB，否则会把字节数再乘 1024³）',
   mainJs.indexOf('miBytes(ST.cache.used)') >= 0 &&
   mainJs.indexOf('miBytes(ST.mem.free)') >= 0);

console.log('\n[8f] 1.7.0：老 AE 兼容（CEP 8 / Chromium 57）+ 缩放不再有延迟 + 矮则横排');
/* 注释里的 clamp()/conic-gradient 等字样不算，先剥掉注释再查。 */
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
ok('CSS 不再用 clamp()（Chromium 79+）', !/clamp\(/.test(cssCode));
ok('CSS 不再用 inset 简写（Chromium 87+）', !/\binset:/.test(cssCode));
ok('CSS 不再用 place-items', !/place-items/.test(cssCode));
ok('CSS 不再用 conic-gradient（Chromium 69+）', !/conic-gradient/.test(cssCode));
ok('CSS 不再用 CSS max()/min() 函数（grid 的 minmax 不算）',
   !/[\s:(]max\(/.test(cssCode) && !/[\s:(]min\(/.test(cssCode));
ok('flex 容器的 gap 改成子元素 margin（flex gap 要 Chromium 84+）',
   !/\.hd \{[\s\S]{0,240}?gap:/.test(cssCode) && /\.hd > \* \+ \* \{ margin-left: 8px; \}/.test(css));
ok('grid 间距写成 grid-gap / grid-column-gap / grid-row-gap（无前缀版要 Chromium 66）',
   /grid-gap: 10px/.test(css) && /grid-column-gap: 6px/.test(css) && /grid-row-gap: 5px/.test(css));
ok('环形图是内联 SVG 圆环，不是 conic-gradient 背景',
   /<svg class="arc" viewBox="0 0 36 36"/.test(html) && /\.arc-fg \{ stroke: var\(--rc/.test(css));
ok('r=15.9155 让周长正好 100（进度 = 100 - p，四段圆环两个环各两段）',
   (html.match(/r="15\.9155"/g) || []).length === 4 && /stroke-dashoffset/.test(css));
ok('main.js 用 setArc 写 stroke-dashoffset',
   /function setArc\(ringId, pct, col\)/.test(mainJs) &&
   /setArc\('ramRing', p, col\)/.test(mainJs) && /setArc\('miniRing', ok \? p : 0, col\)/.test(mainJs));
ok('小窗分两栏（左 .mini-main / 右 .mini-side）',
   /<div class="mini-main">/.test(html) && /<div class="mini-side">/.test(html));
ok('矮则横排断点存在，且 96px 极窄档被 min-width 排除',
   /@media \(max-height: 170px\) and \(min-width: 150px\)/.test(css) &&
   /body\.compact \.mini \{ flex-direction: row; \}/.test(css));
ok('横排时右栏两格改竖排、左对齐',
   /\.mini-side \.mini-stats \{ flex-direction: column; align-items: flex-start; \}/.test(css));
ok('resize 用 rAF 合并，一帧最多一次',
   /requestAnimationFrame\(onResize\)/.test(mainJs) && /if \(rsPending\) return;/.test(mainJs));
ok('resize 只做跟手的事，canvas 尺寸真变了才重画 spark',
   /if \(w !== rsW \|\| h !== rsH\) \{/.test(mainJs) &&
   /applyWidthClasses\(\);\s*\n\s*checkAutoCollapse\(\);/.test(mainJs));
ok('窄面板类抽成 applyWidthClasses()（渲染与 resize 共用）',
   /function applyWidthClasses\(\)/.test(mainJs) && /applyWidthClasses\(\);\s*\n\s*box\.hidden/.test(mainJs));
ok('小窗不再有布局属性过渡（消失的延迟来源）',
   !/\.mini \{[\s\S]{0,240}?transition:/.test(cssCode) &&
   !/\.mini-ring \{[\s\S]{0,240}?transition: (background|width|height)/.test(cssCode));
const tagCount = (t, tag) => [(t.match(new RegExp('<' + tag + '[ >]', 'g')) || []).length,
                              (t.match(new RegExp('</' + tag + '>', 'g')) || []).length];
ok('HTML 标签配平（1.7.0 踩过：小窗少一个 </div>，把设置抽屉整块吞进 #miniView）',
   ['div', 'span', 'button', 'aside', 'svg'].every(tag => { const r = tagCount(html, tag); return r[0] === r[1]; }));
ok('小窗两栏结构完整（.mini-main 与 .mini-side 都在 #miniView 闭合之前）',
   /<div class="mini"[^>]*>[\s\S]*?<div class="mini-main">[\s\S]*?<div class="mini-side">[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/.test(html));
ok('小窗两栏的归属正确：环 + 主显示名在 .mini-main，两格 + 按钮行在 .mini-side',
   /<div class="mini-main">[\s\S]{0,400}?id="miniRing"[\s\S]{0,400}?id="miniLabel"[\s\S]{0,80}?<\/div>\s*<div class="mini-side">[\s\S]{0,400}?id="miniStats"[\s\S]{0,900}?<div class="mini-row">/.test(html));
ok('环形图算术成立：r=15.9155 的周长 ≈100，stroke-dasharray:100 才配得上百分比',
   Math.abs(2 * Math.PI * 15.9155 - 100) < 0.1 && /\.arc-fg \{[^}]*stroke-dasharray: 100/.test(cssCode) &&
   /\.arc \{[^}]*transform: rotate\(-90deg\)/.test(cssCode));

console.log('\n[8g] 小窗几何连续 + 图标更暗且尺寸自适 + 主显示图标换层叠横条（1.7.1）');
ok('环尺寸连续（vh）且有上下限（min/max-width/height，不依赖 clamp）',
   /--mini-ring: 30vh/.test(css) &&
   /\.mini-ring \{[\s\S]{0,300}?min-width: 44px[\s\S]{0,80}?min-height: 44px/.test(css) &&
   /max-width: 64px; max-height: 64px/.test(css));
ok('间距/内边距/图标都连续（视口单位 + calc），图标尺寸随面板自动变化并夹在 6–9px',
   /--mini-gap: calc\(4px \+ 1\.7vh\)/.test(css) &&
   /--mini-pad-y: calc\(3px \+ 2\.4vh\)/.test(css) &&
   /--mini-pad-x: calc\(3px \+ 1\.1vw\)/.test(css) &&
   /--mini-icon: calc\(5px \+ 1\.4vh\)/.test(css) &&
   /--mini-icon-gap: calc\(1px \+ 0\.4vh\)/.test(css) &&
   /\.mini-label \.mi \{[\s\S]{0,260}?width: var\(--mini-icon\)[\s\S]{0,140}?min-width: 6px[\s\S]{0,90}?max-width: 9px/.test(css) &&
   /\.mini-stats \.mi \{[\s\S]{0,260}?min-width: 6px[\s\S]{0,90}?max-width: 9px/.test(css));
ok('离散尺寸断点已删除（横排断点与窄档窄化保留）',
   !/@media \(max-height: 200px\)/.test(css) &&
   !/@media \(max-height: 160px\)/.test(css) &&
   !/@media \(max-width: 170px\)/.test(css) &&
   /@media \(max-height: 170px\) and \(min-width: 150px\)/.test(css));
ok('小窗图标色比正文暗一档、边缘有深蓝描边，且告警态仍覆盖（琥珀/红）',
   /--mini-ico: #6e6e6e/.test(css) &&
   /--mini-ico-edge: #1d3557/.test(css) &&
   /\.mini-label \.mi \{[\s\S]{0,600}?stroke: var\(--mini-ico\)/.test(css) &&
   /\.mini-label \.mi \{[\s\S]{0,600}?filter: drop-shadow\(0\.5px 0 var\(--mini-ico-edge\)\)/.test(css) &&
   /\.mini-stats \.mi \{[\s\S]{0,600}?stroke: var\(--mini-ico\)/.test(css) &&
   /\.mini-stats \.mi \{[\s\S]{0,600}?filter: drop-shadow\(0\.5px 0 var\(--mini-ico-edge\)\)/.test(css) &&
   /\.mini-stats \.ms\.on \.mi \{ stroke: var\(--warn\); \}/.test(css) &&
   /\.mini-stats \.ms\.bad \.mi \{ stroke: var\(--bad\); \}/.test(css));
ok('主显示「缓存已用」图标换成层叠横条（三片错开、长度递减，刻意不等长以免与设置按钮 ≡ 撞脸），不再用叠层圆柱',
   /cache: '<path d="M1\.2 2\.6h7\.6"\/><path d="M2\.5 5h6\.3"\/><path d="M3\.8 7\.4h3\.9"\/>'/.test(mainJs) &&
   !/cache: '<ellipse/.test(mainJs));


console.log('\n[8h] 面板主题（1.7.1：5 套深色主题，顶部色点 + 抽屉一行两处联动）');

/* 对比度是算出来的，不是看出来的 —— 深色主题最容易出的问题就是某个色在深底上糊成一团。 */
const wCss = css.replace(/\/\*[\s\S]*?\*\//g, '');
function wLum(hex) {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map(i => {
    const c = parseInt(h.substr(i, 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}
function wContrast(a, b) {
  const l1 = wLum(a), l2 = wLum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function wThemeVars(text) {
  const out = {};
  const re = /(:root|body\[data-theme="([a-z]+)"\])\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[2] || 'mint';
    out[name] = out[name] || {};
    m[3].split(';').forEach(decl => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      const k = decl.slice(0, i).trim();
      if (k.indexOf('--') === 0) out[name][k] = decl.slice(i + 1).trim();
    });
  }
  return out;
}
const wVars = wThemeVars(wCss);
const wThemes = ['mint', 'azure', 'lotus', 'gray', 'pink'];

function wPicked() {
  return wThemes.map(t => Object.assign({}, wVars.mint, wVars[t] || {}));
}
function wWorst(roles) {
  let worst = { name: '', ratio: 99 };
  wPicked().forEach((p, i) => {
    roles.forEach(r => {
      const ratio = wContrast(p[r], p['--bg']);
      if (ratio < worst.ratio) worst = { name: wThemes[i] + '/' + r, ratio: ratio };
    });
  });
  return worst;
}
function wHexOutsideVars() {
  const bad = [];
  const re = /([a-zA-Z-]+)\s*:\s*([^;}]*)/g;
  let m;
  while ((m = re.exec(wCss))) {
    if (/#[0-9a-fA-F]{3,8}\b/.test(m[2]) && m[1].indexOf('--') !== 0) {
      bad.push(m[1] + ': ' + m[2].trim().slice(0, 40));
    }
  }
  return bad;
}

ok('顶部有一个色点按钮（随时可换主题）', /id="btnTheme"/.test(html) && /id="themeDot"/.test(html));
ok('顶部有一个主题小面板容器', /id="themePop"/.test(html));
ok('抽屉「显示」组里也有一行主题色点与说明', /id="themeRow"/.test(html) && /id="themeHint"/.test(html));
ok('main.js 有 applyTheme / buildThemeOptions / syncThemeUI / setTheme',
  /function applyTheme\(/.test(mainJs) && /function buildThemeOptions\(/.test(mainJs) &&
  /function syncThemeUI\(/.test(mainJs) && /function setTheme\(/.test(mainJs));
ok('主题写到 body 的 data-theme 上（CSS 只认这个属性）', /setAttribute\('data-theme', id\)/.test(mainJs));
ok('两处控件用同一套事件委托（动态生成的色点不能逐个挂 listener）',
  /function themePick\(/.test(mainJs) && /\$\('themePop'\)\.addEventListener\('click', themePick\)/.test(mainJs) &&
  /\$\('themeRow'\)\.addEventListener\('click', themePick\)/.test(mainJs));
ok('CSS 里有四套主题块（薄荷绿是 :root 默认那套，不重复写一块）',
  ['azure', 'lotus', 'gray', 'pink'].every(t => wCss.indexOf('body[data-theme="' + t + '"]') >= 0));
ok('CSS 里颜色只出现在变量定义里（别处一律 var()，否则换主题会露出旧底色）',
  wHexOutsideVars().length === 0, wHexOutsideVars().join(' | '));
ok('每套主题都覆盖了小窗图标色与描边（否则换主题后小窗图标还是旧色）',
  wThemes.every(t => (wVars[t] || {})['--mini-ico'] && (wVars[t] || {})['--mini-ico-edge']));
ok('每套主题的关键文字色对底色对比度 ≥ 4.5（正文/次要/告警/危险）',
  wWorst(['--fg', '--fg-2', '--fg-3', '--ok', '--warn', '--bad']).ratio >= 4.5,
  '最差 ' + wWorst(['--fg', '--fg-2', '--fg-3', '--ok', '--warn', '--bad']).name + ' ' +
  wWorst(['--fg', '--fg-2', '--fg-3', '--ok', '--warn', '--bad']).ratio.toFixed(2));
ok('进度条中性色对底色至少可见（≥ 2，它不是文字）', wWorst(['--accent']).ratio >= 2,
  '最差 ' + wWorst(['--accent']).name + ' ' + wWorst(['--accent']).ratio.toFixed(2));

console.log('\n[9] manifest 允许折叠成窄条 / 版本覆盖');
ok('MinSize 宽度 <= 120', /<Width>(\d+)<\/Width>/.test(manifest) &&
   (() => { const m = [...manifest.matchAll(/<Width>(\d+)<\/Width>/g)]; const min = Math.min(...m.map(x => +x[1])); return min <= 120; })());
ok('仍开启 --enable-nodejs', manifest.indexOf('--enable-nodejs') >= 0);
ok('Host 下界回到 AE 2018 (15.0)：1.7.0 已把 flex gap / clamp / inset 全换成 margin + 断点',
   /Version="\[15\.0,99\.9\]"/.test(manifest));
ok('Host 上限为 99.9（覆盖未来版本）', /Version="\[15\.0,99\.9\]"/.test(manifest));
ok('RequiredRuntime 回到 CEP 8（与 Host 下界一致）',
   /<RequiredRuntime Name="CSXS" Version="8\.0"/.test(manifest));

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
ok('小窗下提醒条改两行网格、贴底显示（提示框叠在上方）、图标与标题同排、按钮独占一行',
   /body\.compact \.remind\s*\{[^}]*display:\s*grid[^}]*grid-template-areas:\s*"ico txt"\s*"act act"/.test(css) &&
   /body\.compact \.rm-ico\s*\{[^}]*grid-area:\s*ico/.test(css) &&
   /body\.compact \.rm-txt\s*\{[^}]*grid-area:\s*txt/.test(css) &&
   /body\.compact \.bottom-stack\s*\{[^}]*flex-direction:\s*column-reverse/.test(css) &&
   /body\.compact \.rm-act\s*\{[^}]*grid-area:\s*act/.test(css));
ok('小窗下动作按钮横排并占满宽度',
   /body\.compact \.rm-act\s*\{[^}]*flex-direction:\s*row/.test(css) &&
   /body\.compact \.rm-act button\s*\{[^}]*flex:\s*1 1 auto/.test(css));
ok('小窗下提示框也改竖排',
   /body\.compact \.toast\s*\{[^}]*flex-direction:\s*column/.test(css));
ok('小窗下提示框按钮占满宽度',
   /body\.compact \.toast-action\s*\{[^}]*width:\s*100%/.test(css));
ok('两种模式的长消息都被限制高度（否则按钮被挤出；1.7.0 max() → calc + 146px 断点）',
   /body\.compact \.rm-txt span\s*\{[^}]*max-height/.test(css) &&
   /body:not\(\.compact\) \.rm-txt span\s*\{[^}]*max-height:\s*calc\(100vh - 110px\)/.test(css) &&
   /@media \(max-height: 146px\)\s*\{[^}]*body:not\(\.compact\) \.rm-txt span\s*\{[^}]*max-height:\s*3\.6em/.test(css));
ok('展开态正文自己滚，标题和按钮留在视口内（正常模式整条也限高）',
   /body\.compact \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*calc\(100vh - 79px\)[^}]*overflow-y:\s*auto/.test(css) &&
   /body:not\(\.compact\) \.rm-txt span\.expanded\s*\{[^}]*max-height:\s*none/.test(css) &&
   /@media \(max-height: 240px\)\s*\{[^}]*body:not\(\.compact\) \.bottom-stack\s*\{[^}]*flex-direction:\s*column-reverse/.test(css));
ok('reminder.js 产出 shortMsg', /shortMsg:\s*buildShortMessage/.test(read('js/reminder.js')));
ok('小窗模式用短消息（折叠/展开时正在显示的提醒也跟着换文案）',
   /compact && it\.shortMsg/.test(mainJs) &&
   /if \(rmCur\) \{[\s\S]{0,220}compact && rmCur\.shortMsg/.test(mainJs));
ok('点标题可切换长短消息（正常模式只展开/收起，不会被换成短消息）',
   /function toggleRemindMsg\(\)/.test(mainJs) &&
   /if \(!compact\) return;/.test(mainJs) &&
   /classList\.toggle\('expanded', rmMsgExpanded\)/.test(mainJs));
ok('rmTitle 绑定了切换', /rmTitle'\)\.addEventListener\('click', toggleRemindMsg\)/.test(mainJs));
ok('提醒设置有状态摘要', ids.has('remindSummary'));
ok('摘要会被回填', /syncRemindSummary\(\)/.test(mainJs));
ok('摘要在输入时实时预览', /previewRemindSummary/.test(mainJs));
ok('有常用间隔预设按钮', ids.has('btnRemindPreset'));
ok('预设按钮已绑定', /btnRemindPreset'\)\.addEventListener\('click', applyRemindPreset\)/.test(mainJs));

console.log('\n[14] 带文字的按钮不能用方形图标尺寸（1.6.1）');
/* 背景：.ibtn.sm 是 17x17 的方形图标按钮（「↗」「✕」这类单字符）。
 * 一旦误用它装「按预设填入」这种多字按钮，文字会在格子里换行成多行、
 * 竖向溢出压到上下相邻的文字上 —— 视觉上就是两行字叠在一起。
 * 这类错只有真渲染才看得见，但可以先从静态侧拦一道：
 * 多字按钮必须带 wide/logbtn 这类自带尺寸的修饰类。 */
const ICON_ONLY = /^[\s\W_]*$/;   // 只含符号/空白 → 算图标，可以是方形
const btnTags = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
const textBtns = btnTags.map(m => {
  const attrs = m[1];
  const id = (attrs.match(/id="([^"]+)"/) || [])[1] || '';
  const cls = (attrs.match(/class="([^"]+)"/) || [])[1] || '';
  const text = m[2].replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '').trim();
  return { id, cls, text, attrs };
}).filter(b => b.text && !ICON_ONLY.test(b.text));

ok('HTML 里有带文字的按钮（否则这组测试没意义）', textBtns.length > 0,
   textBtns.map(b => b.id || b.text).join(', '));

const ibtnTextBtns = textBtns.filter(b => /\bibtn\b/.test(b.cls));
const noSize = ibtnTextBtns.filter(b => !/\b(wide|logbtn)\b/.test(b.cls));
ok('所有带文字的 ibtn 按钮都带尺寸修饰类（wide/logbtn）',
   noSize.length === 0,
   noSize.map(b => b.id + '(' + b.text + ')').join(', '));

/* 具体到这次的按钮：必须用 .wide，且 .wide 必须真的给出自适应尺寸 */
ok('预设按钮用的是 .ibtn.sm.wide',
   /<button[^>]*id="btnRemindPreset"[^>]*class="[^"]*\bwide\b/.test(html) ||
   /<button[^>]*class="[^"]*\bwide\b[^"]*"[^>]*id="btnRemindPreset"/.test(html));
ok('.ibtn.sm.wide 有自适应宽度（不能是固定 17px）',
   /\.ibtn\.sm\.wide\s*\{[^}]*width:\s*auto/.test(css));
ok('.ibtn.sm.wide 禁止换行（否则还是会竖向溢出）',
   /\.ibtn\.sm\.wide\s*\{[^}]*white-space:\s*nowrap/.test(css));
ok('.ibtn.sm.wide 有足够内边距',
   /\.ibtn\.sm\.wide\s*\{[^}]*padding:\s*0\s+9px/.test(css));
ok('预设按钮不再用裸的 .ibtn.sm',
   !/<button[^>]*id="btnRemindPreset"[^>]*class="ibtn sm"/.test(html));

console.log('\n[15] 静态 HTML 里不残留 Markdown 语法（1.6.1）');
/* 面板的说明文字是纯 HTML，不是 Markdown 渲染器。
 * 写 **强调** 只会在界面上原样显示星号（用户反馈过）。 */
const hintTexts = [...html.matchAll(/class="hint"[^>]*>([\s\S]*?)<\/div>/g)].map(m => m[1]);
ok('hint 说明文字里没有 Markdown 星号',
   hintTexts.every(t => !/\*\*/.test(t)),
   hintTexts.filter(t => /\*\*/.test(t)).map(t => t.replace(/\s+/g, ' ').slice(0, 40)).join(' | '));
ok('提示框用 <b> 而不是 **强调**',
   /提醒是<b>静默<\/b>的/.test(html));

console.log('\n[16] 抽屉里的行在窄面板下不能硬挤（1.6.1）');
/* 窄面板下 flex 行里的 label 会被压到 9px 宽、每个字占一行（竖排），
 * 或者文字直接溢出、压到右边的输入框/单位上。
 * 正确做法：行允许换行 + label 有最小宽度，两者一起兜底。 */
ok('.row 允许换行（空间不够就整行换行，不硬挤）',
   /\.row\s*\{[^}]*flex-wrap:\s*wrap/.test(css));
ok('.row > label 有最小宽度（不能被压成一字一行）',
   /\.row\s*>\s*label\s*\{[^}]*min-width:\s*[\d.]+em/.test(css));
ok('.row > label 不用 min-width:0（那正是竖排的成因）',
   !/\.row\s*>\s*label\s*\{[^}]*min-width:\s*0[;\s]/.test(css));
ok('.row select 可收缩（不然它把 label 挤扁）',
   /\.row select\s*\{[^}]*flex:\s*0\s+1\s+auto/.test(css));
ok('预设提示小字不换行（宁可截断也不要竖排）',
   /\.row #remindPresetHint\s*\{[^}]*white-space:\s*nowrap/.test(css));

/* ============================================================
 * [17] 版本一致性：三层错位不能再靠人记得（1.6.2）
 *
 * 工作目录叫 AESystemMonitor-1.6.0、manifest 里写 1.6.2、部署目标没有版本号 ——
 * 这个错位是**有意保留**的（改名要同步归档脚本与三棵树比对路径，代价大于收益，见 VERSION.md）。
 * 但「有意保留」不等于「可以失控」：上一版就是靠 PLUGIN-REPORT.md 里一段散文记着它，
 * 散文会随行号漂移，而版本号会被人手改漏。
 *
 * 所以立一个 VERSION 文件当唯一事实源，manifest 必须与它一致。
 * 改版本时代价是「两处都要改」，收益是漏改任何一处都会当场红 —— 而不是等装进 AE
 * 才发现面板显示的版本和真实代码对不上。
 * ============================================================ */
console.log('\n[17] 版本一致性（VERSION 是唯一事实源）');
{
  ok('VERSION 文件存在', fs.existsSync(path.join(ROOT, 'VERSION')));
  const ver = fs.existsSync(path.join(ROOT, 'VERSION'))
    ? read('VERSION').trim() : '';
  ok('VERSION 是 x.y.z 形状', /^\d+\.\d+\.\d+$/.test(ver), ver || '(空)');

  const bundle = (manifest.match(/ExtensionBundleVersion="([^"]+)"/) || [])[1];
  ok('manifest 的 ExtensionBundleVersion == VERSION',
     bundle === ver, `manifest=${bundle} VERSION=${ver}`);

  const extVers = [...manifest.matchAll(/<Extension\s+Id="([^"]+)"\s+Version="([^"]+)"/g)]
    .map(m => m[2]);
  ok('ExtensionList 至少有一个 Extension', extVers.length > 0, extVers.join(','));
  ok('每个 Extension 的 Version 都 == VERSION',
     extVers.length > 0 && extVers.every(v => v === ver), extVers.join(','));

  ok('VERSION 不带 BOM、不带多余空行', ver === read('VERSION').trim() && ver.indexOf('\ufeff') < 0);

  // 错位本身要**被记录**：说明文件在场，才不会有人看着目录名以为跑的是 1.6.0
  ok('VERSION.md 在场（记录目录名≠实际版本这件事）',
     fs.existsSync(path.join(ROOT, 'VERSION.md')));
}

/* ============================================================
 * [18] 文档里的测试计数 == 实测（2026-10-25 加；2026-10-26 补齐「实测」这一半）
 *
 * 为什么加这一组：上面 [17] 证明「唯一事实源 + 断言」能把版本错位钉死。
 * 而**测试计数**当时还靠人手抄 —— 1.6.2 加完断言没人回填，文档里就留下了
 * 「18 组 815 项」和一句「必须 815/815 才算通过」。跑出 840 的人会以为
 * 测试被改坏了，转头去「修」正确的测试。
 *
 * 所以把计数也钉成断言：**拿实测去和文档对**，而不是把文档当真值抄进测试。
 * 组数从文件系统数（新增测试文件自动纳入）。
 *
 * ⚠️ 2026-10-26 补：上面那句「拿实测去对」原先**没有兑现**。这里当时只抽查两行
 * （backup / wiring），其余行仍是手抄进断言的第二份数字 —— 于是 1.6.4 的
 * settings 行写 45（实际 54）、ui-interaction 行写 41（实际 54），表内「合计」
 * 与各行相加差了 22，**一条断言都没响**，直到人肉算术才发现。
 * 现在改成：除本文件自己（跑自己会无限递归）以外，每个 .test.js 都用 node
 * 子进程**真跑一遍**再逐行比对；另加一条「各行相加 == 表内合计 == 实测总数」。
 * 代价是 [18] 组要花几秒跑子进程 —— 换来的是这类漂移不再只能靠人肉算术发现。
 * ============================================================ */
console.log('\n[18] 文档测试计数与实测一致');
{
  const report = read('PLUGIN-REPORT.md');
  const changelog = read('CHANGELOG.md');
  const readme = read('README.md');

  const testFiles = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.test.js'));
  ok('实测组数 == 文档声称的组数',
     report.includes(`${testFiles.length} 组`) && testFiles.length >= 18,
     `实测 ${testFiles.length} 个 .test.js`);

  /* ---- 逐组表：每一行都拿去和「真的跑一遍」的结果对 ----
   * 本文件自己的断言数只能自指（跑自己会无限递归），所以单独钉 OWN；
   * 其余每个 .test.js 都真跑一遍 —— 文档数字这才第一次真的和**实测**对，
   * 而不是和写在本文件里的另一份手抄数字对。 */
  const OWN = 276;                     // ← 改本文件断言数时手动 +1/-1
  const cp = require('child_process');

  /* ⚠️ 只能扫「逐组表」那一段，不许扫整份报告。
   * 报告后面还有 7.5「换机器数字不变」的历史对比表，里面同样列着
   * `scan.test.js | 11`、`autosave.test.js | 15` 这类**旧版本**的行 ——
   * 扫整份文档会让历史值把当前值覆盖掉（后匹配覆盖先匹配），
   * 报出 scan 11/12、autosave 15/19 的假错，相加也会变成 1053。
   * 2026-10-26 这段第一版就踩了：1.6.4 的 fix_164_docs.py 踩过同一个坑
   * （scan 12→11、autosave 19→15、合计算成 894）。 */
  const t0 = report.indexOf('| 测试 | 项数 | 覆盖什么 |');
  const t1 = report.indexOf('| **合计** |', t0);
  const tableText = (t0 >= 0 && t1 > t0) ? report.slice(t0, t1) : '';
  const rows = [...tableText.matchAll(/\|\s*`([a-z0-9\-]+\.test\.js)`\s*\|\s*(\d+)\s*\|/g)]
    .map(m => [m[1], +m[2]]);
  const table = {};
  rows.forEach(([f, n]) => { table[f] = n; });

  const measured = {};
  const mis = [];
  testFiles.filter(f => f !== 'wiring.test.js').forEach(f => {
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'tests', f)],
                           { encoding: 'utf8', timeout: 300000 });
    const m = /(\d+) 通过[，,]?\s*(\d+) 失败/.exec(r.stdout || '');
    if (!m) { mis.push(`${f} 跑不出来`); return; }
    measured[f] = +m[1];
    if (+m[2]) mis.push(`${f} 自身有 ${m[2]} 条失败`);
  });
  rows.forEach(([f, n]) => {
    if (f === 'wiring.test.js' || measured[f] === undefined) return;
    if (measured[f] !== n) mis.push(`${f} 文档 ${n} / 实测 ${measured[f]}`);
  });
  Object.keys(measured).forEach(f => { if (!table[f]) mis.push(`实测有、表里没有：${f}`); });
  ok('逐组表每一行 == 实测（其余 17 个文件都真跑了一遍）',
     mis.length === 0, mis.length ? mis.join('；') : '17 行全对');

  ok('PLUGIN-REPORT 逐组表 wiring == ' + OWN,
     table['wiring.test.js'] === OWN, '文档 ' + table['wiring.test.js']);

  const stated = +(report.slice(t1 > 0 ? t1 : 0).match(/^\| \*\*合计\*\* \| \*\*(\d+)\*\* \|/) || [])[1];
  const rowSum = rows.reduce((a, [, n]) => a + n, 0);
  const realSum = Object.keys(measured).reduce((a, f) => a + measured[f], 0) + OWN;
  ok('逐组表各行相加 == 表内合计 == 实测总数',
     stated === rowSum && stated === realSum,
     `相加 ${rowSum} / 合计 ${stated} / 实测 ${realSum}`);

  ok('PLUGIN-REPORT 声明「18 组、1003 项断言」',
     /18 组、\*\*1003 项\*\*断言/.test(report));
  ok('PLUGIN-REPORT 的门禁写 1003/1003（不是旧数）',
     /必须 1003\/1003/.test(report));
  ok('CHANGELOG 的 1.6.2 条目保留历史计数 855（历史不改写）',
     /## 1\.6\.2[\s\S]*?18 组 855 项/.test(changelog));
  ok('CHANGELOG 的 1.7.0 条目写 976 项', /## 1\.7\.0[\s\S]*?976 项/.test(changelog));
  ok('CHANGELOG 的 1.7.1 条目写 1003 项',
     /## 1\.7\.1[\s\S]*?1003 项/.test(changelog));
  ok('README 写 1003 项', /1003 项/.test(readme));

  // 旧数一律不许残留：它们正是这次漂移的化石
  // （写成一条断言而不是逐个数一条 —— 断言总数是文档里被引用的数字，别让它悄悄变）
  const stale = ['815', '2868'].filter(n => report.includes(n) || changelog.includes(n) || readme.includes(n));
  ok('文档里不再残留旧计数 815 / 2868', stale.length === 0, stale.length ? '残留 ' + stale.join(',') : '');

  // 行数：文档声称的源码规模也要跟得住 ——
  // 2026-10-26 把这两条也从「文档里有没有这个数」改成「这个数 == 实测」，
  // 否则文档自己写多少都算过（tests 行数原本只查 includes('3514 行')，改了多少它都不响）。
  const lines = p => (read(p).match(/\n/g) || []).length;
  const mainLines = lines('js/main.js');
  ok('PLUGIN-REPORT 的 main.js 行数 == ' + mainLines,
     new RegExp('\\|\\s*`js\\/main\\.js`\\s*\\|\\s*' + mainLines + '\\s*\\|').test(report),
     '实测 ' + mainLines + ' 行');
  const testsLines = fs.readdirSync(path.join(ROOT, 'tests'))
    .filter(f => f.endsWith('.js'))
    .reduce((a, f) => a + lines('tests/' + f), 0);
  ok('PLUGIN-REPORT 的 tests 行数 == ' + testsLines,
     report.includes(testsLines + ' 行'), '实测 ' + testsLines + ' 行');
}

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
