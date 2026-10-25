/* ============================================================
 * compat.test.js — 老版本 CEP 内置 Node 的兼容性
 *
 * 背景：AE 的面板跑在 CEP 的 Node 里，而这个 Node 版本跟着 AE 走。
 *   AE CC 2017/2018  → Node 6~8   （没有 fs.promises，readdir 不认 withFileTypes）
 *   AE CC 2019~2021  → Node 10~12 （有 fs.promises，10.10 之后才认 withFileTypes）
 *   AE 2022+         → Node 14+
 * 这里把 fs 换成「残缺版」，验证核心读取不会因此全线失效。
 * ============================================================ */
const realFs = require('fs');
const os = require('os');
const path = require('path');
const AECache = require(path.join(__dirname, '..', 'js', 'ae-cache.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

/* 造一个「残缺的 fs」：
   noWithTypes    = readdirSync 收到 withFileTypes 就抛错（Node < 10.10）
   noPromises     = 没有 fs.promises（Node < 10）
   fspNoWithTypes = fs.promises 存在但不认 withFileTypes（Node 10.0~10.9） */
function brokenFs(opts) {
  const f = {
    statSync: function () { return realFs.statSync.apply(realFs, arguments); },
    readFileSync: function () { return realFs.readFileSync.apply(realFs, arguments); },
    existsSync: function () { return realFs.existsSync.apply(realFs, arguments); },
    stat: realFs.stat.bind(realFs),
    readdir: realFs.readdir.bind(realFs),
    readdirSync: function (p, o) {
      if (opts.noWithTypes && o && o.withFileTypes) {
        throw new Error('ERR_INVALID_ARG_VALUE: withFileTypes is not supported');
      }
      return realFs.readdirSync(p, o);
    }
  };

  if (!opts.noPromises) {
    f.promises = {
      stat: realFs.promises.stat.bind(realFs.promises),
      readdir: function (p, o) {
        if (opts.fspNoWithTypes && o && o.withFileTypes) {
          return Promise.reject(new TypeError('withFileTypes is not supported'));
        }
        return realFs.promises.readdir(p, o);
      }
    };
  }

  return f;
}

const VARIANTS = {
  '现代 Node 22':        { noWithTypes: false, noPromises: false },
  '无 withFileTypes':    { noWithTypes: true,  noPromises: false },
  '无 fs.promises':      { noWithTypes: true,  noPromises: true  },
  'promises 不认选项':   { noWithTypes: false, noPromises: false, fspNoWithTypes: true }
};

console.log('\n[1] 各版本下都能读到缓存偏好');
const prefsResults = {};
for (const [label, opts] of Object.entries(VARIANTS)) {
  const AE = AECache.create({ fs: brokenFs(opts), os, path, Buffer });
  const p = AE.loadPrefs();
  prefsResults[label] = p;
  ok(label + ' 读到偏好', !!p, p ? ('上限 ' + p.maxSizeGB + ' GB') : 'null');
  if (p) {
    ok('  上限 = 149', p.maxSizeGB === 149, p.maxSizeGB);
    ok('  中文用户名解码正确', p.folder.indexOf('李') >= 0 || p.folder.indexOf(os.userInfo().username) >= 0, p.folder);
  }
}

console.log('\n[2] 各版本下都能读到 AE 自动保存配置');
for (const [label, opts] of Object.entries(VARIANTS)) {
  const AE = AECache.create({ fs: brokenFs(opts), os, path, Buffer });
  const a = AE.loadAutoSavePrefs();
  ok(label + ' 读到自动保存配置', !!a, a ? (a.intervalMin + ' 分 / ' + a.maxVers + ' 版') : 'null');
}

console.log('\n[3] 各版本下目录扫描结果一致');
const base = AECache.create({ fs: realFs, os, path, Buffer });
const prefs = base.loadPrefs();
if (!prefs) {
  console.log('  SKIP  本机无 AE 偏好，跳过扫描比对');
} else {
  const dir = base.resolveCacheDir(prefs.folder, base.verShort(prefs.ver));
  console.log('  目标: ' + dir);

  (async () => {
    const ref = await base.scanDir(dir, { cap: 250000 });
    console.log('  基准: ' + (ref.bytes / 1073741824).toFixed(2) + ' GB / ' + ref.files + ' 文件');
    ok('基准确实扫到了内容', ref.files > 0, ref.files);

    for (const [label, opts] of Object.entries(VARIANTS)) {
      const AE = AECache.create({ fs: brokenFs(opts), os, path, Buffer });
      const r = await AE.scanDir(dir, { cap: 250000 });
      ok(label + ' 扫描结果与基准一致',
         r.files === ref.files && Math.abs(r.bytes - ref.bytes) < 1024,
         (r.bytes / 1073741824).toFixed(2) + ' GB / ' + r.files);
    }

    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
  })();
}
