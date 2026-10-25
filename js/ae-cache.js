/* ============================================================
 * ae-cache.js — AE 磁盘缓存探测内核（可独立测试）
 *
 * 加载方式（两边都挂，谁需要谁取）：
 *   · 浏览器 / CEP  : window.AECache
 *   · Node (测试)   : module.exports
 *
 * 注意：不能用标准的「二选一」UMD。CEP 面板在
 * --enable-nodejs + --mixed-context 下会把 Node 的 module 注入页面
 * 上下文，此时 `typeof module === 'object'` 成立，二选一写法会只走
 * CommonJS 分支、不再写 window.AECache，导致面板里取不到内核。
 *
 * 依赖由外部注入（fs / os / path / Buffer），便于单测与跨平台复用。
 * ============================================================ */
(function (root, factory) {
  var api = factory();

  // 1) Node / CEP 的 CommonJS 通道
  try {
    if (typeof module === 'object' && module && module.exports) {
      module.exports = api;
    }
  } catch (e) {}

  // 2) 全局通道：浏览器、以及开着 nodejs 的 CEP 页面都需要
  try {
    if (root) { root.AECache = api; }
    if (typeof window !== 'undefined' && window && window !== root) {
      window.AECache = api;
    }
  } catch (e) {}

  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var MARK = '["Disk Cache Controls"]';
  var SEC_DC = 'Disk Cache Controls';
  var SEC_ADC = 'Additional Disk Cache Controls';
  var DEFAULT_BUFFER_GB = 10;   // Adobe 文档：额外要求的 10 GB 可用空间

  function create(deps) {
    var fs = deps.fs, os = deps.os, path = deps.path, Buf = deps.Buffer;

    /* ---------- 路径文本解码 ---------- */
    // AE 把路径里的非 ASCII 字符写成十六进制，例如 "E4B8AD" => 中
    function decodeAEString(s) {
      if (!s) return s;
      return String(s).replace(/"([0-9A-Fa-f]{4,})"/g, function (m, hex) {
        try {
          var pairs = hex.match(/.{2}/g) || [];
          var bytes = pairs.map(function (h) { return parseInt(h, 16); });
          return Buf.from(bytes).toString('utf8');
        } catch (e) { return m; }
      });
    }

    /* ---------- 版本号 ---------- */
    function cmpVer(a, b) {
      var A = String(a).split('.').map(Number),
          B = String(b).split('.').map(Number);
      for (var i = 0; i < Math.max(A.length, B.length); i++) {
        var x = A[i] || 0, y = B[i] || 0;
        if (x !== y) return x - y;
      }
      return 0;
    }

    function verShort(v) {
      if (!v) return '';
      var m = /^(\d+)\.(\d+)/.exec(String(v));
      return m ? m[1] + '.' + m[2] : String(v);
    }

    /* ---------- 目录列举（兼容老 Node） ----------
       withFileTypes 是 Node 10.10 才有的。AE CC 2017/2018 的 CEP 自带 Node 6~8，
       直接传这个 option 会抛错 —— 一抛错，偏好和缓存全都读不到。
       所以先试新写法，失败就退回「取名字 + stat」。 */
    function listSync(dir) {
      var out = [];
      var d = null;

      try { d = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { d = null; }

      if (d) {
        for (var i = 0; i < d.length; i++) {
          if (!d[i] || typeof d[i] === 'string') continue;
          out.push({ name: d[i].name, isDir: d[i].isDirectory(), isFile: d[i].isFile() });
        }
        return out;
      }

      var names;
      try { names = fs.readdirSync(dir); } catch (e2) { return out; }
      for (var j = 0; j < names.length; j++) {
        var full = path.join(dir, names[j]);
        try {
          var st = fs.statSync(full);
          out.push({ name: names[j], isDir: st.isDirectory(), isFile: st.isFile() });
        } catch (e3) {}
      }
      return out;
    }

    /* ---------- 偏好设置定位 ---------- */
    function prefsRoot() {
      try {
        var home = os.homedir();
        if (process.platform === 'win32') {
          return path.join(home, 'AppData', 'Roaming', 'Adobe', 'After Effects');
        }
        return path.join(home, 'Library', 'Preferences', 'Adobe', 'After Effects');
      } catch (e) { return ''; }
    }

    function versionDirs(root) {
      return listSync(root)
        .filter(function (d) { return d.isDir && /^\d+(\.\d+)?$/.test(d.name); })
        .map(function (d) { return d.name; })
        .sort(cmpVer)
        .reverse();
    }

    // 偏好文件名随界面语言变化（中文是「设置.txt」，英文是 Prefs.txt），
    // 因此不靠文件名，而是读内容找节标记。
    function findPrefsIn(root, ver) {
      var dir = path.join(root, ver);
      var names = listSync(dir)
        .filter(function (d) { return d.isFile && /\.txt$/i.test(d.name); })
        .map(function (d) { return d.name; });

      var re = /prefs|设置|環境設定|präferenzen|préférences|einstellungen|preferencias|preferenze/i;
      names.sort(function (a, b) { return (re.test(a) ? 0 : 1) - (re.test(b) ? 0 : 1); });

      for (var i = 0; i < names.length; i++) {
        var p = path.join(dir, names[i]);
        try {
          if (fs.statSync(p).size > 8 * 1024 * 1024) continue;
          var txt = fs.readFileSync(p, 'utf8');
          if (txt.indexOf(MARK) >= 0) return { path: p, text: txt, ver: ver };
        } catch (e) {}
      }
      return null;
    }

    function sectionOf(text, name) {
      var head = '["' + name + '"]';
      var i = text.indexOf(head);
      if (i < 0) return '';
      var rest = text.slice(i + head.length);
      var next = rest.search(/\r?\n\["/);
      return next >= 0 ? rest.slice(0, next) : rest;
    }

    // 逐行取键值，能正确处理「值里自带引号」的路径
    function lineVal(section, key) {
      var lines = section.split(/\r?\n/);
      var needle = '"' + key + '"';
      for (var i = 0; i < lines.length; i++) {
        var ln = lines[i].trim();
        if (ln.indexOf(needle) !== 0) continue;
        var eq = ln.indexOf('=');
        if (eq < 0) continue;
        var v = ln.slice(eq + 1).trim();
        if (v.charAt(0) === '"') v = v.slice(1);
        if (v.charAt(v.length - 1) === '"') v = v.slice(0, -1);
        return v;
      }
      return null;
    }

    /* ---------- 主入口：读取偏好 ---------- */
    function loadPrefs() {
      var root = prefsRoot();
      var vers = versionDirs(root);
      var found = null;

      for (var i = 0; i < vers.length; i++) {
        var f = findPrefsIn(root, vers[i]);
        if (f) { found = f; break; }
      }
      if (!found) return null;

      var dc = sectionOf(found.text, SEC_DC);
      var ac = sectionOf(found.text, SEC_ADC);

      var folderRaw = lineVal(dc, 'Folder 7');
      var maxRaw = lineVal(dc, 'Max Size 3');
      var enRaw = lineVal(dc, 'Enabled 2');
      var bufRaw = lineVal(ac, 'Minimum Volume Free Space (Gigabytes)');

      var maxGB = parseFloat(maxRaw);
      var bufGB = parseFloat(bufRaw);

      return {
        path: found.path,
        ver: found.ver,
        folder: folderRaw ? decodeAEString(folderRaw).replace(/[\\/]+$/, '') : '',
        maxSizeGB: isFinite(maxGB) ? maxGB : 0,
        enabled: enRaw === null ? true : (enRaw === '1'),
        bufferGB: isFinite(bufGB) ? bufGB : DEFAULT_BUFFER_GB,
        raw: { folder: folderRaw, maxSize: maxRaw, enabled: enRaw, buffer: bufRaw }
      };
    }

    /* ---------- AE 自带自动保存的配置 ----------
       注意：这套配置不在主偏好文件里，而在同目录的 *indep-general.txt。
       实测键名（AE 23/24 一致）：
         ["Auto Save"] "Auto Save Interval" = "20"  "Enable Auto Save3" = "1" ...
       同样不靠文件名判断，因为语言版本不同；只按后缀 *indep-general.txt 找。 */
    function findGeneralPrefs(root, ver) {
      var dir = path.join(root, ver);
      var names = listSync(dir)
        .filter(function (d) { return d.isFile && /indep-general\.txt$/i.test(d.name); })
        .map(function (d) { return d.name; });
      if (!names.length) return null;
      var p = path.join(dir, names[0]);
      try { return { path: p, text: fs.readFileSync(p, 'utf8') }; }
      catch (e) { return null; }
    }

    function loadAutoSavePrefs(prefVer) {
      var root = prefsRoot();
      var ver = '', f = null;

      if (prefVer) { f = findGeneralPrefs(root, prefVer); if (f) ver = prefVer; }
      if (!f) {
        var vers = versionDirs(root);
        for (var i = 0; i < vers.length; i++) {
          f = findGeneralPrefs(root, vers[i]);
          if (f) { ver = vers[i]; break; }
        }
      }
      if (!f) return null;

      var s = sectionOf(f.text, 'Auto Save');
      if (!s) return null;

      var iv = parseFloat(lineVal(s, 'Auto Save Interval'));
      var mv = parseFloat(lineVal(s, 'Auto Save Max Project Vers'));
      var folderRaw = lineVal(s, 'Auto Save Folder');

      return {
        path: f.path,
        ver: ver,
        enabled: lineVal(s, 'Enable Auto Save3') === '1',
        afterRender: lineVal(s, 'Enable Auto Save RQ2') === '1',
        intervalMin: isFinite(iv) ? iv : 20,
        maxVers: isFinite(mv) ? mv : 5,
        folder: folderRaw ? decodeAEString(folderRaw).replace(/[\\/]+$/, '') : ''
      };
    }

    /* 找自动保存目录里最新的一个工程文件。
       目录还没被创建时（从未触发过自动保存）返回 null —— 这本身就是有用的信息。 */
    function latestAutoSave(folder) {
      if (!folder || !isDir(folder)) return null;

      var best = null;
      var stack = [{ p: folder, d: 0 }];
      var guard = 0;

      while (stack.length && guard++ < 500) {
        var cur = stack.pop();
        var ents = listSync(cur.p);
        for (var i = 0; i < ents.length; i++) {
          var e = ents[i];
          var full = path.join(cur.p, e.name);
          if (e.isDir) {
            if (cur.d < 1) stack.push({ p: full, d: cur.d + 1 });
            continue;
          }
          if (!/\.aepx?$/i.test(e.name)) continue;
          try {
            var st = fs.statSync(full);
            if (!best || st.mtimeMs > best.mtime) {
              best = { name: e.name, path: full, mtime: st.mtimeMs, size: st.size };
            }
          } catch (err) {}
        }
      }
      return best;
    }

    /* ---------- 缓存实体目录 ---------- */
    function isDir(p) {
      try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
    }

    function findDirs(base, re, maxDepth) {
      var out = [];
      var stack = [{ p: base, d: 0 }];
      var guard = 0;

      while (stack.length && guard++ < 4000) {
        var cur = stack.pop();
        var ents = listSync(cur.p);
        for (var i = 0; i < ents.length; i++) {
          var e = ents[i];
          if (!e.isDir) continue;
          var full = path.join(cur.p, e.name);
          if (re.test(e.name)) out.push(full);
          if (cur.d < maxDepth) stack.push({ p: full, d: cur.d + 1 });
        }
      }
      return out;
    }

    // 实测结构：<Folder>\Adobe\After Effects\<ver>\Disk Cache - <主机名>.noindex
    function resolveCacheDir(baseFolder, ver) {
      if (!baseFolder) return '';
      var host = '';
      try { host = os.hostname(); } catch (e) {}

      var direct = [];
      if (ver) {
        direct.push(path.join(baseFolder, 'Adobe', 'After Effects', ver,
                              'Disk Cache - ' + host + '.noindex'));
        direct.push(path.join(baseFolder, 'Adobe', 'After Effects', ver));
      }
      if (host) direct.push(path.join(baseFolder, 'Disk Cache - ' + host + '.noindex'));

      for (var i = 0; i < direct.length; i++) {
        if (isDir(direct[i])) return direct[i];
      }

      var deep = findDirs(baseFolder, /^Disk Cache.*\.noindex$/i, 4);
      if (deep.length) {
        deep.sort(function (a, b) {
          var ta = 0, tb = 0;
          try { ta = fs.statSync(a).mtimeMs; } catch (e) {}
          try { tb = fs.statSync(b).mtimeMs; } catch (e) {}
          return tb - ta;
        });
        return deep[0];
      }

      var loose = findDirs(baseFolder, /Disk Cache/i, 3);
      return loose.length ? loose[0] : '';
    }

    /* 同一个缓存盘上，其他 AE 版本留下的缓存目录（不含当前这个）。
       本机实测 AE 23 与 24 各有独立的 Disk Cache - *.noindex，
       只统计当前版本会低估「缓存到底占了多少磁盘」。 */
    function otherVersionCacheDirs(baseFolder, currentDir) {
      if (!baseFolder) return [];

      var aeRoot = path.join(baseFolder, 'Adobe', 'After Effects');
      var vers = versionDirs(aeRoot);
      var cur = String(currentDir || '').toLowerCase();
      var re = /^Disk Cache.*\.noindex$/i;
      var out = [], seen = {};

      function push(d) {
        if (!d) return;
        var key = d.toLowerCase();
        if (seen[key]) return;
        if (cur && key === cur) return;
        seen[key] = 1;
        out.push(d);
      }

      // 标准结构：<aeRoot>/<ver>/Disk Cache - <host>.noindex
      for (var i = 0; i < vers.length; i++) {
        var vdir = path.join(aeRoot, vers[i]);
        var found = findDirs(vdir, re, 1);
        if (found.length) {
          for (var k = 0; k < found.length; k++) push(found[k]);
        } else if (re.test(vers[i])) {
          push(vdir);
        }
      }

      // 兜底：缓存直接放在 Adobe\After Effects 下面（旧版本装法）
      if (!out.length) {
        var flat = findDirs(aeRoot, re, 1);
        for (var j = 0; j < flat.length; j++) push(flat[j]);
      }

      return out;
    }

    /* ---------- 目录体积扫描（异步） ---------- */
    // CEP 内置 Node 版本随宿主变化，极老的版本没有 fs.promises，
    // 或 readdir 不支持 withFileTypes。这里做一层降级，避免扫描静默返回 0。
    var fsp = null;
    try { fsp = (fs && fs.promises) ? fs.promises : null; } catch (e) { fsp = null; }

    function cbPromisify(fn) {
      return function (a, b) {
        return new Promise(function (res, rej) {
          try {
            if (arguments.length >= 0 && b === undefined) {
              fn(a, function (e, v) { e ? rej(e) : res(v); });
            } else {
              fn(a, b, function (e, v) { e ? rej(e) : res(v); });
            }
          } catch (e) { rej(e); }
        });
      };
    }

    var rawStat = (fsp && fsp.stat) ? function (p) { return fsp.stat(p); }
                                   : cbPromisify(fs.stat.bind(fs));

    var readdirCb = cbPromisify(fs.readdir.bind(fs));

    // Node 10.0~10.9 有 fs.promises 但还不认 withFileTypes，因此失败后要再退一步
    var rawReaddir = function (p) {
      if (fsp && fsp.readdir) {
        return fsp.readdir(p, { withFileTypes: true }).catch(function () {
          return fsp.readdir(p);
        });
      }
      return readdirCb(p);
    };

    // 统一成 [{name, isDir, isFile}]，兼容 Dirent 与纯字符串两种返回形态
    function listing(dir) {
      return rawReaddir(dir).then(function (ents) {
        if (!ents || !ents.length) return [];
        if (typeof ents[0] !== 'string') {
          return ents.map(function (e) {
            return { name: e.name, isDir: e.isDirectory(), isFile: e.isFile() };
          });
        }
        return Promise.all(ents.map(function (n) {
          var full = path.join(dir, n);
          return rawStat(full).then(function (st) {
            return { name: n, isDir: st.isDirectory(), isFile: st.isFile() };
          }).catch(function () { return null; });
        })).then(function (arr) { return arr.filter(Boolean); });
      });
    }

    function scanDir(target, opts) {
      opts = opts || {};
      var cap = opts.cap || 250000;
      var hardTimeout = opts.timeout || 30000;

      return new Promise(function (resolve) {
        if (!target || !isDir(target)) {
          resolve({ bytes: 0, files: 0, dirs: 0, truncated: false, expires: false });
          return;
        }

        var total = 0, files = 0, dirs = 0, seen = 0, truncated = false;
        var queue = [target];
        var active = 0, done = false;
        var CONC = 8;

        function finish(expired) {
          if (done) return;
          done = true;
          resolve({ bytes: total, files: files, dirs: dirs, truncated: truncated, expires: !!expired });
        }

        var guard = setTimeout(function () { finish(true); }, hardTimeout);

        function statOne(p) {
          return rawStat(p).then(function (st) {
            total += st.size;
            files++;
          }).catch(function () {});
        }

        function next() {
          if (done) return;
          if (queue.length === 0) {
            if (active === 0) { clearTimeout(guard); finish(false); }
            return;
          }
          var dir = queue.shift();
          active++;

          listing(dir).then(function (ents) {
            var jobs = [];
            for (var i = 0; i < ents.length; i++) {
              seen++;
              if (seen > cap) { truncated = true; break; }
              var e = ents[i];
              if (e.isDir) {
                dirs++;
                queue.push(path.join(dir, e.name));
              } else if (e.isFile) {
                jobs.push(statOne(path.join(dir, e.name)));
              }
            }
            return Promise.all(jobs);
          }).catch(function () {}).then(function () {
            active--;
            next();
          });
        }

        for (var k = 0; k < CONC; k++) next();
        if (queue.length === 0 && active === 0) { clearTimeout(guard); finish(false); }
      });
    }

    return {
      loadPrefs: loadPrefs,
      loadAutoSavePrefs: loadAutoSavePrefs,
      latestAutoSave: latestAutoSave,
      resolveCacheDir: resolveCacheDir,
      otherVersionCacheDirs: otherVersionCacheDirs,
      scanDir: scanDir,
      prefsRoot: prefsRoot,
      versionDirs: versionDirs,
      decodeAEString: decodeAEString,
      verShort: verShort,
      cmpVer: cmpVer,
      sectionOf: sectionOf,
      lineVal: lineVal,
      MARK: MARK,
      DEFAULT_BUFFER_GB: DEFAULT_BUFFER_GB
    };
  }

  return { create: create, DEFAULT_BUFFER_GB: DEFAULT_BUFFER_GB, MARK: MARK };
});
