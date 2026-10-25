/* 扫描逻辑双路径验证：
 *   1) 正常路径：fs.promises + Dirent
 *   2) 降级路径：伪造一个没有 fs.promises、readdir 只返回字符串数组的老 Node
 * 两者都应得到同样的 1.47GB / 608 文件。
 */
const fs = require('fs');
const path = require('path');
const mod = require('../js/ae-cache.js');
const { makeFixture } = require('./_fixture.js');

// 用 fixture 造一棵确定的缓存树（6 个文件 × 1 KB），而不是扫本机真实缓存：
// 否则「本机没装 AE」时整组会误报失败，CI 上必红。
const fx = makeFixture({ files: 6, sizeEach: 1024 });

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${x !== undefined ? '  -> ' + x : ''}`); };
const GB = 1073741824;

/* 构造“老 Node”版 fs：抽掉 promises，readdir 回退为字符串数组 */
function makeLegacyFs() {
  const legacy = Object.create(null);
  for (const k of Object.keys(fs)) legacy[k] = fs[k];
  delete legacy.promises;

  const origReaddir = fs.readdir.bind(fs);
  legacy.readdir = function (p, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null; }
    // 模拟老行为：忽略 withFileTypes，只返回名称字符串
    return origReaddir(p, function (e, list) {
      if (e) return cb(e);
      cb(null, list.map(it => (typeof it === 'string' ? it : it.name)));
    });
  };

  const origStat = fs.stat.bind(fs);
  legacy.stat = function (p, cb) { return origStat(p, cb); };
  return legacy;
}

/* 独立的基准实现：用最朴素的同步递归统计，作为对照答案 */
function groundTruth(root) {
  let bytes = 0, files = 0;
  (function walk(d) {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        try { bytes += fs.statSync(full).size; files++; } catch (err) {}
      }
    }
  })(root);
  return { bytes, files };
}

(async () => {
  const base = mod.create({ fs, os: fx.osStub, path, Buffer });
  const prefs = base.loadPrefs();
  ok('fixture 偏好可读', !!prefs, prefs ? prefs.ver : 'null');
  const dir = fx.cacheDir;
  console.log('目标目录: ' + dir + '\n');

  const truth = groundTruth(dir);
  console.log(`基准值（独立实现）: ${(truth.bytes / GB).toFixed(2)} GB / ${truth.files} 文件\n`);

  console.log('[1] 正常路径（fs.promises + Dirent）');
  const t1 = Date.now();
  const r1 = await base.scanDir(dir, { cap: 250000 });
  console.log(`  耗时 ${Date.now() - t1} ms`);
  ok('体积与基准一致', Math.abs(r1.bytes - truth.bytes) <= Math.max(truth.bytes * 0.001, 4096),
     (r1.bytes / GB).toFixed(2) + ' GB');
  ok('文件数与基准一致', r1.files === truth.files, r1.files);
  ok('未截断', r1.truncated === false);
  ok('未超时', r1.expires === false);

  console.log('\n[2] 降级路径（无 fs.promises，readdir 返回字符串）');
  const legacy = mod.create({ fs: makeLegacyFs(), os: fx.osStub, path, Buffer });
  const t2 = Date.now();
  const r2 = await legacy.scanDir(dir, { cap: 250000 });
  console.log(`  耗时 ${Date.now() - t2} ms`);
  ok('体积与正常路径一致', Math.abs(r2.bytes - r1.bytes) <= r1.bytes * 0.001,
     (r2.bytes / GB).toFixed(2) + ' GB');
  ok('文件数与正常路径一致', r2.files === r1.files, r2.files);
  ok('未截断', r2.truncated === false);
  ok('未超时', r2.expires === false);

  console.log('\n[3] 边界情况');
  const empty = await base.scanDir('C:\\__不存在的目录__', {});
  ok('不存在的目录返回全 0', empty.bytes === 0 && empty.files === 0);
  const none = await base.scanDir('', {});
  ok('空路径不抛异常', none.bytes === 0);
  const tiny = await base.scanDir(dir, { cap: 3 });
  ok('cap 极小时标记截断', tiny.truncated === true, 'files=' + tiny.files);

  console.log(`\n===== ${pass} 通过, ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
