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

    /* ---------- 主入口：读取偏好 ----------
       版本必须与「运行中的 AE」对齐。本机 AE 23（115 GB）与 24（149 GB）并存，
       若永远取最高版本，开 2023 时会拿 24 的配额去算填充率与余量 ——
       而且错的方向是「看起来更安全」，最难被发现的那种错。

       选择顺序（三段回退：总能读到值，但如实标记是否精确）：
         1) 与运行版本精确匹配
         2) 不高于运行版本的最高版本
         3) 全局最高版本
       app.version 形如 24.2.1，而目录名是 24.2，所以一律先过 verShort()。 */
    function pickPrefs(root, wantVer) {
      var vers = versionDirs(root);                        // 已降序
      var want = wantVer ? verShort(wantVer) : '';
      var order = [], seen = {};

      function add(v) {
        if (!v || seen[v]) return;
        seen[v] = 1;
        order.push(v);
      }

      if (want) {
        add(want);                                         // 1) 精确
        for (var i = 0; i < vers.length; i++) {            // 2) 不高于运行版本
          if (cmpVer(vers[i], want) <= 0) add(vers[i]);
        }
        for (var j = 0; j < vers.length; j++) add(vers[j]);  // 3) 全局（含更高版本）
      } else {
        for (var k = 0; k < vers.length; k++) add(vers[k]);
      }

      for (var n = 0; n < order.length; n++) {
        var f = findPrefsIn(root, order[n]);
        if (f) {
          return {
            found: f,
            want: want,
            // true 精确 / false 回退 / null 不知道运行版本
            matched: want ? (cmpVer(order[n], want) === 0) : null
          };
        }
      }
      return null;
    }

    function loadPrefs(runningVer, opts) {
      opts = opts || {};
      var root = opts.root || prefsRoot();                 // opts.root 只为测试注入
      var pick = pickPrefs(root, runningVer);
      if (!pick) return null;

      var found = pick.found;                              // { path, text, ver }

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
        runVer: pick.want,          // 运行版本（空串 = 还没拿到 app.version）
        verMatched: pick.matched,   // true 精确 / false 回退 / null 未知
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

    /* ---------- 本机崩溃史 ----------
       崩溃的「残留证据」比任何预测都有说服力，而且它能区分机器：
       一年崩一次的机器 vs 每天崩两次的机器，同一个「3 小时前崩过」意义完全不同。

       Windows 把每次 APPCRASH / APPHANG 落成一个目录：
         %ProgramData%\Microsoft\Windows\WER\ReportArchive\AppCrash_AfterFX.exe_<hash>
         （也有用户级的 %LOCALAPPDATA%\Microsoft\Windows\WER\ReportArchive）
       注意：Windows 会清理旧报告，所以次数只能当「至少」，不能当完整历史。
       AE 自己的 <prefsRoot>\<ver>\logs 在 Windows 上常是空的（实测本机 0 个文件），
       所以以 WER 为主。 */

    function crashRoots() {
      var roots = [];
      if (typeof process === 'undefined' || !process.env) return roots;
      if (process.env.ProgramData) {
        roots.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'));
      }
      if (process.env.LOCALAPPDATA) {
        roots.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'WER', 'ReportArchive'));
      }
      return roots;
    }

    /* WER 的异常代码 → 人话。写在这里而不是 UI 里，因为它是事实层面的解释 */
    var CRASH_CODES = {
      'c0000374': '堆损坏（常见于第三方插件/内存越界）',
      'c0000005': '访问冲突（读了非法地址）',
      'c0000409': '栈缓冲区溢出',
      'c00000fd': '栈溢出',
      'c0000017': '内存不足（无法分配）',
      'c0000135': '缺少依赖 DLL',
      '80000003': '断言失败（断点）'
    };

    function crashCodeText(code) {
      if (!code) return '';
      var k = String(code).toLowerCase().replace(/^0x/, '');
      return CRASH_CODES[k] || '';
    }

    /* 把所有 AfterFX 的崩溃目录扫出来（不去重、不排序以外的处理） */
    function scanCrashDirs(roots) {
      var out = [];
      var seen = {};
      for (var r = 0; r < roots.length; r++) {
        var ents = listSync(roots[r]);          // 无权限时 listSync 自己吞掉
        for (var i = 0; i < ents.length; i++) {
          var e = ents[i];
          if (!e.isDir) continue;
          if (!/AfterFX|After Effects/i.test(e.name)) continue;
          var full = path.join(roots[r], e.name);
          var st = null;
          try { st = fs.statSync(full); } catch (err) { continue; }
          var key = full.toLowerCase();
          if (seen[key]) continue;
          seen[key] = 1;
          out.push({ dir: full, mtime: st.mtimeMs, name: e.name });
        }
      }
      return out;
    }

    /* 读 Report.wer 里的类型 / 异常代码 / 故障模块。
       WER 写的是 UTF-16LE，按 utf8 读会变成一堆 NUL、正则永远匹配不上，
       所以按 BOM，再用 NUL 密度兜底。 */
    function parseWer(dir) {
      var code = '', mod = '', type = '';
      try {
        var buf = fs.readFileSync(path.join(dir, 'Report.wer'));
        var txt;
        if (buf.length > 1 && buf[0] === 0xFF && buf[1] === 0xFE) {
          txt = buf.toString('utf16le');
        } else if (buf.length > 2 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
          txt = buf.slice(3).toString('utf8');
        } else {
          var nul = 0, probe = Math.min(buf.length, 400);
          for (var bi = 0; bi < probe; bi++) if (buf[bi] === 0) nul++;
          txt = (nul > probe / 4) ? buf.toString('utf16le') : buf.toString('utf8');
        }
        var mType = /^EventType=(.+)$/m.exec(txt);
        if (mType) type = /hang/i.test(mType[1]) ? 'hang' : 'crash';
        var mCode = /^Sig\[6\]\.Value=(.+)$/m.exec(txt);
        if (mCode) code = mCode[1].trim();
        var mMod = /^Sig\[3\]\.Value=(.+)$/m.exec(txt);
        if (mMod) mod = mMod[1].trim();
      } catch (e) {}
      return { type: type, code: code, module: mod };
    }

    /* 本机崩溃画像：
         hoursAgo     最近一次距今几小时（null = 没有任何记录）
         count30      近 30 天次数
         count7       近 7 天次数
         medianGapH   相邻两次的中位间隔（小时，≥2 次才有；null = 算不出）
         tier         机器脾气：none / rare / occasional / chronic / unknown
         last         最近一次的类型与异常代码
       这些数用来给判定「定标尺」——同样 3 小时前崩过，
       对一年崩一次的机器是异常，对每天崩两次的机器只是日常。 */
    function crashHistory(opts) {
      opts = opts || {};
      var now = isFinite(opts.now) ? opts.now : Date.now();
      var roots = opts.roots || crashRoots();

      var dirs = scanCrashDirs(roots);
      if (!dirs.length) return null;

      dirs.sort(function (a, b) { return b.mtime - a.mtime; });

      var H = 3600000, D = 24 * H;
      var count7 = 0, count30 = 0;
      for (var i = 0; i < dirs.length; i++) {
        var age = now - dirs[i].mtime;
        if (age <= 7 * D) count7++;
        if (age <= 30 * D) count30++;
      }

      // 中位间隔：只取 30 天内的相邻间隔，避开很久以前的偶发记录把标尺拉歪
      var gaps = [];
      for (var j = 0; j + 1 < dirs.length; j++) {
        if (now - dirs[j + 1].mtime > 30 * D) break;
        var g = (dirs[j].mtime - dirs[j + 1].mtime) / H;
        if (g > 0) gaps.push(g);
      }
      gaps.sort(function (a, b) { return a - b; });
      var medianGapH = null;
      if (gaps.length) {
        var mid = Math.floor(gaps.length / 2);
        // 偶数个取中间两个的平均，别偏向上半区
        medianGapH = (gaps.length % 2)
          ? gaps[mid]
          : (gaps[mid - 1] + gaps[mid]) / 2;
      }

      var newest = dirs[0];
      var hrs = (now - newest.mtime) / H;
      var wer = parseWer(newest.dir);
      var type = wer.type || (/^AppHang/i.test(newest.name) ? 'hang' : 'crash');

      var count30Safe = count30;
      var tier = count30Safe <= 0 ? 'none'
               : count30Safe === 1 ? 'rare'
               : count30Safe <= 4 ? 'occasional'
               : 'chronic';

      return {
        hoursAgo: hrs >= 0 ? hrs : 0,
        count7: count7,
        count30: count30Safe,
        medianGapH: medianGapH,
        tier: tier,
        total: dirs.length,
        last: {
          time: newest.mtime,
          hoursAgo: hrs >= 0 ? hrs : 0,
          type: type,
          code: wer.code,
          codeText: crashCodeText(wer.code),
          module: wer.module,
          dir: newest.dir
        }
      };
    }

    /* 只要最近一次（保持旧接口，内部复用 crashHistory） */
    function latestCrash(opts) {
      var h = crashHistory(opts);
      return h ? h.last : null;
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
    function resolveCacheDir(baseFolder, ver, opts) {
      opts = opts || {};
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

      // 严格模式只认上面这些精确位置。
      // 用途：两个版本都装着时，深度兜底会挑「最近改动」的那个目录，
      // 而那很可能是另一个版本的 —— 宁可返回空，让调用方按版本再试一次。
      if (opts.strict) return '';

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
      pickPrefs: pickPrefs,
      loadAutoSavePrefs: loadAutoSavePrefs,
      latestAutoSave: latestAutoSave,
      latestCrash: latestCrash,
      crashHistory: crashHistory,
      crashCodeText: crashCodeText,
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
