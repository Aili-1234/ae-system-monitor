/* ============================================================
 * optimize.test.js — A/B 两档优化的回归测试
 *   node tests/optimize.test.js
 *
 * 覆盖三件容易在后续改动里被悄悄退回去的事：
 *   1. 手动上限 / 保存日志开关收进了 settings.js 的 schema（不再是裸 localStorage）
 *   2. 「其他版本缓存」能枚举出来，且不会把当前目录算进去
 *   3. main.js 里几条关键的降频/降级路径还在（静态断言，防止被误删）
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

const S = require(path.join(ROOT, 'js', 'settings.js'));
const AECache = require(path.join(ROOT, 'js', 'ae-cache.js'));
const AE = AECache.create({ fs, os, path, Buffer });

let pass = 0, fail = 0;
const ok = (n, c, x) => {
  c ? pass++ : fail++;
  console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`);
};

console.log('\n[1] 手动上限进了 settings schema');
const d = S.defaults();
ok('默认 0 = 自动检测', d.quotaGB === 0, d.quotaGB);
ok('给了正数就用它', S.normalize({ quotaGB: 149 }).quotaGB === 149);
ok('超上限被裁到 4000', S.normalize({ quotaGB: 99999 }).quotaGB === 4000);
ok('负数被裁到 0（回到自动）', S.normalize({ quotaGB: -50 }).quotaGB === 0);
ok('小数取整', S.normalize({ quotaGB: 12.6 }).quotaGB === 13);
ok('脏字符串退回默认', S.normalize({ quotaGB: 'abc' }).quotaGB === 0);
ok('布尔值不当数字用', S.normalize({ quotaGB: true }).quotaGB === 0);

console.log('\n[2] 保存日志开关进了 settings schema');
ok('默认开启记录', d.crashGuard.log === true);
ok('可以关掉', S.normalize({ crashGuard: { log: false } }).crashGuard.log === false);
ok('严格布尔（"false" 不算）',
   S.normalize({ crashGuard: { log: 'false' } }).crashGuard.log === true);
ok('关掉日志不影响保存本身',
   S.normalize({ crashGuard: { log: false, autoSave: true } }).crashGuard.autoSave === true);

console.log('\n[3] 序列化往返仍然一致');
const rt = S.parse(S.stringify(S.normalize({ quotaGB: 320, crashGuard: { log: false } })));
ok('roundtrip 保留上限', rt.quotaGB === 320, rt.quotaGB);
ok('roundtrip 保留开关', rt.crashGuard.log === false);

console.log('\n[4] 其他版本缓存目录');
{
  /* 用 fixture 造两套 AE 的缓存目录，**不依赖本机装没装 AE**。
     原来这里直接 loadPrefs()，在 CI runner 上读不到偏好就整组 SKIP，
     于是 6 条断言在两个平台上的数量对不齐（本机 429 / runner 423）。
     现在改成 fixture：本机与 runner 跑出来的数字必须完全一致。 */
  const F = require('./_fixture');
  const fx = F.makeFixture({ files: 3, sizeEach: 512 });

  try {
    const AEf = AECache.create({ fs, os: fx.osStub, path, Buffer });
    const prefs = AEf.loadPrefs();
    if (!prefs) throw new Error('fixture 没造出可读的偏好，检查 _fixture.js');

    const cur = AEf.resolveCacheDir(prefs.folder, AEf.verShort(prefs.ver));

    // 再造一套「更老版本」的缓存目录，用来验证它会被枚举到、且当前目录不会被算进去
    const oldVer = '23.0';
    const oldDir = path.join(prefs.folder, 'Adobe', 'After Effects', oldVer,
                             'Disk Cache - ' + fx.host + '.noindex');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'chunk.aecache'), Buffer.alloc(64, 0x41));

    const others = AEf.otherVersionCacheDirs(prefs.folder, cur);
    console.log('  当前: ' + cur);
    others.forEach(p => console.log('  其他: ' + p));

    ok('枚举到那套更老版本的缓存', others.length === 1, others.length + ' 个');
    ok('去重（同一路径只出现一次）',
       new Set(others.map(p => p.toLowerCase())).size === others.length);
    ok('不包含当前目录',
       others.every(p => p.toLowerCase() !== String(cur).toLowerCase()));
    ok('返回的目录都真实存在', others.every(p => fs.existsSync(p)));
    ok('名字都像缓存目录', others.every(p => /Disk Cache/i.test(path.basename(p))));
    ok('路径里带的是 23.0 而不是当前版本',
       others.length === 1 && /23\.0/.test(others[0]), others[0] || '');
  } finally {
    fx.cleanup();
  }
}

