/* ============================================================
 * purgewatch.js — AE 退出后清磁盘缓存（1.7.16 的 B 方案，纯逻辑）
 *
 * 为什么必须等 AE 退出：
 *   面板永远运行在 AE 里。缓存桶（Disk Cache - <主机名>.noindex）里的
 *   .aecache 是 AE 正在用的文件 —— 它没关就删，等于在它脚下抽砖。
 *   AE 24.3 之前脚本层没有「清磁盘缓存」的入口（ALL_CACHES 只清 RAM），
 *   所以在 24.2 上想真清掉，只有「AE 关掉之后动手」这一条路。
 *
 * 五条边界（写死，不许后加）：
 *   1) 只删 *.aecache；桶目录、.lst、桶里的其它文件一概不碰。
 *   2) 进回收站，不进黑洞 —— 删错了能捞回来。
 *   3) 登记要两次点击（沿用面板的 4 秒时间窗），登记后随时可取消。
 *   4) 全程写日志：登记 / 等待 / 实际删了多少 / 为什么没删。
 *   5) 最多等 12 小时；超时就自己退出，不留一个永远挂着的进程。
 *
 * 本文件不碰 DOM，也不直接 require —— fs / spawn / path 由调用方注入，
 * 这样才能在没有 CEP、没有 PowerShell 的测试环境里把逻辑跑一遍。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonPurgeWatch = api;
  } catch (e) {}
})(this, function () {
  'use strict';

  var FOLDER = 'AESystemMonitor';
  var PS1_NAME = 'purge-on-exit.ps1';
  var MARK_NAME = 'purge-on-exit.json';
  var LOG_NAME = 'purge-on-exit.log';
  var MAX_HOURS = 12;

  /* 路径：全部落在面板自己的目录里（与 purge.log / saves.log 同处） */
  function paths(baseDir) {
    var b = String(baseDir || '').replace(/[\\\/]+$/, '');
    return {
      ps1: b + '\\' + PS1_NAME,
      marker: b + '\\' + MARK_NAME,
      log: b + '\\' + LOG_NAME,
      folder: b
    };
  }

  function psQuote(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'";
  }

  /* 生成看门脚本。
     dirs：要清的缓存桶目录（绝对路径）
     关键点：每一轮都检查 marker 是否还在 —— 用户取消时删掉 marker，脚本下一轮就退出，
     不需要去杀进程（杀错了更糟）。 */
  function script(o) {
    o = o || {};
    var dirs = o.dirs || [];
    var log = o.log || '';
    var marker = o.marker || '';
    var procNames = o.procNames || ['AfterFX'];
    var hours = Number(o.maxHours) > 0 ? Number(o.maxHours) : MAX_HOURS;

    var dirList = dirs.map(function (d) { return '  ' + psQuote(d); }).join(",\r\n");
    var procs = procNames.map(function (p) { return psQuote(p); }).join(',');

    return [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$log = ' + psQuote(log),
      '$marker = ' + psQuote(marker),
      'function L($m) { $t = Get-Date -Format "yyyy-MM-dd HH:mm:ss"; Add-Content -LiteralPath $log -Value "$t $m" -Encoding UTF8 }',
      'L "watch start pid=$PID"',
      '$dirs = @(',
      dirList,
      ')',
      '$names = @(' + procs + ')',
      'Add-Type -AssemblyName Microsoft.VisualBasic',
      // 等 AE 退出；marker 被删（用户取消）就立刻退
      '$deadline = (Get-Date).AddHours(' + hours + ')',
      'while ($true) {',
      '  $alive = @(Get-Process -Name $names -ErrorAction SilentlyContinue)',
      '  if ($alive.Count -eq 0) { break }',
      '  if (-not (Test-Path -LiteralPath $marker)) { L "cancelled before AE exit"; exit 0 }',
      '  if ((Get-Date) -gt $deadline) { L "timeout waiting for AE exit"; exit 0 }',
      '  Start-Sleep -Seconds 5',
      '}',
      'if (-not (Test-Path -LiteralPath $marker)) { L "cancelled before purge"; exit 0 }',
      // AE 刚退出时它自己的清理线程可能还在收尾，等 3 秒再动
      'Start-Sleep -Seconds 3',
      '$n = 0; $b = 0',
      'foreach ($d in $dirs) {',
      '  if (-not (Test-Path -LiteralPath $d)) { L "missing dir $d"; continue }',
      '  Get-ChildItem -LiteralPath $d -Recurse -File -Filter "*.aecache" -ErrorAction SilentlyContinue | ForEach-Object {',
      '    $b += $_.Length',
      '    try {',
      '      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($_.FullName, "OnlyErrorDialogs", "SendToRecycleBin")',
      '      $n++',
      '    } catch { L "fail $($_.FullName)" }',
      '  }',
      '}',
      'L "purged files=$n bytes=$b"',
      'Remove-Item -LiteralPath $marker -Force',
      'L "watch end"',
      ''
    ].join('\r\n');
  }

  /* 登记：写脚本 + 写 marker（marker 里记着这次要清哪些目录、多少文件） */
  function register(deps, o) {
    var fs = deps.fs, p = paths(o.baseDir);
    try {
      if (!fs.existsSync(p.folder)) fs.mkdirSync(p.folder);
      var body = script({ dirs: o.dirs, log: p.log, marker: p.marker, maxHours: o.maxHours });
      fs.writeFileSync(p.ps1, '\ufeff' + body, 'utf8');
      var meta = {
        at: new Date().toISOString(),
        dirs: o.dirs || [],
        files: Number(o.files) || 0,
        bytes: Number(o.bytes) || 0,
        ver: String(o.ver || '')
      };
      fs.writeFileSync(p.marker, JSON.stringify(meta, null, 2), 'utf8');
      return { ok: 1, ps1: p.ps1, marker: p.marker, log: p.log, meta: meta };
    } catch (e) {
      return { ok: 0, err: String(e && e.message || e) };
    }
  }

  /* 启动看门进程：脱离面板活下来（detached + unref + 不占管道） */
  function launch(deps, p) {
    try {
      var spawn = deps.spawn;
      if (typeof spawn !== 'function') return { ok: 0, err: 'no spawn' };
      var child = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', p.ps1
      ], { detached: true, stdio: 'ignore', windowsHide: true });
      if (child && child.unref) child.unref();
      return { ok: 1, pid: child && child.pid };
    } catch (e) {
      return { ok: 0, err: String(e && e.message || e) };
    }
  }

  /* 读状态：已登记（marker 在）？上次清了多少（日志尾行）？ */
  function state(deps, p) {
    var fs = deps.fs;
    var out = { pending: false, files: 0, bytes: 0, at: '', lastLog: '' };
    try {
      if (fs.existsSync(p.marker)) {
        out.pending = true;
        try {
          var meta = JSON.parse(String(fs.readFileSync(p.marker, 'utf8')));
          out.files = Number(meta.files) || 0;
          out.bytes = Number(meta.bytes) || 0;
          out.at = String(meta.at || '');
          out.dirs = meta.dirs || [];
        } catch (eJ) {}
      }
    } catch (e) {}
    try {
      if (fs.existsSync(p.log)) {
        var raw = String(fs.readFileSync(p.log, 'utf8')).split(/\r?\n/).filter(function (s) { return s.trim(); });
        out.lastLog = raw.length ? raw[raw.length - 1] : '';
        // 从日志里回读「上次实际清了多少」（marker 删掉之后这就是唯一证据）
        for (var i = raw.length - 1; i >= 0; i--) {
          var m = /purged files=(\d+) bytes=(\d+)/.exec(raw[i]);
          if (m) { out.doneFiles = Number(m[1]); out.doneBytes = Number(m[2]); out.doneAt = raw[i].slice(0, 19); break; }
        }
      }
    } catch (e) {}
    return out;
  }

  /* 取消：删 marker。看门进程下一轮（≤5 秒）看到 marker 没了就自己退。 */
  function cancel(deps, p) {
    try {
      if (deps.fs.existsSync(p.marker)) deps.fs.unlinkSync(p.marker);
      return { ok: 1 };
    } catch (e) {
      return { ok: 0, err: String(e && e.message || e) };
    }
  }

  return {
    FOLDER: FOLDER,
    MAX_HOURS: MAX_HOURS,
    paths: paths,
    script: script,
    register: register,
    launch: launch,
    state: state,
    cancel: cancel
  };
});