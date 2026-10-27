/* ============================================================
 * AE System Monitor — 面板主逻辑
 *
 * 核心命题：AE 内置缓存（Disk Cache）到底需要多少磁盘空间？
 *
 * 判定依据（Adobe 官方规则 + 实测偏好文件）：
 *   AE 要求缓存盘上：可用空间 ≥ 缓存上限 + 安全缓冲(默认 10 GB)
 *   不满足时 AE 会在打开工程/预览时提示磁盘空间不足。
 *
 * 缓存探测逻辑在 js/ae-cache.js（可独立单测），本文件只管展示与调度。
 * ============================================================ */
(function () {
  'use strict';

  /* ---------------- 运行环境 ---------------- */
  var os = null, execSync = null, exec = null, fs = null, pathmod = null, Buffer_ = null;
  var hasNode = false;
  var hasCEP = !!window.__adobe_cep__;

  try {
    os = require('os');
    execSync = require('child_process').execSync;
    exec = require('child_process').exec;
    fs = require('fs');
    pathmod = require('path');
    Buffer_ = require('buffer').Buffer;
    hasNode = true;
  } catch (e) {
    hasNode = false;
  }

  var AE = null;
  if (hasNode && window.AECache) {
    AE = window.AECache.create({ fs: fs, os: os, path: pathmod, Buffer: Buffer_ });
  }

  var GB = 1073741824;

  var CFG = {
    defaultInterval: 3000,
    renderInterval: 12000,  // 渲染中降到这个间隔（主线程紧张时不跟它抢）
    hiddenInterval: 30000,  // 面板不可见时的间隔
    aeTimeout: 3000,        // 问 AE 状态的心跳超时
    aeTimeoutRender: 1500,  // 渲染中只等这么久，问不到就当主线程被占死
    diskTTL: 30000,         // 磁盘读数多久取一次（statfs 很便宜，但没必要时时取）
    otherCacheTTL: 600000,  // 其他版本缓存目录的扫描间隔（10 分钟）
    histMax: 60,
    ramWarn: 68,
    ramBad: 86,
    diskWarn: 80,
    diskBad: 90,
    cacheTTL: 25000,       // 缓存目录重扫间隔
    mediaTTL: 120000,      // 媒体缓存重扫间隔
    scanCap: 250000,
    psTimeout: 12000,
    defaultBufferGB: 10,
    saveLogMax: 400,       // 日志最多保留多少行
    savesShown: 5          // 面板上显示最近几次保存
  };

  var ST = {
    timer: null,
    timerIv: 0,               // 当前定时器用的间隔（用来判断要不要重设定时器）
    interval: CFG.defaultInterval,
    hist: [],
    mem: null,
    disks: [],
    disksAt: 0,               // 上次成功读到磁盘的时间
    disksErr: '',             // 上次读取失败的原因（用于标「读数过期」）
    other: { dirs: [], bytes: 0, files: 0, scanned: 0 },  // 其他版本缓存合计
    saves: [],                // 保存日志（最近若干条，来自 sysmon-saves.log）
    sig: '',                  // 上一轮渲染的数据指纹，用于跳过重复重绘
    sparkKey: '',
    ae: null,
    projectPath: '',
    prefs: null,
    prefsFor: '',             // 上面那份偏好是为哪个运行版本读的（'' = 还没拿到 app.version）
    commitPct: NaN,           // 提交内存占用率（%）；NaN = 还没取到
    commitAt: 0,
    commitBusy: false,
    crash: null,              // 最近一次 AE 崩溃 { hoursAgo, code, codeText, module, time }
    crashProfile: null,       // 本机崩溃画像 { count30, count7, medianGapH, tier, ... }
    crashAt: 0,
    lastAt: null,
    busy: false,
    quotaOverride: null,
    demo: false,

    cache: {
      path: '', prefsPath: '', prefFolder: '', prefQuotaGB: 0,
      prefsVer: '', prefsMatched: null, runVer: '',
      enabled: true, bufferGB: CFG.defaultBufferGB,
      used: 0, files: 0, scanned: 0, truncated: false,
      drive: '', driveFreeGB: NaN, driveTotalGB: NaN,
      quotaGB: 0, quotaSrc: '', usedGB: 0, fillPct: 0,
      needGB: 0, leftGB: 0, marginGB: NaN, verdict: 'na',
      error: ''
    },

    media: { path: '', used: 0, files: 0, scanned: 0 },

    /* 工程改动状态。d 三态：1 有改动 / 0 无 / null 取不到 */
    proj: { d: null, rev: 0, rq: 0, alive: true },
    guardRev: 0,              // 上次保存时的 revision（dirty 取不到时的兜底基线）
    guard: {
      risk: 0, level: 'ok', reasons: [], blocked: '', suggest: false,
      saved: 0, savedAt: 0, lastErr: '', saving: false, saveMs: 0,
      lastBackup: '', backupErr: ''
    },
    autoSave: null,           // AE 自带自动保存配置
    lastAutoSaved: null,      // 自动保存目录里最新的文件
    lastAutoSavedAt: 0,

    cacheHist: [],            // [{t, b}] 缓存体积采样，用于估算增速
    renderMuted: 0,           // 渲染期间被静音的提醒条数
    prevRq: 0                 // 上一轮的渲染状态，用于判断"渲染刚结束"
  };

  /* ---------------- 用户设置 / 提醒引擎 ---------------- */
  var Settings = window.SysmonSettings || null;
  var Reminder = window.SysmonReminder || null;
  var Guard = window.SysmonGuard || null;
  var Trend = window.SysmonTrend || null;
  var Backup = window.SysmonBackup || null;

  var CFG_KEY = 'sysmon.cfg';
  var USR = null;             // 归一化后的用户设置
  var ENG = null;             // 提醒调度引擎
  var compact = false;        // 是否折叠为小窗
  var autoCollapsed = false;  // 是否由「自动折叠」触发（用于拖宽时自动还原）
  var rmQueue = [];           // 待显示提醒
  var rmCur = null;           // 当前显示的提醒
  var rmTimer = null;
  var rmTick = null;

  var grd = null;             // 崩溃保护判定器（js/guard.js）
  var guardBusy = false;      // 一次保存请求进行中，避免叠加

  /* ---------------- 设置持久化 ----------------
     1.7.5：设置不再只存 localStorage。

     为什么改：CEP 面板的 localStorage 由 CEF profile 管理，**进程退出时的刷盘时机
     不由页面控制**。实测（真机 + 真 CEP）：改完主题点 ✕ 关掉、甚至立刻完全退出 AE，
     重开后 sysmon.cfg 可能还是旧值 —— 表现为「主题/设置变回默认」。
     同一台机器上，saves.log（走 Node fs）却能可靠幸存。差别只在存储通道。

     所以：**文件为主，localStorage 降级为缓存**。
       · 写：先写文件（writeFileSync 立即落盘），再顺带写一份 localStorage。
       · 读：文件优先；文件不存在或读坏了，回退 localStorage。
       · 非 CEP（浏览器预览 hasNode=false）：自动退回纯 localStorage，行为与改前一致。
     存的是同一份规范化 JSON，两个通道内容一致，不引入第二套 schema。

     路径与 saves.log 同目录：%LOCALAPPDATA%\AESystemMonitor\settings.json */
  function cfgFilePath() {
    if (!hasNode || !fs || !pathmod) return '';
    try {
      var dir = localDataDir();
      return dir ? pathmod.join(dir, 'settings.json') : '';
    } catch (e) { return ''; }
  }

  function readCfgFile() {
    var p = cfgFilePath();
    if (!p) return '';
    try {
      if (!fs.existsSync(p)) return '';
      var s = fs.readFileSync(p, 'utf8');
      return (s && s.trim()) ? s : '';
    } catch (e) { return ''; }
  }

  function writeCfgFile(text) {
    var p = cfgFilePath();
    if (!p) return false;
    try {
      fs.mkdirSync(pathmod.dirname(p), { recursive: true });
      fs.writeFileSync(p, text, 'utf8');
      return true;
    } catch (e) { return false; }
  }

  function loadCfg() {
    if (!Settings) { USR = null; return; }

    // 1) 文件优先 —— 这是唯一能扛住 CEP 进程退出的通道
    var fromFile = readCfgFile();
    if (fromFile) {
      USR = Settings.parse(fromFile);
      // 文件读到了，但 localStorage 可能是旧的（老版本写下的）或是空的。
      // 两种情况都回写一次，让两个通道对齐，避免下次回退时读到旧值。
      try {
        if (localStorage.getItem(CFG_KEY) !== fromFile) localStorage.setItem(CFG_KEY, fromFile);
      } catch (e) {}
      return;
    }

    // 2) 回退 localStorage（老版本升级上来的第一次启动走这里）
    var raw = '';
    try { raw = localStorage.getItem(CFG_KEY) || ''; } catch (e) {}
    USR = raw ? Settings.parse(raw) : Settings.defaults();

    // 3) 迁移：把 localStorage 里的设置搬进文件，之后就走文件通道。
    //    迁移失败不影响本次使用（USR 已经是对的），也不清 localStorage。
    if (raw) {
      var norm = Settings.stringify(USR);
      if (writeCfgFile(norm)) {
        try { localStorage.setItem(CFG_KEY, norm); } catch (e) {}
      }
    }
  }

  function saveCfg() {
    if (!USR || !Settings) return;
    var text = Settings.stringify(USR);
    // 先写文件：失败也不阻断，localStorage 仍是一层可用兜底
    writeCfgFile(text);
    try { localStorage.setItem(CFG_KEY, text); } catch (e) {}
  }

  /* 归一化时一律从**整份 USR** 出发，只覆盖本次要改的键（1.7.6）。
     老写法是每个调用点手写一份白名单，把 USR 的字段一个个列出来 —— 漏掉哪个键，
     walk() 就会把它按 DEFAULTS 冲掉。用户的主题就是这么被冲回薄荷绿的
     （settings.js 里那条「放 ui 里就不必在 7 处白名单各补一行」的注释，正是
     当年为了绕开这个脆弱点而做的取舍 —— 绕过去的两处就成了漏网之鱼）。
     改成从整份 USR 出发后，新增字段不必再去 7 个地方各补一行。 */
  function normFromUSR(over) {
    var base = {}, k;
    for (k in USR) if (Object.prototype.hasOwnProperty.call(USR, k)) base[k] = USR[k];
    for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
    return Settings.normalize(base);
  }

  /* 用户手动折叠 / 展开后把形态记进配置（1.7.6）。只在**手动**切换时写：
     checkAutoCollapse() 的自动折叠跟着面板宽度走，写进去会污染这个语义。 */
  function rememberMini() {
    if (!USR) return;
    USR = normFromUSR({ miniWin: !!compact });
    saveCfg();
  }

  /* ---------------- 基础工具 ---------------- */
  function $(id) { return document.getElementById(id); }
  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function fmtBytes(n, digits) {
    if (n === null || n === undefined || !isFinite(n)) return '--';
    var u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'], i = 0, v = Math.abs(n);
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    var d = (digits === null || digits === undefined) ? (i >= 3 ? 1 : 0) : digits;
    return v.toFixed(d) + ' ' + u[i];
  }

  function fmtGB(g) {
    if (!isFinite(g)) return '--';
    if (g >= 100) return g.toFixed(0) + ' GB';
    if (g >= 10) return g.toFixed(1) + ' GB';
    return g.toFixed(2) + ' GB';
  }

  function pctOf(a, b) { return b ? clamp(a / b * 100, 0, 100) : 0; }

  function colorBy(p, warn, bad) {
    if (p >= bad) return 'var(--bad)';
    if (p >= warn) return 'var(--warn)';
    return null;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shortPath(p) {
    if (!p) return '—';
    var s = String(p);
    try {
      var home = os.homedir();
      if (home && s.toLowerCase().indexOf(home.toLowerCase()) === 0) {
        s = '~' + s.slice(home.length);
      }
    } catch (e) {}
    if (s.length <= 44) return s;
    var parts = s.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 2) return s;
    return '…\\' + parts.slice(-2).join('\\');
  }

  /* 提示框（吐司）。
     1.6.0 起必须**落在面板自己的显示框内**（#toastHost 是 .app 里的定位容器），
     不能用 position:fixed 挂在 body 上 —— CEP 面板是停靠面板，
     fixed 会以视口为基准，窄侧栏下提示框会溢出到面板外，
     按钮就点不到了。
     2. pointer-events 必须在 .show 时恢复为 auto。
     1.5.0 引入动作按钮（取回上一版）时漏了这一步，
     按钮渲染出来了但永远点不动 —— 这次一并修掉。 */
  function toast(msg, action) {
    var host = $('toastHost');
    if (!host) host = document.body;

    var t = document.createElement('div');
    t.className = 'toast';
    var message = document.createElement('span');
    message.className = 'toast-msg';
    message.textContent = msg;
    t.appendChild(message);
    if (action && action.label && typeof action.run === 'function') {
      var btn = document.createElement('button');
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.onclick = function (ev) {
        if (ev && ev.stopPropagation) ev.stopPropagation();
        action.run();
        dismiss();
      };
      t.appendChild(btn);
    }

    var timer = null;
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      t.classList.remove('show');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 180);
    }

    host.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    // 有动作按钮的给足 5 秒；纯提示 2.6 秒
    timer = setTimeout(dismiss, action ? 5000 : 2600);

    // 点击空白处也能关掉（带按钮时更容易误点，空白点击是明确意图）
    t.onclick = function () {
      if (!action) dismiss();
    };

    // 同一个面板里最多留 3 条，超出的从最旧的开始清
    var kids = host.children;
    while (kids.length > 3) {
      var old = kids[0];
      host.removeChild(old);
      kids = host.children;
    }

    return t;
  }

  /* ---------------- 磁盘查询 ---------------- */
  function disksWindows() {
    var psCmd =
      "@(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType=3' " +
      "| Select-Object DeviceID,Size,FreeSpace) | ConvertTo-Json -Compress";

    var out = execSync(
      'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + psCmd + '"',
      { encoding: 'utf8', windowsHide: true, timeout: CFG.psTimeout }
    );

    out = (out || '').replace(/^\uFEFF/, '').trim();
    if (!out) return [];

    var data = JSON.parse(out);
    if (!Array.isArray(data)) data = [data];

    return data.map(function (d) {
      return { name: d.DeviceID || '?', total: Number(d.Size) || 0, free: Number(d.FreeSpace) || 0 };
    }).filter(function (d) { return d.total > 0; })
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  }

  function disksNix() {
    var raw = execSync('df -k -P', { encoding: 'utf8', timeout: 8000 });
    var lines = raw.split('\n').slice(1);
    var seen = {}, list = [];

    lines.forEach(function (line) {
      var p = line.trim().split(/\s+/);
      if (p.length < 6) return;
      var mount = p.slice(5).join(' ');
      var keep = mount === '/' || mount === '/home' || mount === '/Users' ||
                 mount.indexOf('/Volumes/') === 0;
      if (!keep || seen[mount]) return;
      seen[mount] = 1;

      var total = Number(p[1]) * 1024;
      var avail = Number(p[3]) * 1024;
      if (!total || !isFinite(total)) return;

      list.push({
        name: mount === '/' ? '系统盘' : mount.replace('/Volumes/', ''),
        total: total,
        free: avail
      });
    });
    return list;
  }

  /* 一级取数：Node 原生 statfs（Node 18.15+ 才有，CEP 11 / AE 24 带的就是 18）。
     比 spawn 一个 PowerShell 便宜两个数量级：不建进程、不解析 JSON。 */
  function statfsVol(root) {
    if (!hasNode || typeof fs.statfsSync !== 'function') return null;
    try {
      var s = fs.statfsSync(root);
      var bs = Number(s.bsize), blocks = Number(s.blocks), avail = Number(s.bavail);
      if (!bs || !blocks) return null;
      return { total: bs * blocks, free: Math.max(0, bs * avail) };
    } catch (e) { return null; }
  }

  function disksStatfs() {
    var out = [];

    if (process.platform === 'win32') {
      // 盘符没有别的读法：逐个字母试，不存在的盘 statfs 会抛错，成本仅一次系统调用
      var letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ';
      for (var i = 0; i < letters.length; i++) {
        var ch = letters.charAt(i);
        var v = statfsVol(ch + ':\\');
        if (v && v.total > 0) out.push({ name: ch + ':', total: v.total, free: v.free });
      }
    } else {
      var roots = ['/'];
      try {
        fs.readdirSync('/Volumes').forEach(function (n) {
          if (n.charAt(0) === '.') return;
          var p = '/Volumes/' + n;
          try { if (fs.statSync(p).isDirectory()) roots.push(p); } catch (e) {}
        });
      } catch (e) {}
      for (var j = 0; j < roots.length; j++) {
        var r = statfsVol(roots[j]);
        if (r && r.total > 0) {
          out.push({
            name: roots[j] === '/' ? '系统盘' : roots[j].replace('/Volumes/', ''),
            total: r.total,
            free: r.free
          });
        }
      }
    }

    return out.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  }

  /* 二级降级：老 Node 没有 statfs，才退回 PowerShell / df 子进程 */
  function readDisks() {
    if (!hasNode) return [];

    var list = [];
    try { list = disksStatfs(); } catch (e) { list = []; }
    if (list.length) return list;

    try {
      return process.platform === 'win32' ? disksWindows() : disksNix();
    } catch (e) { return []; }
  }

  /* 带 TTL 的取数：失败时保留上一次的有效读数，只标注它已经过期，
     不把整块磁盘卡片变成「—」（核心指标不该被一次瞬时失败抹掉）。 */
  function updateDisks(force) {
    if (!hasNode) return;

    var now = Date.now();
    if (!force && ST.disksAt && (now - ST.disksAt) < CFG.diskTTL) return;

    var list = [];
    try { list = readDisks(); } catch (e) { list = []; }

    if (list.length) {
      ST.disks = list;
      ST.disksAt = now;
      ST.disksErr = '';
    } else {
      ST.disksErr = '读取失败' + (ST.disksAt ? '，沿用 ' + agoText(ST.disksAt) + '的读数' : '');
    }
  }

  function driveOf(p) {
    if (!p) return null;
    var key = '';
    // 预览模式（浏览器里直接打开 index.html）没有 process：
    // 不抛错，改用路径本身判断是不是 Windows 盘符
    var win = (typeof process !== 'undefined')
      ? process.platform === 'win32'
      : /^[A-Za-z]:[\\/]/.test(String(p));

    if (win) {
      var m = /^([A-Za-z]):/.exec(p);
      if (!m) return null;
      key = (m[1] + ':').toUpperCase();
    } else {
      key = '系统盘';
    }

    for (var i = 0; i < ST.disks.length; i++) {
      if (String(ST.disks[i].name).toUpperCase() === key) return ST.disks[i];
    }
    return null;
  }

  /* ---------------- 内存 ---------------- */
  function readMem() {
    if (!hasNode) return null;
    var total = os.totalmem(), free = os.freemem();
    return { total: total, free: free, used: total - free, pct: pctOf(total - free, total) };
  }

  /* ---------------- AE 信息 ---------------- */
  // AE 侧统一回「k=v&k=v」纯文本：ExtendScript 是 ES3，老版本没有全局 JSON
  function parseKV(s) {
    var o = {}, str = String(s === undefined || s === null ? '' : s).trim();
    if (!str) return null;

    var parts = str.split('&');
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq < 0) continue;
      var k = parts[i].slice(0, eq).trim();
      var v = parts[i].slice(eq + 1);
      if (k === 'p' || k === 'v' || k === 'err') {
        try { v = decodeURIComponent(v); } catch (e) {}
      } else {
        v = Number(v);
      }
      o[k] = v;
    }
    return o;
  }

  function parseAE(raw) {
    var o = parseKV(raw);
    if (!o || o.ok === undefined) return null;
    return {
      v: o.v || '',
      n: o.n || 0,
      p: o.p || '',
      d: o.ok ? 1 : 0,
      dirty: (o.d === 1) ? 1 : (o.d === 0 ? 0 : null),
      rev: o.r || 0,
      rq: o.rq ? 1 : 0
    };
  }

  function readAE(cb) {
    if (!hasCEP) { cb(null); return; }

    // 全部内联：即使 host.jsx 装载失败，状态读取仍然可用（保存才依赖 host.jsx）
    var jsx = '(function(){' +
      'var ok=0,d=-1,rev=0,num=0,rq=0,path="",ver="",err="";' +
      'try{ver=String(app.version||"")}catch(e){}' +
      'try{if(app.project){ok=1;num=app.project.numItems||0;' +
        'try{if(app.project.file)path=String(app.project.file.fsName||"")}catch(e){}' +
        'try{var dv=app.project.dirty;if(dv===true)d=1;else if(dv===false)d=0;else d=-1}catch(e){d=-1}' +
        'try{rev=app.project.revision||0}catch(e){}' +
        'try{if(app.project.renderQueue&&app.project.renderQueue.rendering)rq=1}catch(e){}' +
      '}}catch(e){ok=0;err=String(e)}' +
      'return "ok="+ok+"&d="+d+"&r="+rev+"&n="+num+"&rq="+rq+' +
        '"&p="+encodeURIComponent(path)+"&v="+encodeURIComponent(ver)+"&err="+encodeURIComponent(err)' +
    '})()';

    var done = false;
    function finish(v) { if (!done) { done = true; cb(v); } }

    try {
      window.__adobe_cep__.evalScript(jsx, function (res) {
        finish(parseAE(res));
      });
    } catch (e) { finish(null); }
    // 渲染中主线程被占死，等 3 秒只是白等：超时改成 1.5 秒，让面板早点收手
    var wait = (ST.proj.rq === 1) ? CFG.aeTimeoutRender : CFG.aeTimeout;
    setTimeout(function () { finish(null); }, wait);
  }

  /* ---------------- 渲染中静音 ---------------- */
  function renderRenderBadge() {
    var b = $('renderBadge');
    if (!b) return;
    var on = ST.proj.rq === 1;
    b.hidden = !on;
    b.className = 'badge mute';
    if (on) {
      b.textContent = '渲染中 · 静音' + (ST.renderMuted ? ' ' + ST.renderMuted : '');
      b.title = ST.renderMuted
        ? '渲染期间已静音 ' + ST.renderMuted + ' 条提醒；结束后提醒重新计时，不会补响'
        : '渲染期间不弹提醒，结束后恢复';
    }
  }

  /* ---------------- 缓存增速采样 ---------------- */
  var HIST_KEY = 'sysmon.cacheHist';

  function loadHist() {
    if (!Trend) return;
    try {
      var a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      if (!Array.isArray(a)) return;
      ST.cacheHist = a.filter(function (p) {
        return p && isFinite(p.t) && isFinite(p.b) && p.b >= 0;
      }).map(function (p) {
        // 老版本的历史点没有 m（余量），统一补 null：marginRate 会跳过它们并退回旧算法
        var m = Number(p.m);
        return {
          t: Number(p.t),
          b: Number(p.b),
          m: (p.m === null || p.m === undefined || !isFinite(m)) ? null : m
        };
      });
    } catch (e) { ST.cacheHist = []; }
  }

  function saveHist() {
    // 上限跟 trend 模块保持一致：写死 200 会让重启后的历史比设计值短一半
    var max = (Trend && Trend.MAX_POINTS) ? Trend.MAX_POINTS : 480;
    try {
      localStorage.setItem(HIST_KEY, JSON.stringify(ST.cacheHist.slice(-max)));
    } catch (e) {}
  }

  // 只在真正扫到内容时记样本：0 字节的采样会算出一个假的暴跌
  function sampleCache() {
    if (!Trend) return;
    var c = ST.cache;
    if (!c.path || c.error) return;
    if (!c.used && !c.files) return;

    var before = ST.cacheHist.length;
    // 同时记下余量：ETA 用余量的斜率算，缓存斜率只用来解释原因
    Trend.push(ST.cacheHist, Date.now(), c.used, {
      marginGB: isFinite(c.marginGB) ? c.marginGB : null
    });
    if (ST.cacheHist.length !== before) saveHist();
  }

  /* ---------------- 缓存指标计算 ---------------- */
  function computeMetrics() {
    var c = ST.cache;

    var d = driveOf(c.path);
    c.drive = d ? d.name : '';
    c.driveFreeGB = d ? d.free / GB : NaN;
    c.driveTotalGB = d ? d.total / GB : NaN;

    if (ST.quotaOverride) {
      c.quotaGB = ST.quotaOverride;
      c.quotaSrc = '手动设定';
    } else if (c.prefQuotaGB > 0) {
      c.quotaGB = c.prefQuotaGB;
      c.quotaSrc = (c.prefsVer ? 'AE ' + c.prefsVer + ' 首选项' : 'AE 首选项') +
                   (c.prefsMatched === false ? '（版本不匹配，可能不准）' : '');
    } else if (isFinite(c.driveTotalGB)) {
      // Adobe 文档：默认 = 卷容量的 10%，上限 100 GB
      c.quotaGB = Math.min(c.driveTotalGB * 0.10, 100);
      c.quotaSrc = 'Adobe 默认公式';
    } else {
      c.quotaGB = 0;
      c.quotaSrc = '';
    }

    c.usedGB = c.used / GB;
    c.fillPct = c.quotaGB > 0 ? clamp(c.usedGB / c.quotaGB * 100, 0, 100) : 0;
    c.needGB = c.quotaGB + c.bufferGB;
    c.leftGB = Math.max(0, c.quotaGB - c.usedGB);

    // 余量 = 磁盘可用 − 所需空间。负数表示 AE 已经无法吃满缓存配额。
    c.marginGB = (isFinite(c.driveFreeGB) && c.quotaGB > 0)
      ? c.driveFreeGB - c.needGB
      : NaN;

    if (!isFinite(c.driveFreeGB)) {
      c.verdict = 'na';
    } else if (c.driveFreeGB >= c.needGB) {
      c.verdict = 'ok';
    } else if (c.driveFreeGB >= c.quotaGB) {
      c.verdict = 'warn';
    } else {
      c.verdict = 'bad';
    }
  }

  /* ---------------- 渲染：缓存主卡 ---------------- */
  function renderCache() {
    var c = ST.cache;

    $('cacheUsed').textContent = c.used ? fmtBytes(c.used) : '0 B';
    $('cachePct').textContent = c.quotaGB ? c.fillPct.toFixed(1) + '% 已填' : '';

    $('quotaBtn').innerHTML = (c.quotaGB ? Math.round(c.quotaGB) : '--') + '<em>GB</em>';
    $('quotaBtn').title = '来源：' + (c.quotaSrc || '未知') + '　点击修改';

    var bar = $('cacheBar');
    bar.style.width = c.fillPct.toFixed(1) + '%';
    bar.style.background = colorBy(c.fillPct, 85, 97) || 'var(--accent)';

    $('kLeft').textContent = c.quotaGB ? fmtGB(c.leftGB) : '--';
    $('kNeed').textContent = c.quotaGB ? fmtGB(c.needGB) : '--';
    $('kFree').textContent = isFinite(c.driveFreeGB) ? fmtGB(c.driveFreeGB) : '--';

    // 余量：最该看的那个数字。负数是好事还是坏事？
    // 负数 = 磁盘可用已经不够「上限 + 缓冲」，AE 会报警 —— 用红色。
    var mgEl = $('kMargin');
    if (isFinite(c.marginGB)) {
      mgEl.textContent = (c.marginGB < 0 ? '−' : '+') + fmtGB(Math.abs(c.marginGB));
      mgEl.style.color = c.marginGB < 0 ? 'var(--bad)'
                       : (c.marginGB < 5 ? 'var(--warn)' : '');
      mgEl.title = c.marginGB < 0
        ? '磁盘可用比所需空间少 ' + fmtGB(Math.abs(c.marginGB)) + '，AE 会提示磁盘空间不足'
        : '距离 AE 提示「磁盘不足」还有 ' + fmtGB(c.marginGB);
    } else {
      mgEl.textContent = '--';
      mgEl.style.color = '';
      mgEl.title = '';
    }

    var pill = $('cacheVerdict');
    var map = {
      ok:   ['ok',   '空间充足'],
      warn: ['warn', '空间偏紧'],
      bad:  ['bad',  '空间不足'],
      na:   ['na',   '未知']
    };
    var v = map[c.verdict] || map.na;
    pill.className = 'pill ' + v[0];
    pill.textContent = v[1];

    var pEl = $('cachePath');
    if (c.path) {
      pEl.textContent = shortPath(c.path);
      pEl.title = c.path + '　（' + c.files + ' 个文件' +
                  (c.truncated ? '，扫描已截断' : '') + '）';
    } else {
      pEl.textContent = c.error === 'no-prefs'
        ? '未找到 AE 偏好设置，无法定位缓存目录'
        : '未定位到缓存目录（可能尚未启用磁盘缓存）';
      pEl.title = c.prefFolder || '';
    }

    // 这份数字是从哪个版本的首选项读来的？
    // 版本错配时数字会「看起来更安全」（配额偏大→填充率偏低→余量偏高），
    // 静默发生比报错更糟，所以必须写在面板上，而不是塞进 tooltip。
    var psEl = $('prefsSrc');
    if (psEl) {
      var txt, warn = false, tip = '';
      if (!ST.prefs) {
        txt = '未找到 AE 首选项';
        warn = true;
        tip = '让 AE 打开一次「首选项 → 媒体和磁盘缓存」并确定，偏好文件才会写出来';
      } else if (c.prefsMatched === false) {
        txt = '未找到 ' + (c.runVer || '当前版本') + ' 首选项，暂用 ' +
              (c.prefsVer || '其它版本') + '（配额可能不准）';
        warn = true;
        tip = ST.prefs.path;
      } else {
        txt = '来源：' + (c.quotaSrc || ('AE ' + (c.prefsVer || '') + ' 首选项'));
        tip = ST.prefs.path;
      }
      psEl.textContent = txt;
      psEl.title = tip;
      if (warn) psEl.classList.add('warn'); else psEl.classList.remove('warn');
    }

    var rt = $('cacheRate');
    if (rt) {
      if (!Trend) {
        rt.textContent = '';
      } else {
        var d = Trend.describe(ST.cacheHist, c.marginGB);
        rt.textContent = d.text;
        rt.className = 'crate' + (d.level === 'bad' ? ' bad' : d.level === 'warn' ? ' warn' : '');
        rt.title = '按最近 2 小时的采样估算：ETA 用「余量」的斜率，' +
                   '缓存斜率只用来判断是不是缓存在吃盘';
      }
    }

    renderMini();
    renderMiniStats();
  }

  /* 环形进度（1.7.0）：原先是 conic-gradient 背景（Chromium 69+），现在画在
     内联 SVG 上 —— r=15.9155 整圆周长 100，进度就是 stroke-dashoffset 100-p。
     颜色仍然走 --rc（CSS 里 .arc-fg 的 stroke 读它），这里只在需要时覆盖。 */
  function setArc(ringId, pct, col) {
    var ring = $(ringId);
    if (!ring || !ring.querySelector) return;
    var v = isFinite(pct) ? clamp(pct, 0, 100) : 0;
    var fg = ring.querySelector('.arc-fg');
    if (fg) {
      fg.style.strokeDashoffset = (100 - v).toFixed(2);
      fg.style.stroke = col || '';
    }
    /* 1.7.2：小窗改成「双层环」—— 进度画在**内圈**（r=12.6，周长 2πr ≈ 79.17），
       外圈只留一条更暗的轨道。主面板那个环仍是单圈，所以这里只在 .arc-in 存在时才写。 */
    var inner = ring.querySelector('.arc-in');
    if (inner) inner.style.strokeDashoffset = (79.17 * (1 - v / 100)).toFixed(2);
  }

  /* ---------------- 渲染：内存 ---------------- */
  function renderMem() {
    var m = ST.mem, ring = $('ramRing');

    if (!m) {
      $('ramPct').textContent = '--';
      $('ramUsed').textContent = '-- / --';
      $('ramFree').textContent = '空闲 --';
      ring.style.setProperty('--p', 0);
      setArc('ramRing', 0, '');
      return;
    }

    var p = Math.round(m.pct);
    var col = colorBy(m.pct, CFG.ramWarn, CFG.ramBad) || 'var(--accent)';

    $('ramPct').textContent = p + '%';
    $('ramPct').style.color = col;
    ring.style.setProperty('--p', p.toFixed(1));
    ring.style.setProperty('--rc', col);
    setArc('ramRing', p, col);

    $('ramUsed').textContent = fmtBytes(m.used) + ' / ' + fmtBytes(m.total);
    $('ramFree').textContent = '空闲 ' + fmtBytes(m.free);

    // 展开区的两项：提交内存是 AE 分配失败的关键，别藏在 tooltip 里
    var ce = $('memCommit');
    if (ce) ce.textContent = isFinite(ST.commitPct) ? ST.commitPct.toFixed(0) + '%' : '--';
    var fe = $('memFree');
    if (fe) fe.textContent = fmtBytes(m.free);

    renderMini();
    renderMiniStats();
  }

  /* ---------------- 小窗指标表（1.6.5） ----------------
   * 可选指标的清单只有一处 —— settings.js 的 MINI_MAIN / MINI_SUB / MINI_LABELS，
   * 这里只补三件事：怎么取值、什么时候变色、配哪个图标。
   * 图标是手绘内联 SVG（10×10 viewBox、1px 描边、不填充）—— 面板可能跑在没有网的机器上，
   * 也刻意不引图标字体：多一个外部依赖就多一种「这里怎么空白了」的可能。
   */
  var MI_ICONS = {
    /* 1.7.2：小窗图标全部改**实心** —— 细线图标在 6~9px 下糊成一团（用户：「第二个确实看不见」）。
       颜色一律走 CSS 的 color（fill/stroke 用 currentColor），所以**跟着主题走**：
       常态取 --mini-ico（7 套主题各一套值），告警态由 .ms.on / .ms.bad 换 color。
       1.7.2 同时去掉 1.7.1 的深蓝边缘描边（用户：「图标深蓝色描边去了」）。 */
    cache: '<rect x="1.2" y="1.9" width="7.6" height="1.7" rx=".85" fill="currentColor"/><rect x="2.5" y="4.15" width="6.3" height="1.7" rx=".85" fill="currentColor"/><rect x="3.8" y="6.4" width="3.9" height="1.7" rx=".85" fill="currentColor"/>',
    mem:   '<rect x="1.3" y="2.7" width="7.4" height="4.6" rx="1" fill="currentColor"/>',
    need:  '<path d="M5 1.5 8.1 4.9H6.4v3H3.6v-3H1.9z" fill="currentColor"/><rect x="1.6" y="8.1" width="6.8" height="1.5" rx=".75" fill="currentColor"/>',
    disk:  '<path d="M5 1.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2zm0 2.2a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8z" fill="currentColor" fill-rule="evenodd"/>',
    left:  '<rect x="1.2" y="2.9" width="6.1" height="4.2" rx="1" fill="currentColor"/><rect x="7.7" y="4.4" width="1.3" height="1.2" rx=".4" fill="currentColor"/>',
    rate:  '<path d="M1.4 7.9 3.9 5.2l1.9 1.7 2.9-3.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.4 3.1h2.4v2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
    eta:   '<circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 3.1v2.1l1.6 1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
  };

  // Settings 万一没加载出来，也要显示得出中文而不是裸的键名
  var MI_LABELS = {
    cache_pct: '缓存已用', cache_gb: '缓存已用', mem_free_pct: '内存可用', mem_free_gb: '内存可用',
    need_pct: '上限占盘比', need_gb: '缓存上限', left_gb: '配额还剩', disk_free_pct: '磁盘可用',
    disk_free_gb: '磁盘可用', enough: '盘够装吗', rate: '缓存增速', eta: '多久写满', none: '不显示'
  };

  // cache_pct / cache_gb 落到同一个「实心层叠块」图标（1.7.1 三片细线 → 1.7.2 三片实心）
  function miIconKey(key) { return String(key || '').replace(/_(pct|gb)$/, ''); }
  function miIcon(key) { return MI_ICONS[miIconKey(key)] || ''; }

  function miLabel(key) {
    var L = (Settings && Settings.MINI_LABELS) || {};
    return L[key] || MI_LABELS[key] || key;
  }

  function miBytes(n) {
    if (!isFinite(n)) return '--';
    // 两格各约 33px：带空格的「12.4 GB」会被截断，所以空格去掉；
    // 「142.0GB」的小数点尾巴也去掉 —— 整数值省两位，142GB 比 142.0GB 好读
    return fmtBytes(n).replace(/\s+/g, '').replace(/\.0([A-Z]+)$/, '$1');
  }

  // leftGB / needGB / driveFreeGB 是「GB 数值」而不是字节 —— 直接塞给按字节缩放的 miBytes，
  // 142 GB 会显示成「142B」（1.6.5 用户当场看出来的就是这个）。要显示这几个字段就走 miGB。
  function miGB(n) {
    if (!isFinite(n)) return '--';
    return miBytes(n * GB);
  }

  // need = 上限 + 缓冲；除以缓存盘余量 —— 超过 100% 意味着 AE 根本写不满缓存
  function miNeedPct() {
    var c = ST.cache;
    return (c && isFinite(c.needGB) && isFinite(c.driveFreeGB) && c.driveFreeGB > 0)
      ? c.needGB / c.driveFreeGB * 100 : NaN;
  }
  function miDiskFreePct() {
    var c = ST.cache;
    return (c && isFinite(c.driveFreeGB) && isFinite(c.driveTotalGB) && c.driveTotalGB > 0)
      ? c.driveFreeGB / c.driveTotalGB * 100 : NaN;
  }

  /* 变色方向有两种：缓存占用是「越高越糟」，余量类是「越低越糟」。
     同一对阈值 + 一个 high 开关就够，免得每个指标各写一段 if。 */
  function miLevel(info, p) {
    if (!info || !isFinite(p)) return '';
    if (info.high) {
      if (p >= info.bad) return 'bad';
      return p >= info.warn ? 'warn' : '';
    }
    if (p <= info.bad) return 'bad';
    return p <= info.warn ? 'warn' : '';
  }
  function miColor(info, p) {
    var l = miLevel(info, p);
    return l === 'bad' ? 'var(--bad)' : l === 'warn' ? 'var(--warn)' : '';
  }
  // trend 给的是 'bad' / 'warn' / 'flat' / 'up'
  function miTrendLevel(d) {
    var l = d && d.level;
    return l === 'bad' ? 'bad' : l === 'warn' ? 'warn' : '';
  }

  var MI_MAIN_INFO = {
    cache_pct: {
      icon: 'cache', warn: 85, bad: 97, high: true,
      pct: function () { return ST.cache.quotaGB ? ST.cache.fillPct : NaN; },
      note: function () { return ST.cache.quotaGB ? fmtBytes(ST.cache.used) + ' / ' + fmtGB(ST.cache.quotaGB) : ''; }
    },
    mem_free_pct: {
      icon: 'mem', warn: 15, bad: 7, high: false,
      pct: function () { return (ST.mem && isFinite(ST.mem.pct)) ? 100 - ST.mem.pct : NaN; },
      note: function () { return (ST.mem && isFinite(ST.mem.free)) ? miBytes(ST.mem.free) + ' 可用' : ''; }
    },
    /* 主显示里的这一项算的是「上限 + 安全缓冲 占缓存盘剩余空间的比例」。
       名字写成「上限占盘比」而不是「AE 所需」—— 用户把它读成「AE 现在要这么多」。 */
    need_pct: {
      icon: 'need', warn: 80, bad: 100, high: true,
      pct: function () { return miNeedPct(); },
      note: function () { return isFinite(ST.cache.needGB) ? '上限+缓冲 ' + miGB(ST.cache.needGB) + ' / 盘余 ' + miGB(ST.cache.driveFreeGB) : ''; }
    },
    disk_free_pct: {
      icon: 'disk', warn: 10, bad: 5, high: false,
      pct: function () { return miDiskFreePct(); },
      note: function () { return isFinite(ST.cache.driveFreeGB) ? miGB(ST.cache.driveFreeGB) + ' 可用' : ''; }
    }
  };

  /* 次显示两格能放的指标。pct() 只用来取色，val() 才是显示的文字。 */
  var MI_SUB_INFO = {
    cache_gb: {
      icon: 'cache', warn: 85, bad: 97, high: true,
      pct: function () { return ST.cache.quotaGB ? ST.cache.fillPct : NaN; },
      val: function () { return (ST.cache && ST.cache.used) ? miBytes(ST.cache.used) : '--'; }
    },
    mem_free_gb: {
      icon: 'mem', warn: 15, bad: 7, high: false,
      pct: function () { return (ST.mem && isFinite(ST.mem.pct)) ? 100 - ST.mem.pct : NaN; },
      val: function () { return (ST.mem && isFinite(ST.mem.free)) ? miBytes(ST.mem.free) : '--'; }
    },
    /* 「缓存上限」= AE 允许用的最大缓存（quotaGB），不是已经用掉多少。
       lvl() 返回空串：上限是个常量，没有「好/坏」可言，不该上色
       （不给它 lvl 的话会被当成增速指标，走 miTrendLevel 上色）。 */
    need_gb: {
      icon: 'need',
      lvl: function () { return ''; },
      val: function () { return ST.cache.quotaGB ? miGB(ST.cache.quotaGB) : '--'; }
    },
    /* 「盘够装吗」：拿面板既有的三条线（ST.cache.verdict）翻成人话，
       不新增阈值，也就不存在「小窗说够、面板说紧」这种自相矛盾。 */
    enough: {
      icon: 'need',
      lvl: function () {
        var v = ST.cache && ST.cache.verdict;
        return v === 'bad' ? 'bad' : (v === 'warn' ? 'warn' : '');
      },
      val: function () {
        var v = ST.cache && ST.cache.verdict;
        if (v === 'ok') return '够';
        if (v === 'warn') return '偏紧';
        if (v === 'bad') return '不够';
        return '--';                     // 没读到缓存盘 → 判定不出来就说不知道
      }
    },
    left_gb: {
      icon: 'left', warn: 85, bad: 97, high: true,
      pct: function () { return ST.cache.quotaGB ? ST.cache.fillPct : NaN; },
      val: function () { return ST.cache.quotaGB ? miGB(ST.cache.leftGB) : '--'; }
    },
    disk_free_gb: {
      icon: 'disk', warn: 10, bad: 5, high: false,
      pct: function () { return miDiskFreePct(); },
      val: function () { return isFinite(ST.cache.driveFreeGB) ? miGB(ST.cache.driveFreeGB) : '--'; }
    },
    rate: {
      icon: 'rate',
      val: function (d) { return miRateText(d); }
    },
    eta: {
      icon: 'eta',
      val: function (d) { return miEtaText(d); }
    }
  };

  function miRateNum(v) {
    if (!isFinite(v)) return '--';
    return v >= 1 ? v.toFixed(1) + 'GB/h' : Math.max(1, Math.round(v * 1024)) + 'MB/h';
  }
  function miRateText(d) {
    var r = d && d.rate;
    if (!r || !r.ok || r.points < 2) return '--';
    if (r.dir === 'down') return '↓' + miRateNum(r.perHour);
    if (r.dir === 'flat') return '持平';
    return '↑' + miRateNum(r.perHour);
  }
  function miEtaText(d) {
    var h = d && d.etaHours;
    if (h === null || h === undefined || !isFinite(h)) return '--';
    if (h <= 0) return '已耗尽';
    return h < 48 ? Math.round(h) + 'h' : (h / 24).toFixed(1) + '天';
  }

  /* ---------------- 面板主题（1.7.1） ----------------
     主题只是 body 上的一个属性：`body[data-theme="azure"]` 覆盖一组 CSS 变量。
     所以换主题不需要重绘任何数字、不碰刷新周期，也不会让布局抖一下。
     清单（THEMES / THEME_LABELS / THEME_DOTS）只有一处出处（js/settings.js），
     这里只负责把它画成圆点、把选择写回设置。 */
  function themeList() {
    return (Settings && Settings.THEMES) || ['mint'];
  }

  function themeDotColor(id) {
    var d = (Settings && Settings.THEME_DOTS) || {};
    return d[id] || 'var(--ok)';
  }

  function themeLabel(id) {
    var L = (Settings && Settings.THEME_LABELS) || {};
    return L[id] || id;
  }

  /* 把主题写到 body 上。薄荷绿是默认那套（CSS 的 :root），也照样写属性 ——
     这样「当前用哪套」在 DOM 上永远读得出来，排查时不用猜。 */
  function applyTheme() {
    var id = (USR && USR.ui && USR.ui.theme) || 'mint';
    if (themeList().indexOf(id) < 0) id = 'mint';
    if (document.body && document.body.setAttribute) {
      document.body.setAttribute('data-theme', id);
    }
    var dot = $('themeDot');
    if (dot) dot.style.background = themeDotColor(id);
    syncThemeUI();
  }

  /* 两处色点（顶部小面板 + 抽屉一行）都由这里生成，避免 HTML 里手写两份。 */
  function buildThemeOptions() {
    var list = themeList();
    function fill(box) {
      if (!box) return;
      box.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        var b = document.createElement('button');
        b.className = 'thm-b';
        b.setAttribute('data-thm', list[i]);
        b.type = 'button';
        b.title = themeLabel(list[i]);
        b.setAttribute('aria-label', '面板主题：' + themeLabel(list[i]));
        b.style.color = themeDotColor(list[i]);
        var d = document.createElement('i');
        b.appendChild(d);
        box.appendChild(b);
      }
    }
    fill($('themeRow'));
    fill($('themePop'));
  }

  /* 把「当前选的是哪套」画在两处控件上，并写一行说明（抽屉里那句）。 */
  function syncThemeUI() {
    var id = (USR && USR.ui && USR.ui.theme) || 'mint';
    var boxes = [$('themeRow'), $('themePop')];
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (!box || !box.querySelectorAll) continue;
      var bs = box.querySelectorAll('.thm-b');
      for (var j = 0; j < bs.length; j++) {
        var cur = bs[j].getAttribute('data-thm') === id;
        if (cur) bs[j].classList.add('on'); else bs[j].classList.remove('on');
      }
    }
    var hint = $('themeHint');
    if (hint) hint.textContent = '当前：' + themeLabel(id) + '。顶部圆点或这里的色点都能换，点完立刻生效（只换颜色，不动数据）。';
  }

  /* 点一个色点：写回设置 → 立刻应用 → 关掉小面板。 */
  function setTheme(id) {
    if (!USR || !Settings || themeList().indexOf(id) < 0) return;
    USR = normFromUSR({
      ui: { cache: USR.ui.cache, mem: USR.ui.mem, disk: USR.ui.disk,
            guard: USR.ui.guard, theme: id }
    });
    saveCfg();
    applyTheme();
  }

  /* 事件委托：色点是动态生成的，逐个挂 listener 会随重建失效。 */
  function themePick(e) {
    var t = e.target;
    while (t && t !== this && !(t.getAttribute && t.getAttribute('data-thm'))) t = t.parentNode;
    if (!t || t === this || !t.getAttribute) return;
    setTheme(t.getAttribute('data-thm'));
    var pop = $('themePop');
    if (pop) pop.hidden = true;
  }

  /* 三个下拉的选项由 MINI_MAIN / MINI_SUB 生成 —— 清单只有一处，
     不会出现「设置里能选、小窗不认」的错位；单位跟在名字后面，看得见选的是 % 还是 GB。 */
  function buildMiniOptions() {
    var SS = Settings || {};
    var mainList = SS.MINI_MAIN || ['cache_pct'];
    var subList = SS.MINI_SUB || ['none'];
    var L = SS.MINI_LABELS || {};
    var U = SS.MINI_UNITS || {};
    function fill(sel, values) {
      if (!sel) return;
      sel.innerHTML = '';
      for (var i = 0; i < values.length; i++) {
        var o = document.createElement('option');
        o.value = values[i];
        o.textContent = (L[values[i]] || values[i]) + (U[values[i]] ? '（' + U[values[i]] + '）' : '');
        sel.appendChild(o);
      }
    }
    fill($('selMetric'), mainList);
    fill($('selSub1'), subList);
    fill($('selSub2'), subList);
  }

  /* 主显示与次显示指同一个指标时把次显示留空，并说明原因。
     判定本身是 settings.js 的 fixMini（纯函数、单测覆盖），这里只把结果写回界面。 */
  function pruneMiniSelects() {
    var mSel = $('selMetric'), s1 = $('selSub1'), s2 = $('selSub2');
    if (!mSel || !Settings || !Settings.fixMini) return null;
    var before1 = s1 ? s1.value : 'none';
    var before2 = s2 ? s2.value : 'none';
    var fixed = Settings.fixMini({ miniMetric: mSel.value, miniSub1: before1, miniSub2: before2 });
    if (s1) s1.value = fixed.miniSub1;
    if (s2) s2.value = fixed.miniSub2;
    var hint = $('miniHint');
    if (hint) {
      hint.textContent = (fixed.miniSub1 !== before1 || fixed.miniSub2 !== before2)
        ? '与主显示重复的那一格已留空 —— 同一个指标不显示两遍。'
        : '主显示画环；次显示 1 / 2 是环下面两格，同一指标会自动留空。「盘够装吗」看的是缓存盘装不装得下 AE 的缓存上限（含安全缓冲），够 / 偏紧 / 不够。';
    }
    return fixed;
  }

  /* 选完立刻生效：这三个下拉就摆在小窗旁边，改完还要去抽屉底下按「确定」，
     等于让用户猜自己改的到底生效没有。 */
  function applyMiniChoice() {
    if (!USR || !Settings) return;
    var fixed = pruneMiniSelects();
    USR = normFromUSR({
      miniMetric: fixed ? fixed.miniMetric : USR.miniMetric,
      miniSub1: fixed ? fixed.miniSub1 : USR.miniSub1,
      miniSub2: fixed ? fixed.miniSub2 : USR.miniSub2
    });
    saveCfg();
    renderMini();
    renderMiniStats();
  }

  /* 图标只在键变了才重写 DOM：小窗每 3 秒刷一次，反复写 innerHTML 会打断渲染，
     窄面板上还能看见图标闪一下。 */
  function miSetIcon(el, key) {
    if (!el) return;
    var d = miIcon(key);
    if (el.getAttribute('data-mi') === d) return;
    el.setAttribute('data-mi', d);
    el.innerHTML = d;
  }

  /* ---------------- 折叠小窗 ---------------- */
  // 小窗的环只回答一件事：当前那个百分比是多少。
  // 是哪个百分比由设置决定（1.6.5 起四个可选，见 MI_MAIN_INFO）。
  function renderMini() {
    var pctEl = $('miniPct'), labEl = $('miniLabel'), ring = $('miniRing');
    if (!pctEl || !ring) return;

    var key = (USR && USR.miniMetric) || 'cache_pct';
    var info = MI_MAIN_INFO[key] || MI_MAIN_INFO.cache_pct;
    var p = info.pct();
    var ok = isFinite(p);

    pctEl.textContent = ok ? Math.round(p) + '%' : '--';
    if (labEl) labEl.textContent = miLabel(key);
    miSetIcon($('miMain'), info.icon);
    ring.style.setProperty('--p', (ok ? clamp(p, 0, 100) : 0).toFixed(1));
    var col = miColor(info, p);
    if (col) ring.style.setProperty('--rc', col);
    else ring.style.removeProperty('--rc');
    setArc('miniRing', ok ? p : 0, col);

    var note = info.note ? info.note() : '';
    ring.title = miLabel(key) + ' ' + (ok ? Math.round(p) + '%' : '--') +
                 (note ? '（' + note + '）' : '') +
                 '　点击展开';
  }

  /* 小窗下方的占用行（1.6.2）：内存 / 缓存 各一行，超线才变色。
   * 只给数字不给百分比：环里已经有百分比了，下面再来一遍是重复。
   *
   * 为什么独立于 renderMini：这两行显示的是**数值**（内存/缓存的绝对用量），
   * 而 renderMini 画的是**环**。数值该跟数值的节拍走 —— renderCache / renderMem 一更新就该刷。
   * 早先挂在 renderMini 末尾，等于「环不重画，数字就不更新」：一旦哪天有人改了环的刷新条件
   * （比如只在百分比变化时才重绘），这两行会静静停在旧值上。耦合关系错了，不是当下可见的 bug。 */
  function renderMiniStats() {
    var d = (Trend && ST.cache) ? Trend.describe(ST.cacheHist, ST.cache.marginGB) : null;
    var cells = [
      { key: (USR && USR.miniSub1) || 'none', box: $('ms1'), ico: $('mi1'), lab: $('ml1'), val: $('mv1') },
      { key: (USR && USR.miniSub2) || 'none', box: $('ms2'), ico: $('mi2'), lab: $('ml2'), val: $('mv2') }
    ];
    var shown = 0;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var info = MI_SUB_INFO[cell.key];
      if (!info) {                    // none / 值不合法：整格收起来，不占位置
        if (cell.box) cell.box.hidden = true;
        continue;
      }
      shown++;
      if (cell.box) cell.box.hidden = false;
      miSetIcon(cell.ico, info.icon);
      if (cell.lab) cell.lab.textContent = miLabel(cell.key);
      if (cell.val) cell.val.textContent = info.val(d);
      // 三路：词语指标自带 lvl()（如「盘够装吗」）；有 pct() 的按阈值上色；
      // 剩下的（增速 / 距耗尽）按趋势上色。
      var lvl = info.lvl ? info.lvl(d) : (info.pct ? miLevel(info, info.pct()) : miTrendLevel(d));
      if (cell.box && cell.box.classList) {
        cell.box.classList.toggle('on', lvl === 'warn');
        cell.box.classList.toggle('bad', lvl === 'bad');
      }
    }
    var row = $('miniStats');
    if (row) row.hidden = (shown === 0);   // 两格都没选时整行不占位置
  }

  function setCompact(on, silent) {
    compact = !!on;
    document.body.classList.toggle('compact', compact);
    if (!compact) autoCollapsed = false;
    renderMini();
    // 折叠/展开会改变提醒条能放下的文字量：正在显示的提醒要跟着换文案，
    // 否则小窗里继续显示长句、展开后还停在短句，直到 25 秒后换下一条。
    if (rmCur) {
      rmMsgExpanded = false;
      $('rmMsg').classList.remove('expanded');
      $('rmMsg').textContent = compact && rmCur.shortMsg ? rmCur.shortMsg : (rmCur.msg || '');
    }
    if (!silent) toast(compact ? '已折叠' : '已展开');
  }

  function toggleCompact(silent) {
    autoCollapsed = false;
    setCompact(!compact, silent);
    rememberMini();          // 1.7.6：手动折了 / 展开了，就记住这个形态
  }

  function checkAutoCollapse() {
    if (!USR || !USR.autoCollapse) return;
    var w = document.documentElement.clientWidth || window.innerWidth || 0;
    if (w < 190 && !compact) {
      autoCollapsed = true;
      setCompact(true, true);
    } else if (w >= 190 && compact && autoCollapsed) {
      autoCollapsed = false;
      setCompact(false, true);
    }
  }

  /* ---------------- 渲染：内存曲线 ---------------- */
  function drawSpark(force) {
    var cv = $('spark');
    if (!cv || !cv.getContext) return;

    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth || 280, h = 40;

    // 数据没变就不重画：这条曲线每 3 秒重绘一次，绝大多数轮次是白画
    var key = w + '|' + ST.hist.length + '|' +
              (ST.hist.length ? String(ST.hist[ST.hist.length - 1]) : '');
    if (!force && key === ST.sparkKey) return;
    ST.sparkKey = key;

    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }

    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(function (r) {
      var y = Math.round(h * r) + .5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });

    var data = ST.hist;
    if (data.length < 2) return;

    var stepX = w / (CFG.histMax - 1);
    var pad = 3, usable = h - pad * 2;
    var last = data[data.length - 1];
    var col = colorBy(last, CFG.ramWarn, CFG.ramBad) || '#a99cff';

    function xAt(i) { return i * stepX; }
    function yAt(v) { return pad + usable - (clamp(v, 0, 100) / 100) * usable; }

    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexA(col, 0.28));
    grad.addColorStop(1, hexA(col, 0));

    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(data[0]));
    for (var i = 1; i < data.length; i++) ctx.lineTo(xAt(i), yAt(data[i]));
    ctx.lineTo(xAt(data.length - 1), h);
    ctx.lineTo(xAt(0), h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(xAt(0), yAt(data[0]));
    for (var j = 1; j < data.length; j++) ctx.lineTo(xAt(j), yAt(data[j]));
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(xAt(data.length - 1), yAt(last), 2.4, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
  }

  function hexA(color, alpha) {
    var m = /^#([0-9a-f]{6})$/i.exec(color);
    if (!m) return 'rgba(169,156,255,' + alpha + ')';
    var n = parseInt(m[1], 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /* ---------------- 渲染：媒体缓存 ---------------- */
  function renderMedia() {
    var m = ST.media;
    $('mediaSize').textContent = m.scanned ? fmtBytes(m.used) : '扫描中…';
    $('mediaFiles').textContent = m.scanned ? (m.files + ' 个文件') : '';
    $('mediaPath').textContent = shortPath(m.path);
    $('mediaPath').title = m.path || '';
  }

  /* ---------------- 渲染：其他版本的缓存 ---------------- */
  // 本机同时装 23 与 24 时，两个版本各有一份缓存目录，只统计当前版本会低估占用。
  function renderOther() {
    var el = $('otherCache');
    if (!el) return;

    var o = ST.other;
    var cur = ST.cache.path || '';

    if (!cur) { el.textContent = '其他版本缓存 待定位'; el.title = ''; return; }

    if (!o.scanned) { el.textContent = '其他版本缓存 扫描中…'; el.title = ''; return; }

    if (!o.dirs.length) {
      el.textContent = '其他版本缓存 无';
      el.title = '当前缓存盘上没有其他 AE 版本的缓存目录';
      return;
    }

    el.textContent = '其他版本缓存 ' + fmtBytes(o.bytes) +
                     '（' + o.dirs.length + ' 个目录 / ' + o.files + ' 个文件）';
    el.title = o.dirs.join('\n') + '\n\n这些是旧版本 AE 留下的缓存，可在 AE 里清理或直接删除。';
  }

  /* ---------------- 渲染：磁盘 ---------------- */
  function renderDisks() {
    var box = $('diskList');
    var list = ST.disks;

    if (!list.length) {
      box.innerHTML = '<div class="empty">' +
        (hasNode ? '未检测到本地磁盘' + (ST.disksErr ? '（' + esc(ST.disksErr) + '）' : '')
                 : '需要 Node.js 才能读取磁盘') + '</div>';
      $('diskSummary').textContent = '';
      return;
    }

    var html = '', sumTotal = 0, sumFree = 0;
    var cacheDrive = ST.cache.drive ? ST.cache.drive.toUpperCase() : '';
    var projDrive = '';

    if (ST.projectPath) {
      var pm = /^([A-Za-z]):/.exec(ST.projectPath);
      if (pm) projDrive = (pm[1] + ':').toUpperCase();
    }

    list.forEach(function (d) {
      var used = d.total - d.free;
      var p = pctOf(used, d.total);
      var col = colorBy(p, CFG.diskWarn, CFG.diskBad) || 'var(--accent)';
      var upper = String(d.name).toUpperCase();
      var isCache = upper === cacheDrive;
      var isProj = projDrive && upper === projDrive;

      sumTotal += d.total;
      sumFree += d.free;

      var tags = '';
      if (isCache) tags += '<span class="tag">缓存盘</span>';
      if (isProj) tags += '<span class="tag warn">工程</span>';

      html += '<div class="disk">' +
        '<div class="disk-top">' +
          '<span class="dname">' + esc(d.name) + tags + '</span>' +
          '<span class="dnum">' + fmtBytes(d.free) + ' 可用</span>' +
        '</div>' +
        '<div class="bar"><i style="width:' + p.toFixed(1) + '%;background:' + col + '"></i></div>' +
        '<div class="disk-sub">已用 ' + fmtBytes(used) + ' / ' + fmtBytes(d.total) +
          ' · ' + p.toFixed(1) + '%</div>' +
      '</div>';
    });

    box.innerHTML = html;
    var sumEl = $('diskSummary');
    sumEl.textContent = fmtBytes(sumFree) + ' 可用 / 共 ' + fmtBytes(sumTotal) +
                        (ST.disksErr ? ' · ' + ST.disksErr : '');
    sumEl.title = ST.disksErr ? ST.disksErr : '';
  }

  /* ---------------- 渲染：工程 ---------------- */
  function renderAE() {
    var ae = ST.ae;

    if (!ae) {
      $('aeVer').textContent = '';
      $('aeProject').textContent = hasCEP ? '读取中…' : '非 CEP 环境';
      $('aeProject').title = '';
      $('aeExtra').textContent = '';
      return;
    }

    $('aeVer').textContent = 'v' + (ae.v || '?');

    if (ae.p) {
      var base = ae.p.replace(/\\/g, '/').split('/').pop();
      $('aeProject').textContent = base;
      $('aeProject').title = ae.p;
      ST.projectPath = ae.p;

      var sizeTxt = '';
      try {
        if (hasNode && fs.existsSync(ae.p)) sizeTxt = fmtBytes(fs.statSync(ae.p).size);
      } catch (e) {}

      $('aeExtra').textContent = '工程体积 ' + (sizeTxt || '—') + ' · 素材项 ' + (ae.n || 0);
    } else if (ae.d) {
      $('aeProject').textContent = '未保存的工程';
      $('aeProject').title = '';
      ST.projectPath = '';
      $('aeExtra').textContent = '素材项 ' + (ae.n || 0);
    } else {
      $('aeProject').textContent = '未打开工程';
      $('aeProject').title = '';
      ST.projectPath = '';
      $('aeExtra').textContent = '';
    }
  }

  /* ---------------- 崩溃保护 ---------------- */
  function hhmmss(ms) {
    var d = new Date(ms);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function agoText(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.round(s / 60) + ' 分钟前';
    if (s < 86400) return Math.round(s / 3600) + ' 小时前';
    return Math.round(s / 86400) + ' 天前';
  }

  // 把面板里散落的指标整理成判定器要的输入
  function guardState() {
    var p = ST.proj, c = ST.cache, m = ST.mem;
    var dirty = null;

    if (p.d === 1 || p.d === 0) {
      dirty = (p.d === 1);
      if (!dirty) ST.guardRev = p.rev;              // 干净时把基线对齐
    } else if (p.rev > 0) {
      // AE 17.5 以下没有 dirty 属性：用 revision 是否变化推断
      if (!ST.guardRev) { ST.guardRev = p.rev; dirty = false; }
      else dirty = (p.rev !== ST.guardRev);
    }

    return {
      projOpen: !!(ST.ae && ST.ae.d),
      projPath: ST.projectPath || '',
      projDirty: dirty,
      renderActive: p.rq === 1,
      memPct: m ? m.pct : null,
      // 提交内存才是内存侧的主信号：AE 的 "Unable to allocate" 撞的是提交上限
      commitPct: isFinite(ST.commitPct) ? ST.commitPct : null,
      marginGB: isFinite(c.marginGB) ? c.marginGB : null,
      cacheFillPct: c.fillPct || 0,
      hostAlive: p.alive,
      // 最近一次 AE 崩溃距今几小时（null = 没有记录）
      crashHoursAgo: (ST.crash && isFinite(ST.crash.hoursAgo)) ? ST.crash.hoursAgo : null,
      // 本机崩溃画像：档位用它、界面也用它解释"为什么是这个档"
      crashProfile: ST.crashProfile || null
    };
  }

  function evaluateGuard() {
    if (!Guard || !grd) return;
    var g = ST.guard;

    if (ST.demo) {
      g.risk = 18; g.level = 'ok'; g.reasons = []; g.blocked = 'clean'; g.suggest = false;
      return;
    }

    var r = grd.evaluate(guardState(), Date.now());
    g.risk = r.risk;
    g.level = r.level;
    g.reasons = r.reasons || [];
    g.blocked = r.blocked || '';
    g.suggest = !!r.suggest;

    if (r.shouldSave) doSave(r.why);
  }

  function doSave(why) {
    if (!hasCEP || guardBusy) return;

    guardBusy = true;
    ST.guard.saving = true;
    renderGuard();

    var started = Date.now();
    var done = false;

    function finish(o) {
      if (done) return;
      done = true;
      guardBusy = false;
      ST.guard.saving = false;

      var now = Date.now();

      if (o && o.ok === 1) {
        grd.markSaved(now);
        ST.guard.saved++;
        ST.guard.savedAt = now;
        ST.guard.saveMs = o.ms || (now - started);
        ST.guard.lastErr = '';
        if (o.r) ST.guardRev = o.r;                 // 保存后 revision 变化，重新对齐
        // 立即把本地状态改成「干净」，否则下一轮可能用旧读数再次触发
        ST.proj.d = (o.d === 1 || o.d === 0) ? o.d : 0;
        if (o.r) ST.proj.rev = o.r;
        toast('已自动保存工程' + (why === 'risk' ? '（风险升高）' : '（改动已积压）') +
          (ST.guard.backupErr ? ' · 本次未留回退副本：' + ST.guard.backupErr : ''),
          ST.guard.lastBackup ? { label: '取回上一版', run: restoreLatest } : null);
        renderAE();
        logSave(true, why, ST.guard.saveMs, '', ST.projectPath);
      } else {
        grd.markFailed(now);                        // 记时间，避免每轮重试卡界面
        ST.guard.lastErr = (o && o.err) || '未收到 AE 响应';
        ST.guard.saveMs = now - started;
        toast('自动保存失败：' + ST.guard.lastErr + ' · 请尝试手动 Ctrl/Cmd+S 保存');
        logSave(false, why, ST.guard.saveMs, ST.guard.lastErr, ST.projectPath);
      }
      renderGuard();
    }

    // 覆盖前先留一份可回退的副本。失败也继续保存 —— 覆盖优先，不能因为备份问题丢掉改动
    var bk = null;
    try { bk = makeBackup(ST.projectPath); } catch (e) { bk = null; }
    ST.guard.lastBackup = (bk && bk.ok) ? bk.path : '';
    ST.guard.backupErr = (bk && !bk.ok && !bk.skipped) ? (bk.err || '备份失败') : '';

    try {
      window.__adobe_cep__.evalScript('sysmon_save()', function (raw) {
        finish(parseKV(raw));
      });
    } catch (e) { finish(null); }

    // 大工程写入可达十几秒，超时按失败处理
    setTimeout(function () { finish(null); }, 20000);
  }

  /* ---------------- 保存日志 ----------------
     崩溃保护唯一的验收方式是「它到底替我存过没有」。只弹一条 toast 等于没记录：
     面板一关就失忆。这里落一份纯文本日志，行格式固定，方便用户直接打开看。 */
  function localDataDir() {
    if (!hasNode) return '';
    try {
      var home = os.homedir();
      return process.platform === 'win32'
        ? pathmod.join(home, 'AppData', 'Local', 'AESystemMonitor')
        : (process.platform === 'darwin'
            ? pathmod.join(home, 'Library', 'Logs', 'AESystemMonitor')
            : pathmod.join(home, '.cache', 'AESystemMonitor'));
    } catch (e) { return ''; }
  }

  function saveLogPath() {
    var dir = localDataDir();
    return dir ? pathmod.join(dir, 'saves.log') : '';
  }

  function logEnabled() { return !!(USR && USR.crashGuard && USR.crashGuard.log); }

  /* ---------------- 回退副本 ----------------
     保护保存写的是原工程文件，覆盖之后就回不去。所以写盘前先 copy 一份带时间戳的副本。
     三条原则：
       · 覆盖优先：备份失败不能阻止保存 —— 宁可没有副本，也不能丢改动。
       · 回退不做原地覆盖：AE 正开着工程时替换文件，内存里的内容一保存就把回退盖掉了。
         所以「取回」是生成一份新文件，让人在 AE 里主动打开比对。
       · 份数有上限：大工程每份几百 MB，不设上限很快占满盘。 */
  function backupEnabled() {
    return !!(Backup && USR && USR.crashGuard && USR.crashGuard.backup);
  }

  /* 副本目录名：必须让用户看得懂。
   * 旧版用的是点开头的 .ae-system-monitor-backups —— Windows 并不隐藏点开头的目录，
   * 用户只会在素材盘里看到一个来路不明的文件夹，还会被网盘/版本库一起同步。
   * 1.6.1 起写进可见的中文名；旧目录仍可读（legacyBackupDirFor），只是不再往里写。 */
  var BACKUP_DIR_NAME = 'AE-System-Monitor 备份';
  var BACKUP_DIR_OLD = '.ae-system-monitor-backups';
  // 面板里只摊开最近 N 份（用户指定的 3 份）：96–280px 宽的面板把全部列出来既挤也没意义
  var BK_LIST_N = 3;
  var bkListOpen = false;

  /* 用户填的自定义落点（设置 › 崩溃保护 › 副本目录）。空串 = 用默认位置。 */
  function customBackupDir() {
    var c = (USR && USR.crashGuard && USR.crashGuard.backupDir) || '';
    return typeof c === 'string' ? c.trim() : '';
  }

  /* 自定义落点还能不能用：存在，或者能建出来。
     拔掉的盘符 existsSync 为 false、mkdir 会抛 —— 两种都算不可用，
     由 pickRoot 退回默认位置（面板会显示「自定义目录不可用」）。 */
  function canUseDir(dir) {
    if (!dir || !hasNode || !fs) return false;
    try {
      if (fs.existsSync(dir)) return true;
      mkdirp(dir);
      return fs.existsSync(dir);
    } catch (e) { return false; }
  }

  /* 默认落点：优先工程所在卷（避免大工程备份挤满系统盘），路径不可用时退回本机目录。
     1.6.4 起它有两个身份：用户没填自定义目录时它就是落点本身；
     用户填了之后它退居「只读的旧落点」—— 老副本仍要看得见、取得到（见 listBackups）。 */
  function defaultBackupDirFor(projectPath) {
    if (!projectPath || !hasNode || !pathmod) return '';
    try {
      var parent = pathmod.dirname(projectPath);
      if (fs.existsSync(parent)) return pathmod.join(parent, BACKUP_DIR_NAME);
    } catch (e) {}
    var dir = localDataDir();
    return dir ? pathmod.join(dir, 'backup') : '';
  }

  function backupRoot(projectPath) {
    var pick = (Backup && pathmod) ? Backup.pickRoot(customBackupDir(), '', canUseDir) : null;
    ST.bkCustom = !!(pick && pick.custom);
    ST.bkFallback = !!(pick && pick.fellback);
    if (pick && pick.root) return pathmod.join(pick.root, BACKUP_DIR_NAME);
    return defaultBackupDirFor(projectPath);
  }

  function backupDirFor(projectPath) {
    var root = backupRoot(projectPath);
    if (!root || !Backup || !projectPath) return '';
    return pathmod.join(root, Backup.folderFor(projectPath));
  }

  /* 旧位置：只读不写。升级后已有的副本不会凭空消失，用户也不会以为「我的副本没了」 */
  function legacyBackupDirFor(projectPath) {
    if (!projectPath || !Backup || !hasNode || !pathmod) return '';
    try {
      var parent = pathmod.dirname(projectPath);
      var root = pathmod.join(parent, BACKUP_DIR_OLD);
      if (!fs.existsSync(root)) return '';
      return pathmod.join(root, Backup.folderFor(projectPath));
    } catch (e) { return ''; }
  }

  function mkdirp(dir) {
    try {
      if (!dir || fs.existsSync(dir)) return;
      var parts = String(dir).split(/[\\/]/);
      var cur = parts[0];
      for (var i = 1; i < parts.length; i++) {
        if (!parts[i]) continue;
        cur = pathmod.join(cur, parts[i]);
        if (!fs.existsSync(cur)) fs.mkdirSync(cur);
      }
    } catch (e) {}
  }

  /* 最新在前：文件名里带时间戳，字典序倒排即时间倒排。
   * 两处过滤是有意的：*.part 是原子写的半成品（正则本身就不匹配 *.aep），
   * 0 字节的残档不参与「最新一份」，否则取回会挑中一个打不开的文件。 */
  function listBackups(projectPath) {
    var out = [];
    function scan(dir, note) {
      if (!dir || !fs || !fs.existsSync(dir)) return;
      try {
        fs.readdirSync(dir).forEach(function (n) {
          if (!/\.aepx?$/i.test(n)) return;
          var p = pathmod.join(dir, n);
          var st = null;
          try { st = fs.statSync(p); } catch (e) { return; }
          if (!st.size) return;
          out.push({ name: n, path: p, size: st.size, mtime: st.mtimeMs,
                     old: !!note, note: note || '' });
        });
      } catch (e) {}
    }
    scan(backupDirFor(projectPath), '');
    scan(legacyBackupDirFor(projectPath), '旧位置');
    /* 用户把落点改到别的盘之后，**原先默认位置里的那些副本不能就此看不见** ——
       那正是「我的副本没了」的由来。只读扫一遍、标注来源，取回照旧可用。 */
    var defDir = defaultBackupDirFor(projectPath);
    if (defDir && defDir !== backupDirFor(projectPath)) scan(defDir, '默认位置');
    out.sort(function (a, b) { return a.name < b.name ? 1 : -1; });
    return out;
  }

  /* 写盘前留一份。返回 { ok, path } 或 { ok:false, err/skipped } */
  function makeBackup(projectPath) {
    if (!backupEnabled() || !hasNode || !fs || !projectPath) return { ok: false, skipped: true };
    try {
      if (!fs.existsSync(projectPath)) return { ok: false, err: '工程文件不存在' };
      var dir = backupDirFor(projectPath);
      if (!dir) return { ok: false, skipped: true };
      mkdirp(dir);

      // 先写 <名字>.part 再 rename：中途断电/进程被杀不会留下一个「带着正常时间戳的半截文件」，
      // 而取回逻辑按名字倒排取最新 —— 那种文件恰好会被挑中。拿 taken 兜住同毫秒撞名。
      var taken = listBackups(projectPath).map(function (b) { return b.name; });
      var dest = pathmod.join(dir, Backup.backupName(projectPath, Date.now(), taken));
      var w = Backup.atomicCopy(fs, pathmod, projectPath, dest);
      if (!w.ok) return { ok: false, err: w.err || '副本写入失败' };

      // 轮转：只留最近 keep 份（旧目录里的不碰，删不删由用户自己定）
      var keepN = (USR.crashGuard && USR.crashGuard.keepBackups) || 5;
      var names = listBackups(projectPath).filter(function (b) { return !b.old; })
        .map(function (b) { return b.name; });
      Backup.rotate(names, keepN).remove.forEach(function (n) {
        try { fs.unlinkSync(pathmod.join(dir, n)); } catch (e) {}
      });

      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, err: e.message || String(e) };
    }
  }

  /* 取回指定的那一份：生成「（回退 时间）」副本，不动原文件。
   * 1.6.2 起面板可逐份取回，所以把这一步从「取最近一份」里拆出来；
   * 两种入口都走这里，取回本身必须原子写 —— 否则大工程写到一半失败
   * 会留下一个「看着能用」的半截副本。 */
  function restorePick(pick) {
    if (!Backup || !hasNode || !ST.projectPath) { toast('先打开一个已保存的工程'); return; }
    if (!pick) { toast('这一份已经不在了，已刷新列表'); return; }

    var dir = pathmod.dirname(ST.projectPath);
    var taken = [];
    try {
      fs.readdirSync(dir).forEach(function (n) { if (/\.aepx?$/i.test(n)) taken.push(n); });
    } catch (e) {}

    var dest = pathmod.join(dir, Backup.uniqueName(Backup.restoreName(ST.projectPath, pick.mtime), taken));
    var w = Backup.atomicCopy(fs, pathmod, pick.path, dest);
    if (!w.ok) { toast('取回失败：' + w.err); return; }
    toast('已生成回退副本：' + pathmod.basename(dest) + (pick.note ? '（来自' + pick.note + '）' : ''));
    openFolder(dir);
  }

  /* 取回最近一份（list[0] 已过滤掉 0 字节与 .part，就是最新的可用副本） */
  function restoreLatest() {
    if (!Backup || !hasNode || !ST.projectPath) { toast('先打开一个已保存的工程'); return; }
    var list = listBackups(ST.projectPath);
    if (!list.length) { toast('还没有回退副本（下次保护保存时生成）'); return; }
    restorePick(list[0]);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 列表里用的短时间：今天只给「时:分」，别的日子才补月-日 —— 窄面板省宽度 */
  function stampShort(ms) {
    var d = new Date(ms), n = new Date();
    var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() &&
        d.getDate() === n.getDate()) return hm;
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
  }

  function whyText(why) {
    return why === 'risk' ? '风险升高' : (why === 'hold' ? '改动积压' : (why || '手动'));
  }

  // 记一条保存结果：内存里留一份给面板，同时追加到磁盘（可关）
  function logSave(ok, why, ms, err, proj) {
    var rec = {
      at: stamp(Date.now()),
      ok: !!ok,
      why: whyText(why),
      ms: Math.max(0, Math.round(ms || 0)),
      note: err ? String(err) : '',
      proj: String(proj || '')
    };

    ST.saves.push(rec);
    while (ST.saves.length > CFG.saveLogMax) ST.saves.shift();

    if (!logEnabled()) return;
    var p = saveLogPath();
    if (!p) return;

    var line = rec.at + ' | ' + (rec.ok ? 'OK' : 'FAIL') + ' | ' + rec.why +
               ' | ' + rec.ms + 'ms | ' + (rec.ok ? '成功' : (rec.note || '失败')) +
               (rec.proj ? ' | ' + rec.proj : '') + '\n';

    try {
      fs.mkdirSync(pathmod.dirname(p), { recursive: true });
      fs.appendFileSync(p, line, 'utf8');

      // 无限追加会把日志写成一个负担，超过上限就只留最后 N 行
      if (fs.statSync(p).size > 512 * 1024) {
        var lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean);
        fs.writeFileSync(p, lines.slice(-CFG.saveLogMax).join('\n') + '\n', 'utf8');
      }
    } catch (e) {}
  }

  // 启动时把日志尾部读回来，面板里立刻能看到「上次保存是什么时候」
  function loadSaveLog() {
    ST.saves = [];
    var p = saveLogPath();
    if (!p) return;
    try {
      if (!fs.existsSync(p)) return;
      var txt = fs.readFileSync(p, 'utf8');
      var lines = txt.split(/\r?\n/).filter(function (l) { return l.trim(); });
      var tail = lines.slice(-CFG.saveLogMax);
      ST.saves = tail.map(function (ln) {
        var f = ln.split(' | ');
        return {
          at: f[0] || '', ok: /^OK/.test(f[1] || ''), why: f[2] || '',
          ms: parseInt(String(f[3] || '').replace(/[^\d]/g, ''), 10) || 0,
          note: (f[1] || '').indexOf('FAIL') === 0 ? (f[4] || '') : '',
          proj: f[5] || ''
        };
      });
    } catch (e) { ST.saves = []; }
  }

  function renderGuard() {
    var g = ST.guard;
    var lv = g.level;

    var label = lv === 'high' ? '高危' : lv === 'watch' ? '留意' : lv === 'na' ? '—' : '正常';
    var head = $('gdLevel');
    head.textContent = (g.risk ? label + ' ' + g.risk : label);
    head.className = 'card-hd-r lv-' + lv;
    head.title = '风险分 0–100，达到阈值即自动保存';

    var bar = $('gdBar');
    bar.style.width = clamp(g.risk, 0, 100) + '%';
    if (bar.parentNode) {
      bar.parentNode.className = 'gd-bar' + (lv === 'high' ? ' high' : lv === 'watch' ? ' watch' : '');
    }

    var st = $('gdState');
    if (g.saving) {
      st.textContent = '正在写入工程…';
      st.className = 'gd-line';
    } else if (g.lastErr) {
      st.textContent = '上次自动保存失败：' + g.lastErr;
      st.className = 'gd-line high';
    } else if (g.savedAt) {
      st.textContent = '上次保护保存 ' + hhmmss(g.savedAt) + '（' + agoText(g.savedAt) + '）';
      st.className = 'gd-line';
    } else {
      st.textContent = '尚未触发保护保存';
      st.className = 'gd-line dim';
    }

    var rs = $('gdReason');
    if (g.reasons.length) {
      rs.textContent = g.reasons.join(' · ');
      rs.className = 'gd-line dim' + (lv === 'high' ? ' high' : lv === 'watch' ? ' watch' : '');
      rs.title = g.reasons.join('\n');
    } else {
      var lb = (Guard && Guard.BLOCK_LABELS[g.blocked]) || '';
      rs.textContent = g.suggest ? '建议立即手动保存' : (lb || '—');
      rs.className = 'gd-line dim';
      rs.title = '';
    }

    var as = $('gdAeSave');
    if (ST.autoSave) {
      var t = ST.autoSave.enabled
        ? 'AE 自带 ' + ST.autoSave.intervalMin + ' 分/次 · 留 ' + ST.autoSave.maxVers + ' 版'
        : 'AE 自带自动保存已关闭';
      if (ST.lastAutoSaved) t += ' · 最近 ' + agoText(ST.lastAutoSaved.mtime);
      as.textContent = t;
      as.title = ST.autoSave.folder || '';
    } else {
      as.textContent = '';
    }

    // 崩溃史：既是「为什么现在保存更勤」的解释，也是排查线索。
    // 档位放在最前面，因为它是判定参数的来源 —— 看到「高频」就明白为什么阈值低。
    var cs = $('gdCrash');
    if (cs) {
      var c = ST.crash;
      var pf = ST.crashProfile;
      var mode = (USR && USR.crashGuard) ? USR.crashGuard.mode : 'occasional';
      var M = (Guard && Guard.MODES[mode]) ? Guard.MODES[mode] : null;
      var bits = [];

      if (M) bits.push('档位 ' + M.label);
      if (pf && isFinite(pf.count30)) bits.push('30 天 ' + pf.count30 + ' 次');

      if (c && c.time) {
        var kind = c.type === 'hang' ? '无响应' : '崩溃';
        var t2 = '上次' + kind + ' ' + agoText(c.time);
        if (c.codeText) t2 += '（' + c.codeText + '）';
        else if (c.code) t2 += '（' + c.code + '）';
        if (M && c.hoursAgo <= M.dayH) {
          t2 += (c.hoursAgo <= M.hotH) ? ' · 刚崩过' : ' · 近期崩过';
        }
        bits.push(t2);
      }

      if (!bits.length) {
        cs.textContent = '本机无崩溃记录';
      } else {
        cs.textContent = bits.join(' · ');
      }
      cs.className = 'gd-line dim' + (c && M && c.hoursAgo <= M.hotH ? ' high' : '');
      cs.title = (c && c.dir ? c.dir : '') +
                 (c && c.module ? '\n故障模块：' + c.module : '') +
                 (pf && isFinite(pf.medianGapH) ? '\n本机平均间隔：' + Math.round(pf.medianGapH) + ' 小时' : '');
    }

    renderSaves();
    renderBackup();
  }

  /* 回退副本：报「有几份、最近一次」，并可摊开最近 3 份逐份取回（1.6.2） */
  function renderBackup() {
    var el = $('bkHint');
    if (!el) return;

    var bo = $('btnBkOpen'), br = $('btnBkRestore');

    /* 先把列表收掉，再走各条分支（1.6.2 修缮）。
     *
     * 收起列表这件事，早先只挂在**成功路径**末尾的 renderBackupList 里
     * （那里才写 box.hidden = !bkListOpen）。而下面三条提前返回都不经过它：
     * 于是「用户点开列表 → 关掉备份功能 / 工程路径失效」时，提示文字换成了
     * 「回退副本已关闭」，**下面那份列表却原样挂着**，行里的 ↺ 还点得动 ——
     * 界面在说「没这东西」，手上却在给入口。
     * 把它提到最前面，比在每条 return 前补一句可靠：以后再加分支也不会漏。 */
    if (bkListOpen) {
      bkListOpen = false;
      var early = $('bkList');
      if (early) {
        early.hidden = true;
        if (early.innerHTML !== '') early.innerHTML = '';
      }
    }

    if (!Backup || !hasNode) {
      el.textContent = '回退副本：需要 Node 环境';
      if (bo) bo.hidden = true;
      if (br) br.hidden = true;
      if (el.classList) el.classList.remove('clickable');
      el.title = '';
      return;
    }
    if (bo) bo.hidden = false;
    if (br) br.hidden = false;

    if (!backupEnabled()) {
      el.textContent = '回退副本已关闭（设置里可开）';
      if (br) br.hidden = true;
      if (el.classList) el.classList.remove('clickable');
      el.title = '';
      // btnBkOpen（↗ 打开备份文件夹）**故意不收**：它与备份开关是解耦的 ——
      // 关掉备份功能不等于用户不想翻已经存下的那些副本，那个按钮的 handler
      // 在无工程时会回退到 backupRoot() 开根目录，点了不会崩。
      // 写在这里是为了让下一个审计者别再把它当漏掉的 hidden 报上来。
      return;
    }
    if (!ST.projectPath) {
      el.textContent = '回退副本：打开一个已保存的工程后可用';
      if (br) br.hidden = true;
      if (el.classList) el.classList.remove('clickable');
      el.title = '';
      return;
    }

    var list = listBackups(ST.projectPath);
    var dir = backupDirFor(ST.projectPath) || '';
    var noteN = {};
    list.forEach(function (b) { if (b.note) noteN[b.note] = (noteN[b.note] || 0) + 1; });
    var oldN = (noteN['旧位置'] || 0) + (noteN['默认位置'] || 0);
    if (ST.bkFallback) bkDirWarn();      // 自定义落点用不上时，出声一次（不静默退回）
    // 命中次数由 BK_LIST_N 收口：面板只摊最近 3 份，全部仍在文件夹里可看

    // 目录固定写进 title：这一行本来就是「副本在哪」，不该只在「暂无」时才给路径。
    var tail = dir ? '\n\n目录：' + dir : '';
    if (ST.bkCustom) tail += '\n\n落点：自定义目录（设置 › 崩溃保护 › 副本目录）';
    if (noteN['旧位置']) {
      tail += '\n旧位置（1.6.0 及以前）还有 ' + noteN['旧位置'] + ' 份，可直接取回，不再往里写';
    }
    if (noteN['默认位置']) {
      tail += '\n默认位置还有 ' + noteN['默认位置'] + ' 份（落点已改到别处），可直接取回，不再往里写';
    }
    if (ST.bkFallback) {
      tail += '\n\n自定义目录不可用：' + customBackupDir() + '\n已退回默认位置，这次保护保存的副本在默认位置';
    }

    if (!list.length) {
      el.textContent = '回退副本：暂无（下次保护保存时生成）';
      el.title = (dir || '') + tail;
      if (el.classList) el.classList.remove('clickable');
      renderBackupList(list);   // 空列表会收起并清空 box，不再挂着上一次的行
      if (ST.guard.backupErr) el.textContent += ' · 上次备份失败：' + ST.guard.backupErr;
      return;
    }
    el.textContent = '回退副本 ' + list.length + ' 份 · 最近 ' + agoText(list[0].mtime) +
      (oldN ? ' · 另位置 ' + oldN + ' 份' : '') +
      (ST.bkFallback ? ' · 自定义目录不可用' : '') + (bkListOpen ? ' ▴' : ' ▾');
    el.title = '点击这一行展开最近 ' + BK_LIST_N + ' 份，逐份取回\n' +
      list.slice(0, 8).map(function (b) {
        return stamp(b.mtime) + '　' + fmtBytes(b.size) + (b.note ? '（' + b.note + '）' : '');
      }).join('\n') + tail;
    if (el.classList) el.classList.toggle('clickable', list.length > 0);
    renderBackupList(list);
    if (ST.guard.backupErr) el.textContent += ' · 上次备份失败：' + ST.guard.backupErr;
  }

  /* 最近 N 份副本的列表：一行一份（时间 / 大小 / 取回）。
   * 内容在这里生成而不写死在 html 里：它随工程与文件系统变化。
   *
   * 按钮上带的是**这一份的绝对路径**，不是下标 —— 列表行是渲染那一刻的快照，
   * 而点击发生在之后：这中间文件系统会变（新的保护保存落进一份、轮转删掉旧的、
   * 用户在 AE 里另存了工程）。若按钮只带下标，点击时再拿它去查一遍**新**列表，
   * 就会取到另一份（甚至 undefined）—— 用户点的是 14:32 那份，拿回的却是别的。
   * 路径是这份副本自己的身份，跟列表顺序无关，重读多少次都指向同一份。 */
  function renderBackupList(list) {
    var box = $('bkList');
    if (!box) return;
    var top = Backup ? Backup.recent(list, BK_LIST_N) : (list || []).slice(0, BK_LIST_N);
    if (!top.length) {
      if (box.innerHTML !== '') box.innerHTML = '';
      box.hidden = true;
      return;
    }
    box.innerHTML = top.map(function (b) {
      // 路径进 HTML 属性：四类字符必须转义，否则含引号的路径会把属性切断
      var key = String(b.path == null ? '' : b.path)
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return '<div class="bkl-r">' +
        '<span class="bkl-t">' + stampShort(b.mtime) + '</span>' +
        '<span class="bkl-s">' + fmtBytes(b.size) + '</span>' +
        (b.note ? '<span class="bkl-o">' + b.note + '</span>' : '') +
        '<button class="ibtn sm" data-bk="' + key + '" title="取回这一份（生成副本，不动原文件）">↺</button>' +
        '</div>';
    }).join('');
    // 150px 以下：时间 + 尺寸 + 按钮三列会挤成一团，尺寸列直接不显示
    applyWidthClasses();
    box.hidden = !bkListOpen;
  }

  /* 窄面板要收的列（1.7.0 抽出来）：原来只在渲染备份列表时算一次，拖动面板
     变窄不会立刻跟手；现在 resize 节流里也调它。 */
  function applyWidthClasses() {
    var box = $('bkList');
    if (!box || !box.classList) return;
    var w = (document && document.body) ? document.body.clientWidth : 0;
    box.classList.toggle('narrow', !!w && w < 150);
  }

  /* 自定义落点不可用：只出声一次（每次刷新都弹就成了噪音），面板那一行也常驻写着。 */
  function bkDirWarn() {
    if (ST.bkFallbackTold) return;
    ST.bkFallbackTold = true;
    toast('自定义副本目录不可用，本次已退回默认位置：' + customBackupDir());
  }

  /* 目录选择：走 CEP 的 showOpenDialog。没有它（浏览器里预览、权限受限）就如实提示手动填，
     不假装选过 —— 否则用户以为选了，副本还是落在老地方。 */
  function pickBackupDir() {
    var el = $('inBkDir');
    if (!el) return;
    var chosen = '';
    try {
      if (window.cep && window.cep.fs && window.cep.fs.showOpenDialog) {
        var r = window.cep.fs.showOpenDialog(false, false, '选择回退副本的存放目录', el.value || '');
        if (r && r.err === 0 && r.data && r.data.length) chosen = r.data[0];
      }
    } catch (e) { chosen = ''; }
    if (!chosen) { toast('这套环境不支持目录选择，请手动填写路径'); return; }
    el.value = chosen;
    mergeGuardCfg({ backupDir: chosen });
    syncBkDirHint();
    renderBackup();
    var eff = USR && USR.crashGuard ? USR.crashGuard.backupDir : '';
    toast(eff === chosen ? '回退副本目录：' + chosen : '这个路径不可用，已退回默认位置');
  }

  function syncBkDirHint() {
    var el = $('bkDirHint');
    if (!el) return;
    var c = customBackupDir();
    el.textContent = c ? '当前：' + c + '（下面按工程分文件夹）'
                       : '默认：工程目录旁的「AE-System-Monitor 备份」';
    el.title = c ? c : '';
  }

  /* 保存日志那一行：最近几次保存 + 日志文件位置（鼠标悬停看全文） */
  function renderSaves() {
    var el = $('gdSaves');
    if (!el) return;

    var p = saveLogPath();

    if (!logEnabled()) {
      el.textContent = '保存日志已关闭' + (p ? '（文件：' + shortPath(p) + '）' : '');
      el.title = '在设置 › 崩溃保护 里打开「记录每次保存」';
      return;
    }

    if (!ST.saves.length) {
      el.textContent = '保存日志：暂无记录' + (p ? ' · ' + shortPath(p) : '');
      el.title = p || '';
      return;
    }

    var recent = ST.saves.slice(-CFG.savesShown).reverse();
    el.textContent = '最近保存 ' + recent.map(function (s) {
      return (s.at.split(' ')[1] || '') + (s.ok ? ' ✓' : ' ✗');
    }).join(' · ');

    el.title = recent.map(function (s) {
      return s.at + ' · ' + s.why + ' · ' + s.ms + 'ms' +
             (s.ok ? ' · 成功' : ' · 失败：' + (s.note || '未知')) +
             (s.proj ? '\n' + s.proj : '');
    }).join('\n') + (p ? '\n\n日志文件：' + p : '');
  }

  /* ---------------- 渲染：警告与底栏 ---------------- */
  function updateAlert() {
    var box = $('alertBox'), txt = $('alertText');
    var c = ST.cache;

    function show(msg, danger) {
      txt.textContent = msg;
      box.className = danger ? 'alert danger' : 'alert';
      box.hidden = false;
    }

    if (!hasNode) {
      show('Node.js 未启用，无法读取缓存与系统信息。请确认 manifest.xml 中的 ' +
           '--enable-nodejs 与 --mixed-context 参数已生效，并重启 After Effects。');
      return;
    }

    if (!AE) {
      show('缓存探测模块 ae-cache.js 未加载，请检查扩展文件是否完整。');
      return;
    }

    if (ST.demo) {
      show('当前不在 After Effects 内运行，显示的是示例数据。');
      return;
    }

    if (c.verdict === 'bad') {
      show('缓存盘可用空间（' + fmtGB(c.driveFreeGB) + '）已小于缓存上限（' +
           fmtGB(c.quotaGB) + '），AE 无法写满缓存。建议调低上限或把缓存迁到更空的磁盘。', true);
      return;
    }

    if (c.verdict === 'warn') {
      show('AE 要求缓存盘在「上限 + ' + fmtGB(c.bufferGB) + ' 缓冲」之外仍有富余，当前仅 ' +
           fmtGB(c.driveFreeGB) + '，打开工程时可能提示磁盘空间不足。');
      return;
    }

    box.hidden = true;
  }

  function renderFoot() {
    var L = [];
    if (ST.lastAt) L.push('更新 ' + ST.lastAt.toLocaleTimeString('zh-CN', { hour12: false }));
    $('footLeft').textContent = L.join(' · ');

    var R = [];
    if (hasNode) R.push('Node ' + process.versions.node);
    if (ST.demo) R.push('示例数据');
    $('footRight').textContent = R.join(' · ');
  }

  /* 渲染指纹：所有会被画到界面上的数都进这个字符串。
     大多数轮次里这些值根本没变（磁盘 30 秒才动一次，缓存 25 秒才重扫），
     那就没必要把整块 DOM 重写一遍 —— 这是面板开着一下午时的主要开销。 */
  function renderSig() {
    var c = ST.cache, g = ST.guard, m = ST.mem, a = ST.ae, o = ST.other;
    return [
      c.used, c.files, c.quotaGB, c.verdict, c.marginGB, c.path, c.scanned, c.truncated,
      isFinite(c.driveFreeGB) ? c.driveFreeGB.toFixed(2) : 'na',
      m ? m.pct.toFixed(2) : 'nomem',
      ST.disks.length, ST.disksAt, ST.disksErr,
      g.risk, g.level, g.saved, g.savedAt, g.lastErr, g.saving ? 1 : 0,
      ST.saves.length, logEnabled() ? 1 : 0,
      a ? (a.v + '|' + a.p + '|' + a.d + '|' + a.n) : 'noae',
      ST.media.used, ST.media.files, ST.media.scanned,
      o.bytes, o.dirs.length, o.scanned,
      ST.projectPath, ST.proj.rq, ST.renderMuted, compact ? 1 : 0,
      ST.autoSave ? (ST.autoSave.enabled ? 1 : 0) : -1,
      ST.lastAutoSaved ? ST.lastAutoSaved.mtime : 0,
      USR ? (USR.miniMetric + '|' + USR.miniSub1 + '|' + USR.miniSub2) : ''
    ].join('~');
  }

  function renderAll(force) {
    var sig = renderSig();
    if (!force && sig === ST.sig) { renderFoot(); return; }
    ST.sig = sig;

    renderCache();
    renderOther();
    renderMedia();
    renderDisks();
    renderAE();
    renderGuard();
    renderRenderBadge();
    renderFoot();
    renderMini();
    updateAlert();
  }

  /* ---------------- 扫描调度 ---------------- */
  function scanCache(force) {
    var c = ST.cache;
    if (!c.path || !AE) return Promise.resolve();
    if (!force && c.scanned && (Date.now() - c.scanned) < CFG.cacheTTL) return Promise.resolve();

    $('liveDot').classList.add('scanning');
    return AE.scanDir(c.path, { cap: CFG.scanCap }).then(function (r) {
      c.used = r.bytes;
      c.files = r.files;
      c.truncated = r.truncated;
      c.scanned = Date.now();
      $('liveDot').classList.remove('scanning');
      computeMetrics();
      renderCache();
      renderDisks();
      updateAlert();
    }).catch(function () {
      $('liveDot').classList.remove('scanning');
    });
  }

  function scanMedia(force) {
    var m = ST.media;
    if (!m.path || !AE) return Promise.resolve();
    if (!force && m.scanned && (Date.now() - m.scanned) < CFG.mediaTTL) return Promise.resolve();

    return AE.scanDir(m.path, { cap: CFG.scanCap }).then(function (r) {
      m.used = r.bytes;
      m.files = r.files;
      m.scanned = Date.now();
      renderMedia();
    }).catch(function () {});
  }

  /* 其他版本 AE 的缓存目录：串行扫（不并发去抢盘），结果缓存 10 分钟 */
  function scanOtherVersions(force) {
    var o = ST.other;
    if (!AE || !ST.prefs || !ST.prefs.folder) return Promise.resolve();
    if (!force && o.scanned && (Date.now() - o.scanned) < CFG.otherCacheTTL) return Promise.resolve();

    var dirs = [];
    try {
      dirs = AE.otherVersionCacheDirs(ST.prefs.folder, ST.cache.path) || [];
    } catch (e) { dirs = []; }

    o.dirs = dirs;
    o.scanned = Date.now();

    if (!dirs.length) { o.bytes = 0; o.files = 0; renderOther(); return Promise.resolve(); }

    var i = 0, bytes = 0, files = 0;

    function step() {
      if (i >= dirs.length) {
        o.bytes = bytes;
        o.files = files;
        renderOther();
        return Promise.resolve();
      }
      var d = dirs[i++];
      return AE.scanDir(d, { cap: CFG.scanCap }).then(function (r) {
        bytes += r.bytes;
        files += r.files;
        return step();
      }).catch(function () { return step(); });
    }

    return step();
  }

  /* ---------------- 刷新主流程 ---------------- */
  function deriveCachePath() {
    var c = ST.cache;
    if (c.path || !AE) return;
    if (!ST.prefs) { c.error = 'no-prefs'; return; }

    c.prefsPath = ST.prefs.path;
    c.prefFolder = ST.prefs.folder;
    c.prefQuotaGB = ST.prefs.maxSizeGB;
    c.enabled = ST.prefs.enabled;
    c.bufferGB = ST.prefs.bufferGB;
    c.prefsVer = ST.prefs.ver || '';
    c.prefsMatched = (ST.prefs.verMatched === undefined) ? null : ST.prefs.verMatched;
    c.runVer = ST.prefs.runVer || AE.verShort(ST.ae && ST.ae.v) || '';

    // 缓存目录跟着「运行中的版本」走（每个版本的 AE 各写各的目录）。
    // 先 strict 只认精确目录：两个版本都装着时，resolveCacheDir 的深度兜底
    // 会挑「最近改动」的那个，而那很可能是另一个版本的。
    var runVer = AE.verShort(ST.ae && ST.ae.v) || '';
    var prefVer = ST.prefs.ver || '';
    var p = '';

    if (runVer) p = AE.resolveCacheDir(ST.prefs.folder, runVer, { strict: true });
    if (!p && prefVer && prefVer !== runVer) {
      p = AE.resolveCacheDir(ST.prefs.folder, prefVer, { strict: true });
    }
    if (!p) p = AE.resolveCacheDir(ST.prefs.folder, runVer || prefVer);  // 放手走兜底

    c.path = p;
  }

  /* ---------------- 提交内存（仅 Windows） ----------------
     AE 报 "Unable to allocate XXX MB of memory" 时，撞的是提交上限（commit limit），
     不是物理内存余量 —— 社区里 128 GB 的机器在内存只用 40% 时照样每 20 分钟报这个错。
     这是 Node 读不到的数，只能问系统：60 秒一次、异步执行、失败就保留上次读数。 */
  function updateCommit(force) {
    if (!hasNode || !exec || typeof process === 'undefined' || process.platform !== 'win32') return;
    if (ST.commitBusy) return;
    if (!force && ST.commitAt && Date.now() - ST.commitAt < 60000) return;

    ST.commitBusy = true;

    var ps = '@(Get-CimInstance Win32_OperatingSystem | ' +
             'Select-Object TotalVirtualMemorySize,FreeVirtualMemory) | ConvertTo-Json -Compress';
    var cmd = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + ps + '"';

    var done = false;
    function finish(v) {
      if (done) return;
      done = true;
      ST.commitBusy = false;
      ST.commitAt = Date.now();          // 失败也记时间，避免每轮都 spawn 一次
      if (isFinite(v)) ST.commitPct = v;
    }

    try {
      exec(cmd, { windowsHide: true, timeout: 8000 }, function (err, stdout) {
        if (err) { finish(NaN); return; }
        try {
          var o = JSON.parse(String(stdout || '').replace(/^\uFEFF/, '').trim());
          if (Array.isArray(o)) o = o[0];
          var lim = Number(o.TotalVirtualMemorySize);
          var free = Number(o.FreeVirtualMemory);
          if (!(lim > 0) || !isFinite(free)) { finish(NaN); return; }
          finish((1 - free / lim) * 100);
        } catch (e) { finish(NaN); }
      });
    } catch (e) { finish(NaN); }

    setTimeout(function () { finish(NaN); }, 9000);   // 兜底：别让 busy 卡死
  }

  /* 刷新链上任何一处抛出，都必须复位 ST.busy。
     否则下面那句 `if (ST.busy) return;` 会让整个刷新循环永久死亡：
     2026-10-26 在真机 AE + 真 CEP 环境下做注入实验验证过 —— 只要在 Promise.all
     之前抛一次异常，刷新计数立刻冻结，连点 4 次 ⟳ 加静置 8 秒都不恢复，
     只有重载面板才能救回来。 */
  function refreshFail(e) {
    ST.busy = false;
    try { if (console && console.error) console.error('[refresh] 异常，已复位 busy：', e); } catch (x) {}
  }

  /* readAE 的回调体是异步执行的，外面包 try 抓不到它内部抛的异常，
     所以必须在回调函数本身上套一层。 */
  function guardRefresh(fn) {
    return function (info) {
      try { fn.call(this, info); } catch (e) { refreshFail(e); }
    };
  }

  function refresh(force) {
    if (ST.busy) return;
    ST.busy = true;

    try {
      if (ST.interval > 0) $('liveDot').classList.remove('paused');

      // 快速项：先给即时反馈
      ST.mem = readMem();
      if (ST.mem) {
        ST.hist.push(ST.mem.pct);
        if (ST.hist.length > CFG.histMax) ST.hist.shift();
      }
      updateDisks(force);           // 带 TTL 与失败保留，失败时沿用上次有效读数
      updateCommit(force);          // 提交内存：AE 分配失败看的是它，不是物理余量

      renderMem();
      drawSpark();
      renderDisks();
    } catch (e) {
      refreshFail(e);
      return;                        // 这一段没跑到 readAE，直接收尾，别往下走
    }

    readAE(guardRefresh(function (info) {
      ST.ae = info;

      // 心跳：读不到 AE 的响应，说明主线程已被占死（渲染、或真卡住了）
      if (info) {
        ST.proj.d = (info.dirty === undefined) ? null : info.dirty;
        ST.proj.rev = info.rev || 0;
        ST.proj.rq = info.rq || 0;
        ST.proj.alive = true;
        ST.projectPath = info.p || '';   // 判定器依赖它，不能等到 renderAE 才赋值
      } else {
        ST.proj.alive = false;
      }

      // 渲染刚结束：只说一次，不补响积压的提醒
      if (ST.prevRq === 1 && ST.proj.rq !== 1) {
        var muted = ST.renderMuted;
        ST.renderMuted = 0;
        toast('渲染结束 · 提醒已恢复' + (muted ? '（期间静音 ' + muted + ' 条）' : ''));
      }
      ST.prevRq = ST.proj.rq;
      renderRenderBadge();
      startTimer();     // 渲染开始/结束时切到对应间隔（内部只在间隔变了才真的重设）

      // 偏好必须与「运行中的版本」对齐，且版本一变就重读。
      // 同时开两个 AE 版本时，用户切过去而面板还在跑：不重读就会一直用错的那份。
      // runVer 为空（这一拍没问到 AE）时不动，避免心跳抖动导致来回重读。
      var runVer = (AE && info) ? AE.verShort(info.v) : '';
      if (AE && (!ST.prefs || (runVer && ST.prefsFor !== runVer))) {
        ST.prefs = AE.loadPrefs(info ? info.v : '');
        ST.prefsFor = runVer;
        ST.cache.path = '';        // 版本变了，缓存目录必须重新定位
        ST.cache.error = '';
        ST.autoSave = null;        // 自动保存配置也是按版本存的
        ST.lastAutoSaved = null;
        ST.lastAutoSavedAt = 0;
      }
      deriveCachePath();

      if (!ST.autoSave && AE) {
        ST.autoSave = AE.loadAutoSavePrefs(ST.prefs ? ST.prefs.ver : null);
      }
      // 自动保存目录里的最新文件，每分钟刷新一次就够
      if (AE && ST.autoSave && (Date.now() - ST.lastAutoSavedAt > 60000)) {
        ST.lastAutoSaved = AE.latestAutoSave(ST.autoSave.folder);
        ST.lastAutoSavedAt = Date.now();
      }

      // 最近一次崩溃 + 本机崩溃画像：5 分钟看一次就够（这个事实不会瞬变）
      if (AE && AE.crashHistory && (Date.now() - ST.crashAt > 300000)) {
        var hist = null;
        try { hist = AE.crashHistory(); } catch (e) { hist = null; }
        ST.crashProfile = hist;
        ST.crash = hist ? hist.last : null;
        ST.crashAt = Date.now();
      }

      computeMetrics();
      renderCache();

      Promise.all([scanCache(force), scanMedia(force), scanOtherVersions(force)]).then(function () {
        ST.lastAt = new Date();
        computeMetrics();
        sampleCache();
        // 每轮只判定一次：判一次就更新一次心跳计数，重复判定会把失联次数放大
        evaluateGuard();
        renderAll();
        ST.busy = false;
      }).catch(function () {
        ST.lastAt = new Date();
        evaluateGuard();
        renderAll();
        ST.busy = false;
      });
    }));
  }

  /* 实际生效的间隔。用户选的间隔是上限，下面两种情况下要主动放慢：
     - 正在渲染：AE 主线程紧张，跟它抢 evalScript 只会两败俱伤
     - 面板不可见：没人看，30 秒的粗颗粒足够 */
  function effectiveInterval() {
    if (ST.interval <= 0) return 0;
    if (document.hidden) return Math.max(ST.interval, CFG.hiddenInterval);
    if (ST.proj.rq === 1) return Math.max(ST.interval, CFG.renderInterval);
    return ST.interval;
  }

  function startTimer() {
    var iv = effectiveInterval();
    if (ST.timer && ST.timerIv === iv) return;   // 间隔没变，不重设定时器

    stopTimer();
    ST.timerIv = iv;

    if (iv > 0) {
      ST.timer = setInterval(refresh, iv);
      $('liveDot').classList.remove('paused');
    } else {
      $('liveDot').classList.add('paused');
    }
  }

  function stopTimer() {
    if (ST.timer) { clearInterval(ST.timer); ST.timer = null; }
  }

  /* ---------------- 诊断简报 ---------------- */
  function buildReport() {
    var c = ST.cache, L = [];
    L.push('=== AE 系统监视器 ' + new Date().toLocaleString('zh-CN') + ' ===');

    if (ST.ae) L.push('After Effects ' + (ST.ae.v || '?') + '　工程: ' + (ST.ae.p || '未保存'));
    if (ST.prefs) L.push('偏好文件: ' + ST.prefs.path);

    L.push('缓存开关: ' + (c.enabled ? '启用' : '已禁用'));
    L.push('缓存目录: ' + (c.path || '未定位'));
    L.push('缓存已用: ' + fmtBytes(c.used) + ' / ' + c.files + ' 个文件');
    L.push('缓存上限: ' + fmtGB(c.quotaGB) + '（来源：' + (c.quotaSrc || '未知') + '）');
    L.push('填充率  : ' + c.fillPct.toFixed(1) + '%');
    L.push('安全缓冲: ' + fmtGB(c.bufferGB));
    L.push('所需空间: ' + fmtGB(c.needGB) + '（上限 + 缓冲）');
    L.push('磁盘可用: ' + (isFinite(c.driveFreeGB) ? fmtGB(c.driveFreeGB) + ' @ ' + c.drive : '未知'));
    L.push('结论    : ' + ({ ok: '空间充足', warn: '空间偏紧', bad: '空间不足' }[c.verdict] || '未知'));

    if (ST.other && ST.other.scanned) {
      L.push('其他版本缓存: ' + (ST.other.dirs.length
        ? fmtBytes(ST.other.bytes) + ' / ' + ST.other.dirs.length + ' 个目录 / ' + ST.other.files + ' 个文件'
        : '无（当前缓存盘上没有旧版本的缓存目录）'));
    }

    if (Trend) {
      var tr = Trend.describe(ST.cacheHist, c.marginGB);
      L.push('增速    : ' + tr.text + '（样本 ' + ST.cacheHist.length + ' 点）');
    }

    if (ST.media.path) {
      L.push('媒体缓存: ' + fmtBytes(ST.media.used) + ' / ' + ST.media.files + ' 个文件');
      L.push('          ' + ST.media.path);
    }
    if (ST.mem) {
      L.push('内存    : ' + fmtBytes(ST.mem.used) + ' / ' + fmtBytes(ST.mem.total) +
             '（' + ST.mem.pct.toFixed(1) + '%）');
    }
    L.push('提交内存: ' + (isFinite(ST.commitPct) ? ST.commitPct.toFixed(1) + '%' : '读取不到'));
    ST.disks.forEach(function (d) {
      L.push('磁盘 ' + d.name + ': ' + fmtBytes(d.free) + ' 可用 / ' + fmtBytes(d.total));
    });

    var g = ST.guard;
    L.push('');
    L.push('— 崩溃保护 —');
    L.push('风险    : ' + g.risk + '/100（' +
           ({ high: '高危', watch: '留意', ok: '正常' }[g.level] || '—') + '）');
    if (g.reasons.length) L.push('原因    : ' + g.reasons.join('；'));
    L.push('状态    : ' + (g.lastErr ? '上次保存失败：' + g.lastErr
                                   : g.savedAt ? '已于 ' + hhmmss(g.savedAt) + ' 自动保存（累计 ' + g.saved + ' 次）'
                                   : '本次会话尚未触发'));
    L.push('跳过原因: ' + ((Guard && Guard.BLOCK_LABELS[g.blocked]) || '无'));
    L.push('档位    : ' + ((Guard && Guard.MODES[USR.crashGuard.mode])
      ? Guard.MODES[USR.crashGuard.mode].label + '（最多攒 ' + USR.crashGuard.holdMin +
        ' 分钟 / 阈值 ' + USR.crashGuard.riskSave + ' 分）'
      : USR.crashGuard.mode));
    L.push('崩溃史  : ' + (ST.crashProfile && isFinite(ST.crashProfile.count30)
      ? '近 30 天 ' + ST.crashProfile.count30 + ' 次' +
        (isFinite(ST.crashProfile.medianGapH)
          ? '，平均间隔 ' + Math.round(ST.crashProfile.medianGapH) + ' 小时' : '')
      : '无记录'));
    L.push('上次崩溃: ' + (ST.crash
      ? agoText(ST.crash.time) + '前（' + (ST.crash.type === 'hang' ? '无响应' : '崩溃') +
        (ST.crash.codeText ? '，' + ST.crash.codeText : (ST.crash.code ? '，' + ST.crash.code : '')) + '）'
      : '本机无 WER 记录'));

    L.push('回退副本: ' + (function () {
      if (!backupEnabled()) return '已关闭';
      if (!ST.projectPath) return '未打开已保存的工程';
      var bl = listBackups(ST.projectPath);
      return bl.length ? (bl.length + ' 份，最近 ' + agoText(bl[0].mtime) +
                          '　' + backupDirFor(ST.projectPath)) : '暂无';
    })());

    if (logEnabled()) {
      L.push('保存日志: ' + (saveLogPath() || '不可用') + '（最近 ' + ST.saves.length + ' 条）');
      ST.saves.slice(-CFG.savesShown).forEach(function (s) {
        L.push('  ' + s.at + ' ' + (s.ok ? '成功' : '失败 ' + (s.note || '')) +
               ' ' + s.ms + 'ms ' + s.why);
      });
    } else {
      L.push('保存日志: 已关闭');
    }
    if (ST.autoSave) {
      L.push('AE 自带 : ' + (ST.autoSave.enabled ? '开启，每 ' + ST.autoSave.intervalMin +
             ' 分钟，保留 ' + ST.autoSave.maxVers + ' 版' : '已关闭'));
      L.push('自动保存目录: ' + (ST.autoSave.folder || '未知'));
      L.push('最近自动保存: ' + (ST.lastAutoSaved
             ? ST.lastAutoSaved.name + '（' + new Date(ST.lastAutoSaved.mtime).toLocaleString('zh-CN') + '）'
             : '目录内暂无文件'));
    }

    return L.join('\n');
  }

  function copyText(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    toast(ok ? '诊断简报已复制' : '复制失败');
  }

  function openFolder(p) {
    if (!hasNode || !p) return;
    try {
      var cmd = process.platform === 'win32'
        ? 'explorer "' + p + '"'
        : (process.platform === 'darwin' ? 'open "' + p + '"' : 'xdg-open "' + p + '"');
      require('child_process').exec(cmd);
    } catch (e) {
      toast('无法打开文件夹');
    }
  }

  /* ---------------- 上限手动设定 ---------------- */
  function enterQuotaEdit() {
    var c = ST.cache;
    $('quotaBtn').hidden = true;
    $('quotaEdit').hidden = false;
    var inp = $('quotaInput');
    inp.value = c.quotaGB ? Math.round(c.quotaGB) : '';
    inp.focus();
    inp.select();
  }

  function exitQuotaEdit() {
    $('quotaEdit').hidden = true;
    $('quotaBtn').hidden = false;
  }

  /* 手动上限收进设置里（原来裸存 localStorage['sysmon.quota']，既没范围校验、
     也不随「恢复默认」一起清掉）。0 = 自动检测。 */
  function setQuotaGB(v) {
    if (USR && Settings) {
      var src = JSON.parse(JSON.stringify(USR));
      src.quotaGB = v;
      USR = Settings.normalize(src);
      saveCfg();
      ST.quotaOverride = (USR.quotaGB > 0) ? USR.quotaGB : null;
    } else {
      ST.quotaOverride = (isFinite(v) && v > 0) ? v : null;
    }
  }

  function commitQuota() {
    var v = parseFloat($('quotaInput').value);
    if (!isFinite(v) || v <= 0) { exitQuotaEdit(); return; }
    setQuotaGB(v);
    exitQuotaEdit();
    computeMetrics();
    renderCache();
    updateAlert();
    toast('上限已设为 ' + fmtGB(ST.quotaOverride || v));
  }

  function resetQuota() {
    setQuotaGB(0);
    exitQuotaEdit();
    computeMetrics();
    renderCache();
    updateAlert();
    toast('已恢复自动检测');
  }

  /* ---------------- 提醒（无声音，纯视觉） ---------------- */
  function pushRemind(item) {
    if (!item) return;
    for (var i = 0; i < rmQueue.length; i++) {
      if (rmQueue[i].id === item.id) return;      // 队列里已有同一条
    }
    if (rmCur && rmCur.id === item.id) return;    // 正在显示同一条
    rmQueue.push(item);
    if (!rmCur) showNextRemind();
  }

  function showNextRemind() {
    if (rmCur || !rmQueue.length) return;
    var it = rmQueue.shift();
    rmCur = it;

    $('rmIco').textContent = it.icon || '•';
    $('rmTitle').textContent = it.title || '提醒';
    // 极简（小窗）模式用短消息：窄面板里长句会把动作按钮挤出可视区
    $('rmMsg').textContent = compact && it.shortMsg ? it.shortMsg : (it.msg || '');
    $('rmMsg').classList.remove('expanded');
    rmMsgExpanded = false;

    var bar = $('remindBar');
    bar.className = 'remind' + (it.level === 'warn' ? ' warn' : '');
    bar.hidden = false;

    // 折叠状态下靠圆环呼吸提示，不发出任何声音
    $('miniRing').classList.add('alerting');

    clearTimeout(rmTimer);
    rmTimer = setTimeout(dismissRemind, 25000);
  }

  function dismissRemind() {
    clearTimeout(rmTimer);
    $('remindBar').hidden = true;
    $('miniRing').classList.remove('alerting');
    rmCur = null;
    rmMsgExpanded = false;
    if (rmQueue.length) setTimeout(showNextRemind, 420);
  }

  /* 点标题在「短消息 / 完整消息」之间切换。
     小窗默认只显示短消息，没有这一步就永远看不到完整内容；
     正常模式本来显示完整消息，但矮面板下正文会被限高，点标题同样能取消限高。
     正常模式不能拿 shortMsg 去替换正文 —— 那会变成「点开完整提示反而变短」。 */
  var rmMsgExpanded = false;

  function toggleRemindMsg() {
    if (!rmCur) return;
    var msgEl = $('rmMsg');
    if (!msgEl) return;
    rmMsgExpanded = !rmMsgExpanded;
    msgEl.classList.toggle('expanded', rmMsgExpanded);
    if (!compact) return;
    if (!rmCur.shortMsg || rmCur.shortMsg === rmCur.msg) return;
    msgEl.textContent = rmMsgExpanded ? (rmCur.msg || '') : rmCur.shortMsg;
  }

  function reminderTick() {
    if (!USR || !ENG) return;
    var ctx = {
      memPct: ST.mem ? ST.mem.pct : null,
      memUsed: ST.mem ? ST.mem.used : null,
      memTotal: ST.mem ? ST.mem.total : null
    };
    var due = ENG.tick(USR, ctx);
    if (!due.length) return;

    // 渲染中静音。
    // 关键在「让引擎照常走完计时」：这样渲染两小时后不会一次性补响一串提醒，
    // 各条提醒的下一个周期从它们本该到点的时刻继续算。
    if (ST.proj.rq === 1) {
      ST.renderMuted += due.length;
      renderRenderBadge();
      return;
    }

    for (var i = 0; i < due.length; i++) pushRemind(due[i]);
  }

  /* ---------------- 设置抽屉 ---------------- */
  // 时间一律用数字输入自由填写，交给 Settings.normalize 统一裁剪
  var DW_FIELDS = [
    ['cbWater', 'inWater', 'water'],
    ['cbStand', 'inStand', 'stand'],
    ['cbEyes',  'inEyes',  'eyes'],
    ['cbMem',   'inMem',   'mem']
  ];

  /* 提醒设置区的摘要。
     原来只有四行一模一样的「勾选 + 数字」，用户看不出现在到底开了哪几条、
     间隔多少。这里把实际生效的状态直接写出来，改设置时能立刻确认结果。
     纯展示，不参与判定 —— 关掉这行不影响功能。 */
  var REMIND_LABELS = {
    water: '喝水', stand: '起身', eyes: '远眺', mem: '内存播报'
  };

  function syncRemindSummary() {
    var el = $('remindSummary');
    if (!el || !USR || !USR.reminders) { if (el) el.textContent = '—'; return; }
    var on = [], off = [];
    for (var k in REMIND_LABELS) {
      if (!REMIND_LABELS.hasOwnProperty(k)) continue;
      var rc = USR.reminders[k];
      if (!rc) continue;
      if (rc.on) on.push(REMIND_LABELS[k] + ' ' + rc.everyMin + '分');
      else off.push(REMIND_LABELS[k]);
    }
    var mh = USR.reminders.memHigh;
    var mhTxt = (mh && mh.on) ? ('内存偏高 ' + mh.thresholdPct + '%') : '';

    if (!on.length && !mhTxt) {
      el.textContent = '当前没有开启任何提醒。';
      return;
    }
    var parts = [];
    if (on.length) parts.push('已开启：' + on.join('、'));
    if (mhTxt) parts.push(mhTxt);
    if (off.length) parts.push('未开启：' + off.join('、'));
    el.textContent = parts.join('　·　');
  }

  /* 一次把三条身体提醒填成常用间隔。
     为什么给这个按钮：四个数字输入框要一个个点，
     而多数人其实就用默认那套间隔。
     注意：它只改数字不改开关 —— 开关是用户自己的选择。 */
  var REMIND_PRESET = { water: 45, stand: 60, eyes: 40, mem: 30 };

  function applyRemindPreset() {
    if (!Settings || !USR) return;
    var rem = {};
    for (var i = 0; i < DW_FIELDS.length; i++) {
      var f = DW_FIELDS[i];
      var id = f[2];
      rem[id] = {
        on: USR.reminders[id] ? !!USR.reminders[id].on : false,
        everyMin: REMIND_PRESET[id] !== undefined ? REMIND_PRESET[id] : 45
      };
    }
    USR = normFromUSR({ reminders: rem });
    saveCfg();
    syncDrawer();
    toast('已填入常用间隔：喝水 45 / 起身 60 / 远眺 40 / 内存 30 分');
  }

  /* 正在输入时的摘要预览。
     用抽屉里的实际控件值算，而不是 USR —— USR 要等 change 才更新。
     输入框里的值可能是空的或非法，这时退回 USR 里的原值，
     别让摘要显示出「NaN 分」这种东西。 */
  var REMIND_INPUTS = { inWater: 'water', inStand: 'stand', inEyes: 'eyes', inMem: 'mem' };
  var REMIND_INPUTS_CB = { water: 'cbWater', stand: 'cbStand', eyes: 'cbEyes', mem: 'cbMem' };

  function previewRemindSummary(inputId) {
    var el = $('remindSummary');
    if (!el || !USR || !USR.reminders) return;
    var id = REMIND_INPUTS[inputId];
    if (!id) return;
    var raw = $(inputId).value;
    var n = Number(raw);
    var rc = USR.reminders[id];
    var every = (raw !== '' && isFinite(n) && n >= 5 && n <= 240)
      ? Math.round(n)
      : (rc ? rc.everyMin : 45);

    var on = [], off = [];
    for (var k in REMIND_LABELS) {
      if (!REMIND_LABELS.hasOwnProperty(k)) continue;
      var r = USR.reminders[k];
      if (!r) continue;
      var isTarget = (k === id);
      var onNow = isTarget ? $(REMIND_INPUTS_CB[k]).checked : r.on;
      if (onNow) on.push(REMIND_LABELS[k] + ' ' + (isTarget ? every : r.everyMin) + '分');
      else off.push(REMIND_LABELS[k]);
    }
    var mh = USR.reminders.memHigh;
    var mhTxt = (mh && mh.on) ? ('内存偏高 ' + mh.thresholdPct + '%') : '';
    var parts = [];
    if (on.length) parts.push('已开启：' + on.join('、'));
    if (mhTxt) parts.push(mhTxt);
    if (off.length) parts.push('未开启：' + off.join('、'));
    el.textContent = parts.length ? parts.join('　·　') : '当前没有开启任何提醒。';
  }

  /* 提醒输入框 → 开关控件的对应表（preview 用） */

  function syncDrawer() {
    if (!USR) return;
    $('cbAuto').checked = !!USR.autoCollapse;
    if ($('selMetric')) $('selMetric').value = USR.miniMetric;
    if ($('selSub1')) $('selSub1').value = USR.miniSub1 || 'none';
    if ($('selSub2')) $('selSub2').value = USR.miniSub2 || 'none';
    pruneMiniSelects();
    if ($('selUiDefault')) $('selUiDefault').value = USR.uiDefault || 'compact';
    syncThemeUI();   // 抽屉里的主题色点要跟上当前值（1.7.1）
    syncRemindSummary();

    DW_FIELDS.forEach(function (f) {
      var rc = USR.reminders[f[2]];
      $(f[0]).checked = !!rc.on;
      $(f[1]).value = rc.everyMin;
    });

    var mh = USR.reminders.memHigh;
    $('cbMemHigh').checked = !!mh.on;
    $('inThr').value = mh.thresholdPct;
    $('inSustain').value = mh.sustain;
    $('inCool').value = mh.cooldownMin;

    var cg = USR.crashGuard;
    $('cbGuard').checked = !!cg.on;
    $('cbGuardWrite').checked = !!cg.autoSave;
    $('inGuardHold').value = cg.holdMin;
    $('inGuardRisk').value = cg.riskSave;
    $('inGuardCool').value = cg.cooldownMin;
    $('cbSaveLog').checked = !!cg.log;
    $('cbBackup').checked = !!cg.backup;
    $('inKeep').value = cg.keepBackups;
    if ($('inBkDir')) $('inBkDir').value = cg.backupDir || '';
    syncBkDirHint();
    syncLogHint();
    syncModeHint();
  }

  /* 档位说明：为什么要这个档，以及它是自动选的还是用户自己选的 */
  function syncModeHint() {
    var sel = $('selGuardMode');
    var el = $('modeHint');
    if (!USR) return;
    var cg = USR.crashGuard;

    if (sel) sel.value = cg.mode;

    if (!el) return;
    var label = (Guard && Guard.MODES[cg.mode]) ? Guard.MODES[cg.mode].label : cg.mode;
    var p = ST.crashProfile;
    var parts = [];

    if (p && isFinite(p.count30)) {
      parts.push('本机近 30 天崩过 ' + p.count30 + ' 次');
      if (isFinite(p.medianGapH) && p.medianGapH > 0) {
        parts.push('平均间隔约 ' + (p.medianGapH >= 48
          ? Math.round(p.medianGapH / 24) + ' 天'
          : Math.round(p.medianGapH) + ' 小时'));
      }
    } else {
      parts.push('本机没有崩溃记录');
    }
    if (cg.detectedAt) {
      parts.push('档位于 ' + agoText(cg.detectedAt) + '自动检测');
    }
    parts.push('「' + label + '」= 最多攒 ' + cg.holdMin + ' 分钟 / 阈值 ' + cg.riskSave + ' 分');

    el.textContent = parts.join(' · ');
  }

  /* 抽屉里把日志文件的完整位置写出来：用户要能自己去看，而不是只被告知「有记录」 */
  function syncLogHint() {
    var el = $('logHint');
    if (!el) return;

    var p = saveLogPath();
    if (!p) {
      el.textContent = '无法写入日志（需要 Node.js）';
      el.title = '';
      var nb = $('btnOpenLog');
      if (nb) nb.hidden = true;
      return;
    }

    el.textContent = (logEnabled() ? '日志：' : '日志已关闭，位置：') + p;
    el.title = p + '\n每行：时间 | 成败 | 原因 | 耗时 | 失败原因 | 工程路径';
    var b = $('btnOpenLog');
    if (b) b.hidden = false;
  }

  /* ---------------- 崩溃保护档位 ---------------- */

  /* 只改 crashGuard 的几个字段，其余原样保留。
     为什么不用「重建整个 crashGuard」：那样会把 mode / detectedAt 一起冲掉，
     用户每点一次设置就退回默认档，这种 bug 很难被察觉。 */
  function mergeGuardCfg(patch) {
    if (!Settings || !USR) return;
    var g = USR.crashGuard || {};
    var ng = {
      on: g.on, autoSave: g.autoSave, holdMin: g.holdMin, riskSave: g.riskSave,
      cooldownMin: g.cooldownMin, log: g.log, mode: g.mode, detectedAt: g.detectedAt,
      backup: g.backup, keepBackups: g.keepBackups, backupDir: g.backupDir
    };
    for (var k in patch) { if (patch.hasOwnProperty(k)) ng[k] = patch[k]; }

    USR = normFromUSR({ crashGuard: ng });
    saveCfg();
    if (grd) grd.configure(USR.crashGuard);
  }

  /* 切换档位：把该档的积压时长与风险阈值一起写进去，用户在抽屉里能直接看到数字变了 */
  function applyGuardMode(mode, opts) {
    if (!Guard || !USR) return null;
    opts = opts || {};
    var p = Guard.preset(mode);
    mergeGuardCfg({
      mode: p.mode,
      holdMin: p.holdMin,
      riskSave: p.riskSave,
      detectedAt: opts.stamp ? Date.now() : USR.crashGuard.detectedAt
    });
    syncDrawer();
    renderGuard();
    if (opts.toast) {
      toast('已切到「' + Guard.MODES[p.mode].label + '」：最多攒 ' +
            p.holdMin + ' 分钟，阈值 ' + p.riskSave + ' 分');
    }
    return p;
  }

  /* 读本机 WER 崩溃史 → 推荐一档 → 写进设置。
     装好第一次运行时自动跑一次；之后只有用户点「重新检测」才会再动。 */
  function detectGuardMode(opts) {
    if (!AE || !AE.crashHistory || !Guard || !USR) return null;
    opts = opts || {};

    var hist = null;
    try { hist = AE.crashHistory(); } catch (e) { hist = null; }
    ST.crashProfile = hist;
    ST.crash = hist ? hist.last : null;
    ST.crashAt = Date.now();

    var rec = Guard.recommend(hist);
    applyGuardMode(rec.mode, { stamp: true });
    renderGuard();

    if (opts.silent !== true) {
      toast('已按本机崩溃史设为「' + Guard.MODES[rec.mode].label + '」 · ' + rec.reason);
    }
    return rec;
  }

  function applyDrawer() {
    if (!Settings) return;

    var rem = {};
    DW_FIELDS.forEach(function (f) {
      rem[f[2]] = { on: $(f[0]).checked, everyMin: $(f[1]).value };
    });
    rem.memHigh = {
      on: $('cbMemHigh').checked,
      thresholdPct: $('inThr').value,
      sustain: $('inSustain').value,
      cooldownMin: $('inCool').value
    };

    USR = normFromUSR({
      autoCollapse: $('cbAuto').checked,
      miniMetric: $('selMetric') ? $('selMetric').value : USR.miniMetric,
      miniSub1: $('selSub1') ? $('selSub1').value : USR.miniSub1,
      miniSub2: $('selSub2') ? $('selSub2').value : USR.miniSub2,
      uiDefault: $('selUiDefault').value,
      // 缓存上限（quotaGB）与展开状态（ui）不再手写：normFromUSR 从整份 USR 出发，
      // 没提到的键自然原样带走 —— 老写法漏一行就会被重置成自动检测／首屏收起。
      crashGuard: {
        on: $('cbGuard').checked,
        autoSave: $('cbGuardWrite').checked,
        holdMin: $('inGuardHold').value,
        riskSave: $('inGuardRisk').value,
        cooldownMin: $('inGuardCool').value,
        log: $('cbSaveLog').checked,
        backup: $('cbBackup').checked,
        keepBackups: $('inKeep').value,
        backupDir: $('inBkDir') ? $('inBkDir').value : (USR.crashGuard.backupDir || ''),
        // 档位与检测时间必须原样带回，否则一次「确定」就把自动检测结果抹掉
        mode: $('selGuardMode') ? $('selGuardMode').value : USR.crashGuard.mode,
        detectedAt: USR.crashGuard.detectedAt || 0
      },
      reminders: rem
    });
    ST.quotaOverride = (USR.quotaGB > 0) ? USR.quotaGB : null;
    saveCfg();
    if (grd) grd.configure(USR.crashGuard);
    syncDrawer();      // 把被裁剪后的真实值回填，用户能看见 3 变成 5
    applyUiDefault();  // 「首屏视图」改完立即生效，用户不用重启面板
    applyCards();
    renderMini();
    evaluateGuard();
    renderGuard();
  }

  /* ---------------- 四个主项的收起 / 展开 ----------------
     首屏默认只给结论（已用 / 占比 / 判定），细节收起。
     这是刻意的取舍：面板通常被塞进很窄的侧栏，一上来铺满参数反而看不出重点。
     但 1.6.0 起这个取舍变成**可配置的**（USR.uiDefault）：
       compact  全部收起（极简，默认）
       full     全部展开（完整）
       remember 沿用上次会话里的展开状态
     用户在设置抽屉里改，改完立即生效。 */
  var CARD_IDS = { cache: 'Cache', mem: 'Mem', disk: 'Disk', guard: 'Guard' };

  function cardEl(k)  { return $('card' + CARD_IDS[k]); }
  function cardBtn(k) { return $('tg'   + CARD_IDS[k]); }

  /* 首屏该展开哪些。compact/full 直接决定；remember 用记住的状态。
     注意：这只在**首屏初始化**时调用一次（applyUiDefault）。
     运行期 applyCards 读的是 USR.ui —— 否则用户手动展开某一项会被 uiDefault 立刻按回去。 */
  function initialCardState() {
    var mode = (USR && USR.uiDefault) ? USR.uiDefault : 'compact';
    if (mode === 'full') {
      return { cache: true, mem: true, disk: true, guard: true };
    }
    if (mode === 'compact') {
      return { cache: false, mem: false, disk: false, guard: false };
    }
    var u = (USR && USR.ui) ? USR.ui : {};
    return {
      cache: !!u.cache, mem: !!u.mem, disk: !!u.disk, guard: !!u.guard
    };
  }

  /* 把「四张卡的展开状态」与「当前主题」合成一份完整的 ui。
     必须显式带上 theme：Settings.normalize 是按 SCHEMA 把 ui 整个重建的，
     ui 里漏掉 theme 就只能在 DEFAULTS 里取到 'mint' —— 于是
     applyUiDefault()（每次启动都会跑）与 setCard()（每次手动展开/收起）
     都会把用户选的主题悄悄冲回薄荷绿，还立刻 saveCfg() 写进盘里。
     这就是 1.7.5 之后「主题改完、重开就变回薄荷绿」的真因（1.7.6 修）。 */
  function uiWith(st) {
    var d = (Settings && Settings.DEFAULTS && Settings.DEFAULTS.ui) || {};
    var cur = (USR && USR.ui) || {};
    return {
      cache: !!st.cache, mem: !!st.mem, disk: !!st.disk, guard: !!st.guard,
      theme: cur.theme || d.theme || 'mint'
    };
  }

  /* 首屏应用 uiDefault。remember 模式下不动 USR.ui（沿用上次）。 */
  function applyUiDefault() {
    if (!Settings || !USR) return;
    if (USR.uiDefault === 'remember') return;
    var st = initialCardState();
    USR = normFromUSR({ ui: uiWith(st) });
    saveCfg();
  }

  function applyCards() {
    for (var k in CARD_IDS) {
      if (!CARD_IDS.hasOwnProperty(k)) continue;
      var open = !!(USR && USR.ui && USR.ui[k]);
      var el = cardEl(k), btn = cardBtn(k);
      if (el) el.classList.toggle('collapsed', !open);
      if (btn) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.title = open ? '收起' : '展开细节';
      }
    }
  }

  function setCard(k, open) {
    if (!Settings || !USR) return;
    var ui = {
      cache: !!USR.ui.cache, mem: !!USR.ui.mem,
      disk: !!USR.ui.disk, guard: !!USR.ui.guard
    };
    ui[k] = !!open;
    USR = normFromUSR({
      // 用户亲手展开/收起过某一项，就说明他要的是「沿用上次」而不是每次被
      // uiDefault 按回首屏状态 —— 所以这里顺手切到 remember（1.7.6）。
      uiDefault: 'remember',
      ui: uiWith(ui)
    });
    saveCfg();
    applyCards();
  }

  // 给自动化截图/排查用：在控制台里 __sysmonCard('cache', true) 就能展开某一项
  window.__sysmonCard = setCard;

  function openDrawer() {
    syncDrawer();
    $('mask').hidden = false;
    $('drawer').hidden = false;
  }

  function closeDrawer() {
    $('mask').hidden = true;
    $('drawer').hidden = true;
  }

  /* ---------------- 预览模式（非 AE 环境） ---------------- */
  function enableDemo() {
    ST.demo = true;
    $('modeBadge').hidden = false;

    ST.mem = { total: 32 * GB, free: 11.2 * GB, used: 20.8 * GB, pct: 65 };
    ST.disks = [
      { name: 'C:', total: 900.6 * GB, free: 197.7 * GB },
      { name: 'D:', total: 20 * GB, free: 7.8 * GB }
    ];
    ST.ae = { v: '24.2.1', n: 128, p: 'D:/Projects/Demo.aep', d: 1 };

    ST.prefs = {
      path: '…\\24.2\\Adobe After Effects 24.2 设置.txt',
      ver: '24.2',
      folder: 'C:\\Users\\…\\AppData\\Local\\Temp',
      maxSizeGB: 149,
      enabled: true,
      bufferGB: 10
    };

    var c = ST.cache;
    c.path = 'C:\\Users\\…\\AppData\\Local\\Temp\\Adobe\\After Effects\\24.2\\Disk Cache - DESKTOP.noindex';
    c.prefFolder = ST.prefs.folder;
    c.prefQuotaGB = 149;
    c.bufferGB = 10;
    c.enabled = true;
    c.used = 1.47 * GB;
    c.files = 608;
    c.scanned = Date.now();

    ST.media.path = 'C:\\Users\\…\\AppData\\Roaming\\Adobe\\Common\\Media Cache Files';
    ST.media.used = 300 * 1024 * 1024;
    ST.media.files = 190;
    ST.media.scanned = Date.now();

    // 预览里给一条「旧版本缓存」示例，避免这一行空着
    ST.other = {
      dirs: ['C:\\Users\\…\\AppData\\Local\\Temp\\Adobe\\After Effects\\23.0\\Disk Cache - DESKTOP.noindex'],
      bytes: 2.1 * GB,
      files: 940,
      scanned: Date.now()
    };
    ST.disksAt = Date.now();

    for (var i = 0; i < 40; i++) {
      ST.hist.push(52 + Math.sin(i / 3.2) * 9 + Math.random() * 5);
    }
    ST.lastAt = new Date();

    // 预览用示例值：让崩溃保护卡片也有内容可看，但不伪装成真实读数
    ST.autoSave = {
      enabled: true, intervalMin: 20, maxVers: 5, afterRender: true,
      folder: 'C:\\Users\\…\\Documents\\Adobe\\After Effects'
    };
    ST.lastAutoSaved = { name: 'Demo.aep', mtime: Date.now() - 14 * 60000, size: 48 * 1024 * 1024 };
    ST.guard.savedAt = Date.now() - 6 * 60000;
    ST.guard.saved = 3;

    // 造一段虚构采样，让「增速 / 还能撑多久」在预览里也能看到实际效果
    if (Trend) {
      ST.cacheHist = [];
      var t0 = Date.now() - 90 * 60000;
      for (var k = 0; k <= 90; k += 3) {
        Trend.push(ST.cacheHist, t0 + k * 60000, (4.6 + 0.012 * k) * GB);
      }
    }

    computeMetrics();
    evaluateGuard();
    renderMem(); drawSpark(); renderAll();
  }

  /* 老版本把上限裸存在 sysmon.quota 里，搬进设置后删掉旧键，避免两个来源打架 */
  function migrateQuota() {
    var raw = null;
    try { raw = localStorage.getItem('sysmon.quota'); } catch (e) { raw = null; }

    if (raw !== null) {
      var q = parseFloat(raw);
      if (isFinite(q) && q > 0 && USR && !(USR.quotaGB > 0)) setQuotaGB(q);
      try { localStorage.removeItem('sysmon.quota'); } catch (e) {}
    }

    ST.quotaOverride = (USR && USR.quotaGB > 0) ? USR.quotaGB : null;
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadCfg();
    buildMiniOptions();   // 小窗的三个下拉（1.6.5）：选项来自 settings 的 MINI_MAIN / MINI_SUB
    buildThemeOptions();  // 面板主题的两处色点（1.7.1）：选项来自 settings 的 THEMES
    applyTheme();         // 首屏就把上次选的主题穿上，晚一步会闪一下默认色
    migrateQuota();
    applyUiDefault();    // 首屏视图：极简 / 完整 / 沿用上次（1.6.0 起可配置）
    applyCards();        // 按 uiDefault 决定四个主项首屏是收起还是展开
    // 小窗形态（1.7.6）：miniWin 默认 true —— 装好一打开就是小窗；用户手动展开过
    // （miniWin=false）就照展开起。一律**读配置**，不猜面板宽度。
    // 放在 applyCards 之后：这里只换面板形态，卡片首屏状态仍由上面两步决定。
    // 走自动折叠（checkAutoCollapse）不写 miniWin，所以不会被「面板窄才折」带偏。
    if (USR && USR.miniWin) setCompact(true, true);
    if (Settings && Reminder) {
      ENG = Reminder.create({});
      // 每秒跑一次纯计算，不读磁盘、不读系统，开销可以忽略
      rmTick = setInterval(reminderTick, 1000);
    }

    if (Guard && USR) {
      grd = Guard.create(USR.crashGuard);
    }

    // 装好后第一次运行：读本机 WER 崩溃史，自动选一档并写入设置。
    // 只做一次（detectedAt 记着时间），之后不覆盖用户的手动选择。
    if (AE && Guard && USR && !USR.crashGuard.detectedAt) {
      detectGuardMode({ silent: false });
    }

    loadHist();   // 上次会话的采样点，避免一打开就"采样中"
    loadSaveLog(); // 上次会话的保存记录，重启后仍能回答「它到底存过没有」

    $('btnRefresh').addEventListener('click', function () {
      var b = this;
      b.classList.remove('spin');
      void b.offsetWidth;
      b.classList.add('spin');
      refresh(true);
    });

    $('btnCopy').addEventListener('click', function () { copyText(buildReport()); });

    // 面板主题（1.7.1）：顶部色点开关小面板；顶部与抽屉两处都用同一套事件委托
    $('btnTheme').addEventListener('click', function (e) {
      e.stopPropagation();
      var pop = $('themePop');
      if (pop) pop.hidden = !pop.hidden;
    });
    if ($('themePop')) $('themePop').addEventListener('click', themePick);
    if ($('themeRow')) $('themeRow').addEventListener('click', themePick);

    $('btnOpen').addEventListener('click', function () {
      var p = ST.cache.path || ST.cache.prefFolder;
      if (!p) { toast('还没有定位到缓存目录'); return; }
      openFolder(p);
    });

    $('btnOther').addEventListener('click', function () {
      var d = (ST.other.dirs && ST.other.dirs.length) ? ST.other.dirs[0] : '';
      if (!d) { toast('没有其他版本的缓存目录'); return; }
      openFolder(d);
    });

    $('btnOpenLog').addEventListener('click', function () {
      var p = saveLogPath();
      if (!p) { toast('日志不可用（需要 Node.js）'); return; }
      openFolder(pathmod.dirname(p));
    });

    // 切档位：立刻把该档的数字写进设置，并给出反馈（不然用户不知道改了什么）
    var selMode = $('selGuardMode');    if (selMode) {
      selMode.addEventListener('change', function () {
        applyGuardMode(this.value, { toast: true });
      });
    }

    // 重新检测：只在用户主动点的时候重读 WER
    var btnDetect = $('btnGuardDetect');
    if (btnDetect) {
      btnDetect.addEventListener('click', function () {
        if (!AE || !AE.crashHistory) { toast('检测需要 Node 环境（在 AE 面板里可用）'); return; }
        detectGuardMode({ silent: false });
        syncModeHint();
      });
    }

    var bkOpen = $('btnBkOpen');
    if (bkOpen) {
      bkOpen.addEventListener('click', function () {
        var d = ST.projectPath ? backupDirFor(ST.projectPath) : backupRoot();
        if (!d) { toast('需要 Node 环境'); return; }
        // 目录还没被创建时：有旧位置的副本就打开旧位置，否则才提示
        if (!fs.existsSync(d)) {
          var oldDir = ST.projectPath ? legacyBackupDirFor(ST.projectPath) : '';
          if (oldDir && fs.existsSync(oldDir)) { openFolder(oldDir); return; }
          toast('还没有备份目录（下次保护保存时创建）');
          return;
        }
        openFolder(d);
      });
    }
    var bkRestore = $('btnBkRestore');
    if (bkRestore) bkRestore.addEventListener('click', restoreLatest);

    // 回退副本落点：选目录 / 用默认（1.6.4 起用户可改）
    var bkPick = $('btnBkDirPick');
    if (bkPick) bkPick.addEventListener('click', pickBackupDir);
    var bkReset = $('btnBkDirReset');
    if (bkReset) bkReset.addEventListener('click', function () {
      var el = $('inBkDir');
      if (el) el.value = '';
      mergeGuardCfg({ backupDir: '' });
      syncBkDirHint();
      renderBackup();
      toast('回退副本已用默认位置（工程目录旁）');
    });

    // 点「回退副本」那一行展开/收起最近 3 份（没有副本时不给空列表）
    var bkHintEl = $('bkHint');
    if (bkHintEl) bkHintEl.addEventListener('click', function () {
      if (!ST.projectPath) { toast('先打开一个已保存的工程'); return; }
      if (!listBackups(ST.projectPath).length) { toast('还没有回退副本（下次保护保存时生成）'); return; }
      bkListOpen = !bkListOpen;
      renderBackup();
    });

    // 逐份取回：用事件委托，列表行是动态生成的，不能逐个绑
    var bkListEl = $('bkList');
    if (bkListEl) bkListEl.addEventListener('click', function (e) {
      var t = e.target;
      var key = (t && t.getAttribute) ? t.getAttribute('data-bk') : null;
      // key 为空时也要出声，不能静默 return：那是「用户点了 ↺ 却什么都没发生」。
      // 正常情况下 listBackups() 保证 path 恒非空（见其过滤），所以这是防御性分支；
      // 但防御分支上更该给反馈 —— 静默失败是最难报上来的一类 bug。
      if (!key) { toast('这一份没能定位（列表可能已刷新），请重新展开'); return; }
      // 按**路径**认那一份，不按下标认位置（见 renderBackupList 的说明）。
      // 认身份走 Backup.pickByPath：这条路径是单测覆盖的，不在接线层再写一份等价逻辑。
      // 重读列表是为了拿到 mtime/size 这些点击当下的事实，找的是同一个 path。
      var fresh = ST.projectPath ? listBackups(ST.projectPath) : [];
      var one = Backup ? Backup.pickByPath(fresh, key) : null;
      if (!one) {
        // 展开之后、点击之前，那份被轮转删掉了（或工程换了）
        toast('那一份已经不在了（可能被轮转清理或工程已切换），请重新展开');
        bkListOpen = false;
        renderBackup();
        return;
      }
      restorePick(one);
      bkListOpen = false;
      renderBackup();
    });

    // 小窗指标三个下拉（1.6.5）：选完立刻生效，重复的那格自动留空
    var miniSels = [$('selMetric'), $('selSub1'), $('selSub2')];
    for (var msi = 0; msi < miniSels.length; msi++) {
      if (miniSels[msi]) miniSels[msi].addEventListener('change', applyMiniChoice);
    }

    // 四个主项的展开键（右上角）
    for (var ck in CARD_IDS) {
      if (!CARD_IDS.hasOwnProperty(ck)) continue;
      (function (key) {
        var b = cardBtn(key);
        if (!b) return;
        b.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          setCard(key, !(USR && USR.ui && USR.ui[key]));
        });
      })(ck);
    }

    $('intervalSel').addEventListener('change', function () {
      ST.interval = parseInt(this.value, 10) || 0;
      startTimer();
      toast(ST.interval ? '每 ' + (ST.interval / 1000) + ' 秒刷新' : '已切换为手动刷新');
    });

    $('quotaBtn').addEventListener('click', enterQuotaEdit);
    $('quotaOk').addEventListener('click', commitQuota);
    $('quotaAuto').addEventListener('click', resetQuota);
    $('quotaInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') commitQuota();
      if (e.key === 'Escape') exitQuotaEdit();
    });

    /* ---- 折叠 / 设置 / 提醒 ---- */
    $('btnCompact').addEventListener('click', function () { toggleCompact(); });
    $('miniExpand').addEventListener('click', function () { toggleCompact(); });
    $('miniRing').addEventListener('click', function () { toggleCompact(); });
    $('btnCfg').addEventListener('click', openDrawer);
    $('miniCfg').addEventListener('click', openDrawer);
    $('dwClose').addEventListener('click', closeDrawer);
    $('mask').addEventListener('click', closeDrawer);
    $('drawer').addEventListener('change', applyDrawer);
    // 数字框的 change 只在失焦/回车时才触发，摘要要实时更新就得听 input。
    // 这里只更新摘要那行显示，不动 USR —— 避免边打字边写配置。
    $('drawer').addEventListener('input', function (e) {
      var t = e.target;
      if (!t) return;
      if (t.id === 'inWater' || t.id === 'inStand' || t.id === 'inEyes' || t.id === 'inMem') {
        previewRemindSummary(t.id);
      }
    });

    $('dwReset').addEventListener('click', function () {
      if (!Settings) return;
      USR = Settings.defaults();
      saveCfg();
      ST.quotaOverride = null;        // 上限也一起回到「自动检测」
      if (grd) grd.configure(USR.crashGuard);
      syncDrawer();
      applyUiDefault();               // 默认视图也跟着回到「极简」
      applyCards();
      computeMetrics();
      renderCache();
      updateAlert();
      renderMini();
      evaluateGuard();
      renderGuard();
      toast('已恢复默认设置');
    });

    $('rmOk').addEventListener('click', dismissRemind);
    $('rmSnooze').addEventListener('click', function () {
      if (rmCur && ENG) ENG.snooze(rmCur.id, 10);
      dismissRemind();
      toast('10 分钟后再提醒');
    });

    if ($('btnRemindPreset')) {
      $('btnRemindPreset').addEventListener('click', applyRemindPreset);
    }

    if ($('rmTitle')) {
      $('rmTitle').addEventListener('click', toggleRemindMsg);
      $('rmTitle').style.cursor = 'pointer';
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('drawer').hidden) closeDrawer();
    });

    /* 1.7.0：拖动面板时每个 resize 事件都全量重绘（spark + 磁盘列表 + 小窗）
       是「缩放有延迟」的另一半原因（布局过渡已在 CSS 侧去掉）。改成 rAF 合并：
       一帧最多跑一次，且只做跟手的部分；canvas 尺寸真变了才重画 spark。 */
    var rsPending = false, rsW = 0, rsH = 0;
    function onResize() {
      rsPending = false;
      applyWidthClasses();
      checkAutoCollapse();
      renderMini();
      var w = window.innerWidth, h = window.innerHeight;
      if (w !== rsW || h !== rsH) {
        rsW = w; rsH = h;
        drawSpark(true);
        renderDisks();
      }
    }
    window.addEventListener('resize', function () {
      if (rsPending) return;
      rsPending = true;
      if (window.requestAnimationFrame) window.requestAnimationFrame(onResize);
      else setTimeout(onResize, 60);
    });

    // 面板被 AE 收进后台时没人看这些数，放慢到 30 秒；切回前台立刻补一次
    document.addEventListener('visibilitychange', function () {
      startTimer();
      if (!document.hidden) refresh(false);
    });

    syncDrawer();

    if (!hasNode && !hasCEP) {
      enableDemo();
      checkAutoCollapse();
      return;
    }

    if (hasNode) {
      ST.media.path = process.platform === 'win32'
        ? pathmod.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'Common', 'Media Cache Files')
        : pathmod.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'Common', 'Media Cache Files');
      $('mediaPath').textContent = shortPath(ST.media.path);
      $('mediaPath').title = ST.media.path;
    }

    ST.interval = parseInt($('intervalSel').value, 10);
    if (!isFinite(ST.interval)) ST.interval = CFG.defaultInterval;

    refresh(false);
    startTimer();
    syncDrawer();
    checkAutoCollapse();
    renderMini();
    renderMiniStats();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
