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

  function loadCfg() {
    var raw = '';
    try { raw = localStorage.getItem(CFG_KEY) || ''; } catch (e) {}
    if (!Settings) { USR = null; return; }
    USR = raw ? Settings.parse(raw) : Settings.defaults();
  }

  function saveCfg() {
    if (!USR || !Settings) return;
    try { localStorage.setItem(CFG_KEY, Settings.stringify(USR)); } catch (e) {}
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
  }

  /* ---------------- 渲染：内存 ---------------- */
  function renderMem() {
    var m = ST.mem, ring = $('ramRing');

    if (!m) {
      $('ramPct').textContent = '--';
      $('ramUsed').textContent = '-- / --';
      $('ramFree').textContent = '空闲 --';
      ring.style.setProperty('--p', 0);
      return;
    }

    var p = Math.round(m.pct);
    var col = colorBy(m.pct, CFG.ramWarn, CFG.ramBad) || 'var(--accent)';

    $('ramPct').textContent = p + '%';
    $('ramPct').style.color = col;
    ring.style.setProperty('--p', p.toFixed(1));
    ring.style.setProperty('--rc', col);

    $('ramUsed').textContent = fmtBytes(m.used) + ' / ' + fmtBytes(m.total);
    $('ramFree').textContent = '空闲 ' + fmtBytes(m.free);

    // 展开区的两项：提交内存是 AE 分配失败的关键，别藏在 tooltip 里
    var ce = $('memCommit');
    if (ce) ce.textContent = isFinite(ST.commitPct) ? ST.commitPct.toFixed(0) + '%' : '--';
    var fe = $('memFree');
    if (fe) fe.textContent = fmtBytes(m.free);

    renderMini();
  }

  /* ---------------- 折叠小窗 ---------------- */
  // 小窗只回答一件事：当前那个百分比是多少。
  // 指标可在设置里切成「缓存填充率」或「内存占用」。
  function renderMini() {
    var pctEl = $('miniPct'), labEl = $('miniLabel'), ring = $('miniRing');
    if (!pctEl || !ring) return;

    var metric = (USR && USR.miniMetric) || 'cache';
    var p = 0, label = '缓存', col = '';

    if (metric === 'mem') {
      label = '内存';
      p = ST.mem ? ST.mem.pct : NaN;
      col = isFinite(p) ? (colorBy(p, CFG.ramWarn, CFG.ramBad) || '') : '';
    } else {
      label = '缓存';
      p = ST.cache.fillPct;
      col = isFinite(p) && ST.cache.quotaGB ? (colorBy(p, 85, 97) || '') : '';
    }

    var ok = isFinite(p);
    pctEl.textContent = ok ? Math.round(p) + '%' : '--';
    labEl.textContent = label;
    ring.style.setProperty('--p', (ok ? clamp(p, 0, 100) : 0).toFixed(1));
    if (col) ring.style.setProperty('--rc', col);
    else ring.style.removeProperty('--rc');

    ring.title = label + ' ' + (ok ? Math.round(p) + '%' : '--') +
                 (metric === 'cache' && ST.cache.quotaGB
                   ? '（' + fmtBytes(ST.cache.used) + ' / ' + fmtGB(ST.cache.quotaGB) + '）'
                   : '') +
                 '　点击展开';
  }

  function setCompact(on, silent) {
    compact = !!on;
    document.body.classList.toggle('compact', compact);
    if (!compact) autoCollapsed = false;
    renderMini();
    if (!silent) toast(compact ? '已折叠' : '已展开');
  }

  function toggleCompact(silent) {
    autoCollapsed = false;
    setCompact(!compact, silent);
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

  function backupRoot(projectPath) {
    // 优先放在工程所在卷，避免大工程备份挤满系统盘；路径不可用时回退到本机目录。
    if (projectPath && hasNode && pathmod) {
      try {
        var parent = pathmod.dirname(projectPath);
        if (fs.existsSync(parent)) return pathmod.join(parent, '.ae-system-monitor-backups');
      } catch (e) {}
    }
    var dir = localDataDir();
    return dir ? pathmod.join(dir, 'backup') : '';
  }

  function backupDirFor(projectPath) {
    var root = backupRoot(projectPath);
    if (!root || !Backup || !projectPath) return '';
    return pathmod.join(root, Backup.folderFor(projectPath));
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

  /* 最新在前：文件名里带时间戳，字典序倒排即时间倒排 */
  function listBackups(projectPath) {
    var dir = backupDirFor(projectPath);
    if (!dir || !fs || !fs.existsSync(dir)) return [];
    var out = [];
    try {
      fs.readdirSync(dir).forEach(function (n) {
        if (!/\.aepx?$/i.test(n)) return;
        var p = pathmod.join(dir, n);
        var st = null;
        try { st = fs.statSync(p); } catch (e) { return; }
        out.push({ name: n, path: p, size: st.size, mtime: st.mtimeMs });
      });
    } catch (e) {}
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

      var dest = pathmod.join(dir, Backup.backupName(projectPath, Date.now()));
      fs.copyFileSync(projectPath, dest);
      // 再次核验字节数，避免不完整副本被标成可回退版本。
      if (fs.statSync(dest).size !== fs.statSync(projectPath).size) {
        try { fs.unlinkSync(dest); } catch (ignore) {}
        return { ok: false, err: '副本大小校验未通过' };
      }

      // 轮转：只留最近 keep 份
      var keepN = (USR.crashGuard && USR.crashGuard.keepBackups) || 5;
      var names = listBackups(projectPath).map(function (b) { return b.name; });
      Backup.rotate(names, keepN).remove.forEach(function (n) {
        try { fs.unlinkSync(pathmod.join(dir, n)); } catch (e) {}
      });

      return { ok: true, path: dest };
    } catch (e) {
      return { ok: false, err: e.message || String(e) };
    }
  }

  /* 取回最近一份：生成「（回退 时间）」副本，不动原文件 */
  function restoreLatest() {
    if (!Backup || !hasNode || !ST.projectPath) { toast('先打开一个已保存的工程'); return; }
    var list = listBackups(ST.projectPath);
    if (!list.length) { toast('还没有回退副本（下次保护保存时生成）'); return; }

    var dir = pathmod.dirname(ST.projectPath);
    var dest = pathmod.join(dir, Backup.restoreName(ST.projectPath, list[0].mtime));
    try {
      if (fs.existsSync(dest)) { toast('同名回退副本已存在，稍后再试'); return; }
      fs.copyFileSync(list[0].path, dest);
      toast('已生成回退副本：' + pathmod.basename(dest));
      openFolder(dir);
    } catch (e) {
      toast('取回失败：' + (e.message || e));
    }
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
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

  /* 回退副本：只报「有几份、最近一次」，不摊开列表 —— 列表在文件夹里看更实在 */
  function renderBackup() {
    var el = $('bkHint');
    if (!el) return;

    var bo = $('btnBkOpen'), br = $('btnBkRestore');

    if (!Backup || !hasNode) {
      el.textContent = '回退副本：需要 Node 环境';
      if (bo) bo.hidden = true;
      if (br) br.hidden = true;
      return;
    }
    if (bo) bo.hidden = false;
    if (br) br.hidden = false;

    if (!backupEnabled()) {
      el.textContent = '回退副本已关闭（设置里可开）';
      if (br) br.hidden = true;
      return;
    }
    if (!ST.projectPath) {
      el.textContent = '回退副本：打开一个已保存的工程后可用';
      if (br) br.hidden = true;
      el.title = '';
      return;
    }

    var list = listBackups(ST.projectPath);
    if (!list.length) {
      el.textContent = '回退副本：暂无（下次保护保存时生成）';
      el.title = backupDirFor(ST.projectPath) || '';
    } else {
      el.textContent = '回退副本 ' + list.length + ' 份 · 最近 ' + agoText(list[0].mtime);
      el.title = list.slice(0, 8).map(function (b) {
        return stamp(b.mtime) + '　' + fmtBytes(b.size);
      }).join('\n');
    }
    if (ST.guard.backupErr) el.textContent += ' · 上次备份失败：' + ST.guard.backupErr;
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
      USR ? USR.miniMetric : ''
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

  function refresh(force) {
    if (ST.busy) return;
    ST.busy = true;

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

    readAE(function (info) {
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
    });
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

  /* 极简模式下点标题可以来回切换「短消息 / 完整消息」。
     没有这一步的话，极简模式的用户永远看不到完整提示内容
     （小窗放不下）。 */
  var rmMsgExpanded = false;

  function toggleRemindMsg() {
    if (!rmCur) return;
    var msgEl = $('rmMsg');
    if (!msgEl) return;
    if (!rmCur.shortMsg || rmCur.shortMsg === rmCur.msg) return;
    rmMsgExpanded = !rmMsgExpanded;
    msgEl.textContent = rmMsgExpanded ? (rmCur.msg || '') : rmCur.shortMsg;
    msgEl.classList.toggle('expanded', rmMsgExpanded);
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
    USR = Settings.normalize({
      autoCollapse: USR.autoCollapse,
      miniMetric: USR.miniMetric,
      uiDefault: USR.uiDefault,
      quotaGB: USR.quotaGB || 0,
      ui: USR.ui,
      crashGuard: USR.crashGuard,
      reminders: rem
    });
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
    $('selMetric').value = USR.miniMetric;
    if ($('selUiDefault')) $('selUiDefault').value = USR.uiDefault || 'compact';
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
      backup: g.backup, keepBackups: g.keepBackups
    };
    for (var k in patch) { if (patch.hasOwnProperty(k)) ng[k] = patch[k]; }

    USR = Settings.normalize({
      autoCollapse: USR.autoCollapse,
      miniMetric: USR.miniMetric,
      uiDefault: USR.uiDefault,
      quotaGB: USR.quotaGB || 0,
      ui: USR.ui,
      crashGuard: ng,
      reminders: USR.reminders
    });
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

    USR = Settings.normalize({
      autoCollapse: $('cbAuto').checked,
      miniMetric: $('selMetric').value,
      uiDefault: $('selUiDefault').value,
      quotaGB: USR.quotaGB || 0,          // 上限不在抽屉里改，但要原样带回去，否则会被重置成自动
      ui: USR.ui,                          // 展开状态同理，不能被一次「确定」重置回首屏收起
      crashGuard: {
        on: $('cbGuard').checked,
        autoSave: $('cbGuardWrite').checked,
        holdMin: $('inGuardHold').value,
        riskSave: $('inGuardRisk').value,
        cooldownMin: $('inGuardCool').value,
        log: $('cbSaveLog').checked,
        backup: $('cbBackup').checked,
        keepBackups: $('inKeep').value,
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

  /* 首屏应用 uiDefault。remember 模式下不动 USR.ui（沿用上次）。 */
  function applyUiDefault() {
    if (!Settings || !USR) return;
    if (USR.uiDefault === 'remember') return;
    var st = initialCardState();
    USR = Settings.normalize({
      autoCollapse: USR.autoCollapse,
      miniMetric: USR.miniMetric,
      uiDefault: USR.uiDefault,
      quotaGB: USR.quotaGB || 0,
      ui: st,
      crashGuard: USR.crashGuard,
      reminders: USR.reminders
    });
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
    USR = Settings.normalize({
      autoCollapse: USR.autoCollapse,
      miniMetric: USR.miniMetric,
      uiDefault: USR.uiDefault,
      quotaGB: USR.quotaGB || 0,
      ui: ui,
      crashGuard: USR.crashGuard,
      reminders: USR.reminders
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
    migrateQuota();
    applyUiDefault();    // 首屏视图：极简 / 完整 / 沿用上次（1.6.0 起可配置）
    applyCards();        // 按 uiDefault 决定四个主项首屏是收起还是展开
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
        if (!fs.existsSync(d)) { toast('还没有备份目录（下次保护保存时创建）'); return; }
        openFolder(d);
      });
    }
    var bkRestore = $('btnBkRestore');
    if (bkRestore) bkRestore.addEventListener('click', restoreLatest);

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

    window.addEventListener('resize', function () {
      drawSpark(true);
      renderDisks();
      checkAutoCollapse();
      renderMini();
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