console.log('\n[5] 异常输入不崩');
ok('空串返回空数组', JSON.stringify(AE.otherVersionCacheDirs('', '')) === '[]');
ok('undefined 返回空数组', JSON.stringify(AE.otherVersionCacheDirs(undefined)) === '[]');
ok('不存在的目录返回空数组',
   JSON.stringify(AE.otherVersionCacheDirs('Z:\\nope\\nope', '')) === '[]');

console.log('\n[6] main.js 里关键路径没被退回旧实现');
const mainJs = read('js/main.js');
ok('磁盘优先走 fs.statfsSync（无子进程）', /fs\.statfsSync/.test(mainJs));
ok('PowerShell 仅作降级', /function readDisks\(\)[\s\S]{0,600}?disksStatfs\(\)[\s\S]{0,400}?disksWindows\(\)/.test(mainJs));
ok('磁盘读数带 TTL', /diskTTL/.test(mainJs) && /function updateDisks/.test(mainJs));
ok('磁盘失败时保留上次读数', /沿用/.test(mainJs) && /disksErr/.test(mainJs));
ok('历史不再写死 200 点', !/slice\(-200\)/.test(mainJs));
ok('历史跟随 trend 的 MAX_POINTS', /Trend\.MAX_POINTS/.test(mainJs));
ok('渲染中降频', /renderInterval/.test(mainJs) && /function effectiveInterval/.test(mainJs));
ok('面板隐藏时降频', /visibilitychange/.test(mainJs) && /hiddenInterval/.test(mainJs));
ok('渲染中缩短心跳超时', /aeTimeoutRender/.test(mainJs));
ok('数值未变跳过重绘', /function renderSig/.test(mainJs) && /ST\.sig/.test(mainJs));
ok('曲线也不重复重画', /sparkKey/.test(mainJs));
ok('保存日志写入磁盘', /saves\.log/.test(mainJs) && /appendFileSync/.test(mainJs));
ok('日志写入可关', /function logEnabled/.test(mainJs));
ok('面板显示日志位置', /logHint/.test(mainJs) && /btnOpenLog/.test(mainJs));
ok('启动时读回上一份日志', /function loadSaveLog/.test(mainJs));
ok('不再裸存 sysmon.quota', !/localStorage\.setItem\('sysmon\.quota'/.test(mainJs));
ok('旧键会被迁移并删除', /function migrateQuota/.test(mainJs) &&
   /removeItem\('sysmon\.quota'\)/.test(mainJs));
ok('其他版本缓存串行扫描', /function scanOtherVersions/.test(mainJs));

console.log('\n[7] 预览模式与 hidden 开关（1.4.0 顺手修的两处）');
const css = read('css/style.css');
const html0 = read('index.html');
ok('driveOf 不再无条件读 process', /typeof process !== 'undefined'/.test(mainJs));
ok('driveOf 用路径兜底判断盘符', /test\(String\(p\)\)/.test(mainJs));
ok('CSS 显式压制 [hidden] 的 display 覆盖', /\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/.test(css));
ok('抽屉默认带 hidden 属性', /<aside class="drawer" id="drawer" hidden>/.test(html0));
ok('抽屉宽度仍受面板宽约束', /width:\s*min\(286px,\s*88vw\)/.test(css));

console.log('\n[8] 新增元素在 HTML 里且被引用');
const html = read('index.html');
['otherCache', 'btnOther', 'gdSaves', 'cbSaveLog', 'logHint', 'btnOpenLog'].forEach(id => {
  ok('存在 #' + id, new RegExp('id="' + id + '"').test(html));
  ok('  main.js 用到了 #' + id, new RegExp("\\$\\('" + id + "'\\)").test(mainJs));
});

console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
