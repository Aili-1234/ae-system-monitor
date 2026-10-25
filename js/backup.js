/* ============================================================
 * backup.js — 覆盖前的回退副本（纯逻辑，不碰 DOM / 不碰 fs）
 *
 * 为什么要有它：
 *   保护保存写的是**原工程文件**，不产生副本 —— 好处是不会留一堆"哪个才是最新的"，
 *   坏处是覆盖之后就回不去了。所以在写盘之前先 copy 一份带时间戳的副本。
 *
 * 三个必须守住的语义：
 *   1) 覆盖优先：备份失败不能阻止保存（拿不到副本也不能丢改动）。
 *   2) 回退不等于原地覆盖：AE 打开着工程时替换文件，内存里的内容一保存就把回退覆盖掉了。
 *      所以回退是「生成一份新文件让用户去打开」，不是往原路径上写。
 *   3) 份数有上限：不设上限的话，大工程每次保存都留几百 MB，很快占满盘。
 * ============================================================ */
(function (root, factory) {
  var api = factory();
  try {
    if (typeof module === 'object' && module && module.exports) module.exports = api;
  } catch (e) {}
  try {
    if (root) root.SysmonBackup = api;
    if (typeof window !== 'undefined' && window && window !== root) window.SysmonBackup = api;
  } catch (e) {}
  return api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function pad3(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }

  /* 2026-10-25 17:40:55.123 → 20261025-174055-123
   * 文件名安全、按字典序即按时间序；带毫秒是为了同一秒内两次保护保存不撞名 */
  function stamp(ts) {
    var d = new Date(isFinite(ts) ? ts : Date.now());
    var ms = d.getMilliseconds();
    if (!isFinite(ms)) ms = 0;
    return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
           '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
           '-' + pad3(ms);
  }

  /* 撞名兜底：taken 里已有同名就加 -2、-3…（时间戳只到毫秒，理论上够用，但别赌） */
  function uniqueName(name, taken) {
    var set = {};
    (taken || []).forEach(function (n) { set[String(n).toLowerCase()] = 1; });
    if (!set[String(name).toLowerCase()]) return name;
    var ext = /\.[^.]+$/.test(name) ? name.slice(name.lastIndexOf('.')) : '';
    var stem = ext ? name.slice(0, name.length - ext.length) : name;
    for (var i = 2; i < 100; i++) {
      var c = stem + '-' + i + ext;
      if (!set[c.toLowerCase()]) return c;
    }
    return stem + '-' + Date.now() + ext;
  }

  /* 把工程基本名清成合法文件名：去掉 <>:"/\|?*，压缩空白，限长 */
  function safeName(name) {
    var s = String(name || '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
    if (!s) s = 'project';
    if (s.length > 60) s = s.slice(0, 60);
    return s;
  }

  /* 路径 → 短哈希：同名工程放在不同目录时，靠它分到不同备份夹，避免互相轮转掉 */
  function hashPath(p) {
    var s = String(p || '').toLowerCase(), h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* 工程路径 → 备份子目录名（一个工程一个夹，互不干扰） */
  function folderFor(projectPath) {
    var base = String(projectPath || '').replace(/\\/g, '/').split('/').pop();
    var noExt = base.replace(/\.[^.]+$/, '');
    return safeName(noExt) + '-' + hashPath(projectPath);
  }

  /* 工程路径 + 时间 → 备份文件名（保留原扩展名，.aep / .aepx 都行） */
  function backupName(projectPath, ts, taken) {
    var base = String(projectPath || '').replace(/\\/g, '/').split('/').pop();
    var ext = (/\.aepx?$/i.test(base)) ? base.slice(base.lastIndexOf('.')) : '.aep';
    var noExt = base.replace(/\.[^.]+$/, '');
    return uniqueName(safeName(noExt) + '__' + stamp(ts) + ext, taken);
  }

  /* 回退副本的名字：不回写原路径，另存一份让用户去打开 */
  function restoreName(projectPath, ts) {
    var base = String(projectPath || '').replace(/\\/g, '/').split('/').pop();
    var ext = (/\.aepx?$/i.test(base)) ? base.slice(base.lastIndexOf('.')) : '.aep';
    var noExt = base.replace(/\.[^.]+$/, '');
    return safeName(noExt) + '（回退 ' + stamp(ts) + '）' + ext;
  }

  /* 按文件名倒序（时间戳在名字里，字典序即时间序），返回要保留的前 keep 个与要删的其余 */
  function rotate(names, keep) {
    var n = Math.max(1, Math.round(Number(keep) || 1));
    var sorted = (names || []).slice().sort().reverse();
    return {
      keep: sorted.slice(0, n),
      remove: sorted.slice(n)
    };
  }

  /* 原子落盘：先写 <目标>.part，核字节数，再 rename 成正式名。
   * 为什么不能直接 copy 到最终名：中途断电/进程被杀会留下一个「带正常时间戳的半截文件」，
   * 而取回逻辑按名字倒排取最新 —— 恰好会挑中它。.part 后缀不匹配 *.aep，天然不会被当成副本。
   * fs/path 由调用方注入，保持本文件纯逻辑（测试里可以塞一个会失败/会缩水的假 fs）。 */
  function atomicCopy(fs, pathmod, src, dest) {
    var part = dest + '.part';
    function clean() { try { if (fs.existsSync(part)) fs.unlinkSync(part); } catch (e) {} }
    try {
      clean();
      fs.copyFileSync(src, part);
      var wrote = fs.statSync(part).size, need = fs.statSync(src).size;
      if (!isFinite(wrote) || wrote !== need) {
        clean();
        return { ok: false, err: '副本大小校验未通过（' + wrote + '/' + need + ' 字节）' };
      }
      fs.renameSync(part, dest);   // 同盘 rename 是原子的；dest 必须不存在（由 uniqueName 保证）
      return { ok: true, path: dest };
    } catch (e) {
      clean();
      return { ok: false, err: (e && e.message) ? e.message : String(e) };
    }
  }

  /* 从列表里挑最新的一份（按文件名时间戳） */
  function latest(names) {
    var sorted = (names || []).slice().sort().reverse();
    return sorted.length ? sorted[0] : null;
  }

  return {
    stamp: stamp,
    safeName: safeName,
    hashPath: hashPath,
    folderFor: folderFor,
    backupName: backupName,
    uniqueName: uniqueName,
    atomicCopy: atomicCopy,
    restoreName: restoreName,
    rotate: rotate,
    latest: latest
  };
});
