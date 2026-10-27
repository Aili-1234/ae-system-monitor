/* settings.test.js — 设置归一化测试
 * 重点：localStorage 里的东西可能是任何脏数据，绝不能让面板崩。
 */
const S = require('../js/settings.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };

console.log('[1] 默认值结构');
const d = S.defaults();
ok('autoCollapse 默认开', d.autoCollapse === true);
ok('miniMetric 默认 cache_pct（磁盘缓存已用 %）', d.miniMetric === 'cache_pct');
ok('已移除 sound 字段（不出声）', d.sound === undefined);
ok('water 默认 45 分钟', d.reminders.water.everyMin === 45, d.reminders.water.everyMin);
ok('memHigh 默认阈值 90', d.reminders.memHigh.thresholdPct === 90);
ok('mem 定时播报默认关', d.reminders.mem.on === false);
ok('defaults 返回副本（改不坏源）', (function () {
  const a = S.defaults(); a.reminders.water.everyMin = 999;
  return S.defaults().reminders.water.everyMin === 45;
})());

console.log('\n[2] 脏数据一律退回默认');
ok('null', S.normalize(null).reminders.water.everyMin === 45);
ok('undefined', S.normalize(undefined).reminders.water.on === true);
ok('字符串整体', S.normalize('乱七八糟').reminders.stand.everyMin === 60);
ok('数组', S.normalize([1, 2, 3]).miniMetric === 'cache_pct');
ok('嵌套为 null', S.normalize({ reminders: null }).reminders.water.on === true);
ok('嵌套为字符串', S.normalize({ reminders: 'x' }).reminders.eyes.everyMin === 40);

console.log('\n[3] 数值裁剪');
ok('everyMin 太小 -> 5', S.normalize({ reminders: { water: { everyMin: 0 } } }).reminders.water.everyMin === 5);
ok('everyMin 太大 -> 240', S.normalize({ reminders: { water: { everyMin: 9999 } } }).reminders.water.everyMin === 240);
ok('everyMin 负数 -> 5', S.normalize({ reminders: { water: { everyMin: -30 } } }).reminders.water.everyMin === 5);
ok('everyMin 小数取整', S.normalize({ reminders: { water: { everyMin: 45.6 } } }).reminders.water.everyMin === 46);
ok('everyMin 字符串数字可用', S.normalize({ reminders: { water: { everyMin: '30' } } }).reminders.water.everyMin === 30);
ok('everyMin NaN -> 默认', S.normalize({ reminders: { water: { everyMin: 'abc' } } }).reminders.water.everyMin === 45);
ok('thresholdPct 上限 99', S.normalize({ reminders: { memHigh: { thresholdPct: 200 } } }).reminders.memHigh.thresholdPct === 99);
ok('thresholdPct 下限 50', S.normalize({ reminders: { memHigh: { thresholdPct: 1 } } }).reminders.memHigh.thresholdPct === 50);
ok('sustain 范围 1..30', S.normalize({ reminders: { memHigh: { sustain: 100 } } }).reminders.memHigh.sustain === 30);
ok('cooldownMin 范围 1..180', S.normalize({ reminders: { memHigh: { cooldownMin: 0 } } }).reminders.memHigh.cooldownMin === 1);

console.log('\n[3b] 自定义分钟数不被吸附到固定档位');
ok('37 分钟保持 37', S.normalize({ reminders: { water: { everyMin: 37 } } }).reminders.water.everyMin === 37);
ok('7 分钟保持 7', S.normalize({ reminders: { stand: { everyMin: 7 } } }).reminders.stand.everyMin === 7);
ok('119 分钟保持 119', S.normalize({ reminders: { eyes: { everyMin: 119 } } }).reminders.eyes.everyMin === 119);
ok('1 分钟被抬到下限 5', S.normalize({ reminders: { water: { everyMin: 1 } } }).reminders.water.everyMin === 5);

console.log('\n[4] 布尔与枚举');
ok('on 字符串 "true" 退回默认（严格布尔）',
   S.normalize({ reminders: { water: { on: 'true' } } }).reminders.water.on === true);
ok('on = false 被保留',
   S.normalize({ reminders: { water: { on: false } } }).reminders.water.on === false);
ok('miniMetric 非法值退回 cache_pct', S.normalize({ miniMetric: 'disk' }).miniMetric === 'cache_pct');
ok('miniMetric = mem 迁移到 mem_free_pct', S.normalize({ miniMetric: 'mem' }).miniMetric === 'mem_free_pct');

console.log('\n[4b] 首屏视图 uiDefault（1.6.0 新增）');
ok('默认 compact（极简）', d.uiDefault === 'compact', d.uiDefault);
ok('full 被保留', S.normalize({ uiDefault: 'full' }).uiDefault === 'full');
ok('remember 被保留', S.normalize({ uiDefault: 'remember' }).uiDefault === 'remember');
ok('非法值退回 compact', S.normalize({ uiDefault: 'wide' }).uiDefault === 'compact');
ok('非字符串退回 compact', S.normalize({ uiDefault: 1 }).uiDefault === 'compact');
ok('null 退回 compact', S.normalize({ uiDefault: null }).uiDefault === 'compact');
ok('未设置时退回 compact', S.normalize({}).uiDefault === 'compact');
ok('uiDefault 不影响 ui 本身', S.normalize({ uiDefault: 'full' }).ui.cache === false);

console.log('\n[5] 未知字段被丢弃');
const withExtra = S.normalize({ hack: 1, reminders: { water: { everyMin: 30, evil: 'x' } } });
ok('顶层未知键丢弃', withExtra.hack === undefined);
ok('嵌套未知键丢弃', withExtra.reminders.water.evil === undefined);
ok('已知键正常保留', withExtra.reminders.water.everyMin === 30);

console.log('\n[6] 序列化往返');
const cfg = S.normalize({ reminders: { stand: { on: false, everyMin: 90 } } });
const rt = S.parse(S.stringify(cfg));
ok('roundtrip 一致', JSON.stringify(rt) === JSON.stringify(cfg));
ok('坏 JSON 回默认', S.parse('{oops').reminders.water.everyMin === 45);
ok('空串回默认', S.parse('').autoCollapse === true);

/* ---------- [N] 回退副本目录（1.6.4）：只清理语义，不判合法性 ---------- */
console.log('\n[新] crashGuard.notify 默认静默（1.7.7）');
{
  const d = S.normalize({});
  ok('默认不弹提示', d.crashGuard.notify === false, d.crashGuard.notify);
  ok('可以自己打开', S.normalize({ crashGuard: { notify: true } }).crashGuard.notify === true);
  ok('脏值退回默认（静默）',
     S.normalize({ crashGuard: { notify: 'yes' } }).crashGuard.notify === false);
}

console.log('\n[新] crashGuard.backupDir 归一化');
{
  const d = S.defaults();
  ok('默认是空串（= 用默认位置）', d.crashGuard.backupDir === '');

  const n = (v) => S.normalize({ crashGuard: { backupDir: v } }).crashGuard.backupDir;
  ok('普通路径原样保留', n('D:\\AE 副本') === 'D:\\AE 副本', n('D:\\AE 副本'));
  ok('去掉首尾空白', n('  D:\\AE 副本  ') === 'D:\\AE 副本', n('  D:\\AE 副本  '));
  ok('去掉「复制为路径」带的一对引号', n('"D:\\AE 副本"') === 'D:\\AE 副本', n('"D:\\AE 副本"'));
  ok('去掉结尾反斜杠', n('D:\\AE 副本\\') === 'D:\\AE 副本', n('D:\\AE 副本\\'));
  ok('盘根补回分隔符（D: 不是 D:\\ 就等于没写）', n('D:') === 'D:\\', n('D:'));
  ok('非字符串退回默认（数字/对象/布尔都不认）',
     n(123) === '' && n({}) === '' && n(true) === '', JSON.stringify([n(123), n({}), n(true)]));
  ok('超长截断到 240 字符', n('D:\\' + 'x'.repeat(400)).length === 240);
  ok('控制字符被清掉（粘路径时常见的换行）', n('D:\\AE\n副本') === 'D:\\AE副本', n('D:\\AE\n副本'));
}
console.log('\n[新] 小窗指标可自由选（1.6.5）');
{
  const d = S.defaults();
  ok('默认主显示 cache_pct（磁盘缓存已用）', d.miniMetric === 'cache_pct');
  ok('默认次显示 1 = 内存剩余', d.miniSub1 === 'mem_free_gb');
  ok('默认次显示 2 = 盘够装吗（够 / 偏紧 / 不够）', d.miniSub2 === 'enough');
  ok('默认三格互不重复', S.normalize(S.defaults()).miniSub1 === 'mem_free_gb'
     && S.normalize(S.defaults()).miniSub2 === 'enough');

  const n = (o) => S.normalize(o);
  ok('老值 cache 迁移到 cache_pct', n({ miniMetric: 'cache' }).miniMetric === 'cache_pct');
  ok('老值 mem 迁移到 mem_free_pct', n({ miniMetric: 'mem' }).miniMetric === 'mem_free_pct');
  ok('主显示非法值退回 cache_pct', n({ miniMetric: 'disk' }).miniMetric === 'cache_pct');
  ok('主显示可切 need_pct / disk_free_pct',
     n({ miniMetric: 'need_pct' }).miniMetric === 'need_pct'
     && n({ miniMetric: 'disk_free_pct' }).miniMetric === 'disk_free_pct');

  // 1.6.6：「AE 所需 159GB / 87%」被读成「AE 现在要 159GB」→ 换成上限口径 + 词语指标
  ok('次显示可选「盘够装吗」', n({ miniSub1: 'enough' }).miniSub1 === 'enough');
  ok('旧值 need_pct 在次显示里已淘汰（退回默认 enough，不会静默变空）',
     n({ miniSub1: 'mem_free_gb', miniSub2: 'need_pct' }).miniSub2 === 'enough');
  ok('need_gb 改成上限口径（键还在清单里，名字叫缓存上限）',
     S.MINI_SUB.indexOf('need_gb') >= 0 && S.MINI_LABELS.need_gb === '缓存上限'
     && S.MINI_LABELS.need_pct === '上限占盘比');

  // 「左边那个与上面重复了」：主显示已经是这个指标，次显示就该留空
  ok('次显示与主显示同指标（同单位）→ 留空',
     n({ miniMetric: 'cache_pct', miniSub1: 'cache_gb' }).miniSub1 === 'none');
  ok('百分号版与绝对值版算同一家（内存）',
     n({ miniMetric: 'mem_free_pct', miniSub1: 'mem_free_gb' }).miniSub1 === 'none');
  ok('次显示 2 与次显示 1 重复 → 留空',
     n({ miniSub1: 'disk_free_gb', miniSub2: 'disk_free_gb' }).miniSub2 === 'none');
  ok('不同指标不误伤', n({ miniMetric: 'cache_pct', miniSub1: 'mem_free_gb', miniSub2: 'left_gb' }).miniSub2 === 'left_gb');
  ok('「配额还剩 / 缓存增速 / 多久写满」不算重复（与缓存占用是不同信息）',
     n({ miniMetric: 'cache_pct', miniSub1: 'left_gb', miniSub2: 'rate' }).miniSub2 === 'rate');
  ok('次显示 none 合法', n({ miniSub1: 'none' }).miniSub1 === 'none');
  ok('次显示非法值退回默认（且不与主显示冲突）', n({ miniSub1: 'zzz' }).miniSub1 === 'mem_free_gb');
  ok('主显示换成内存后，默认的「内存剩余」次显示被留空',
     n({ miniMetric: 'mem_free_pct' }).miniSub1 === 'none');

  ok('每个可选指标都有中文短名与单位',
     S.MINI_MAIN.concat(S.MINI_SUB).every(k => !!S.MINI_LABELS[k] && S.MINI_UNITS[k] !== undefined),
     S.MINI_MAIN.concat(S.MINI_SUB).filter(k => !S.MINI_LABELS[k]).join(',') || 'OK');
  ok('fixMini 幂等（反复调用不变形）', (function () {
    const once = S.normalize({ miniMetric: 'cache_pct', miniSub1: 'cache_gb', miniSub2: 'mem_free_gb' });
    const twice = S.fixMini({ miniMetric: once.miniMetric, miniSub1: once.miniSub1, miniSub2: once.miniSub2 });
    return twice.miniSub1 === once.miniSub1 && twice.miniSub2 === once.miniSub2;
  })());
  ok('stringify 也走同一套去重', (function () {
    const s = JSON.parse(S.stringify({ miniMetric: 'mem_free_pct', miniSub1: 'mem_free_gb' }));
    return s.miniSub1 === 'none';
  })());
}
console.log('\n[新] 面板主题（1.7.1）：白名单与默认值');
ok('THEMES 导出七套主题（1.7.4 去掉灰色、象牙白改名白粉），第一套是薄荷绿',
  Array.isArray(S.THEMES) && S.THEMES.length === 7 && S.THEMES[0] === 'mint' && S.THEMES[6] === 'black' &&
  S.THEMES.indexOf('gray') < 0);
ok('主题默认是薄荷绿（= 1.7.0 及以前的样子）', S.defaults().ui.theme === 'mint');
ok('白名单外的主题退回默认（脏数据不写坏值）', S.normalize({ ui: { theme: 'rainbow' } }).ui.theme === 'mint');
ok('每套主题都有中文名与合法色点', S.THEMES.every(t => !!S.THEME_LABELS[t] && /^#[0-9a-f]{6}$/.test(S.THEME_DOTS[t])));
ok('主题只是 ui 里的一个字段，别的 ui 开关不受影响（一次「确定」不会重置展开状态）', (function () {
  const c = S.normalize({ ui: { theme: 'pink', cache: true, guard: true } });
  return c.ui.theme === 'pink' && c.ui.cache === true && c.ui.guard === true;
})());

ok('白粉（原象牙白）/ 雾蓝浅 / 黑色都在白名单里，旧的 ivory 自动迁移到 pinkwhite',
  ['pinkwhite', 'mist', 'black'].every(t => S.THEMES.indexOf(t) >= 0) &&
  S.normalize({ ui: { theme: 'ivory' } }).ui.theme === 'pinkwhite');
ok('黑色那套叫「黑色」（给 AE 原生深色 UI 的那一档）', S.THEME_LABELS.black === '黑色');
ok('白粉那套叫「白粉」（1.7.4：底色比象牙白更白、文字转粉，色点用它自己的底色）',
  S.THEME_LABELS.pinkwhite === '白粉' && S.THEME_DOTS.pinkwhite === '#fffafc');
ok('八套主题各有中文名与合法色点（色点用来画头栏那个小圆）',
  S.THEMES.every(t => !!S.THEME_LABELS[t] && /^#[0-9a-f]{6}$/.test(S.THEME_DOTS[t])));

console.log('\n[新] 主题不会因为「只传了部分 ui 字段」被冲掉（1.7.6 的真因）');
/* normalize 是拿 SCHEMA 把 ui **整块重建**的 —— 没传到的键一律退回 DEFAULTS。
   所以只要有一处写成 `ui: { cache, mem, disk, guard }`（漏掉 theme），
   theme 就会被冲回默认的 'mint'，而且那一处紧接着就 saveCfg() 写盘。
   真机上表现为：改完主题、重开面板又变回薄荷绿。
   下面三条把这个陷阱钉死 —— 前一条描述 bug 的形状，后两条描述修好后的形状。 */
ok('只传四张卡的展开状态 → theme 被静默冲回默认 mint（bug 的形状）',
   S.normalize({ ui: { cache: true, mem: false, disk: false, guard: false } }).ui.theme === 'mint');
ok('把 theme 一起传进去 → 原样保留，展开状态照旧生效', (function () {
  const c = S.normalize({ ui: { cache: true, mem: false, disk: false, guard: false, theme: 'black' } });
  return c.ui.theme === 'black' && c.ui.cache === true;
})());
ok('写盘（stringify）再读回（parse）主题还在 —— 对应「下次启动读回」',
   S.parse(S.stringify({ ui: { cache: false, mem: false, disk: false, guard: false, theme: 'mist' } })).ui.theme === 'mist');

console.log('\n[新] 小窗形态（1.7.6）：默认开 + miniWin 往返 + 脏值回落默认值');
/* 用户原话「装好一打开就该是小窗」「我要一开始就是这个界面，并且可以记忆的」——
   默认值取 true：**装好/首次打开**就是小窗，不是「先手动折一次才记住」；
   手动展开 / 折叠过之后记住，下次开 AE 照上次那个形态起。
   它和 theme 是同一类陷阱：也是顶层字段，将来若有人在某个调用点手写白名单时
   漏掉它，就会被 walk() 按 DEFAULTS 冲掉（形态悄悄丢）。1.7.6 把白名单整个拆成了
   normFromUSR（从整份 USR 出发），所以这里只需钉住默认值、往返与脏值这三条。 */
ok('miniWin 默认开（用户要「装好一打开就是小窗」）', S.defaults().miniWin === true);
ok('miniWin 往返：true 存读仍是 true、false 存读仍是 false（对应「下次启动读回」）',
   S.parse(S.stringify({ miniWin: true })).miniWin === true &&
   S.parse(S.stringify({ miniWin: false })).miniWin === false);
ok('miniWin 的脏值一律回落默认值 true（字符串 / 数字 / null）',
   S.normalize({ miniWin: 'yes' }).miniWin === true &&
   S.normalize({ miniWin: 1 }).miniWin === true &&
   S.normalize({ miniWin: null }).miniWin === true);

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
