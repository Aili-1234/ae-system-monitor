/* ============================================================
 * _fixture.js — 给测试用的「假 AE 环境」
 *
 * 为什么需要：测试原来直接读本机的 os.homedir()，本机装了 AE 才行。
 * 在 CI runner、同事的电脑、或者我自己换台机器上跑，都会因为「读不到
 * AE 偏好」而误报失败。这里造一个临时 home，结构与真机一致：
 *
 *   <tmp>/AppData/Roaming/Adobe/After Effects/24.2/设置.txt
 *   <tmp>/AppData/Roaming/Adobe/After Effects/24.2/…-indep-general.txt
 *   <tmp>/cache/24.2/Disk Cache - FIXTURE.noindex/<若干文件>
 *
 * 测试只依赖这份 fixture，因此换到任何机器、任何 Node 版本结果都一样。
 * ============================================================ */
const fs = require('fs');
const path = require('path');
const os = require('os');

const VER = '24.2';
const HOST = 'FIXTURE';
const MAX_GB = 149;
const BUFFER_GB = 10;
// 「李」在 AE 偏好文件里是 E5 88 8E 的 UTF-16 十六进制，这里直接给出
// 一个中文用户名路径，用来验证 decodeAEString 真的还原了中文。
const CN_USER = '\u674e';

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function writeFile(p, text) {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, text, 'utf8');
}

/* AE 偏好文件的关键结构：
 *   ["Disk Cache Controls"]      → Folder 7 / Max Size 3 / Enabled 2
 *   ["Additional Disk Cache Controls"] → Minimum Volume Free Space (Gigabytes)
 * 文件里必须出现 MARK（"["Disk Cache Controls"]"）才会被 loadPrefs 认出来。 */
function prefsText(folder) {
  return [
    'FX Prefs',
    '',
    '["Disk Cache Controls"]',
    '\t"Folder 7" = "' + folder + '"',
    '\t"Max Size 3" = "' + MAX_GB + '"',
    '\t"Enabled 2" = "1"',
    '\t"Some Other Key" = "ignore me"',
    '',
    '["Additional Disk Cache Controls"]',
    '\t"Minimum Volume Free Space (Gigabytes)" = "' + BUFFER_GB + '"',
    '',
    '["General"]',
    '\t"Language" = "zh_CN"',
    ''
  ].join('\n');
}

function generalPrefsText(autoSaveFolder) {
  return [
    'FX Prefs',
    '',
    '["Auto Save"]',
    '\t"Enable Auto Save3" = "1"',
    '\t"Auto Save Interval" = "20"',
    '\t"Auto Save Max Project Vers" = "5"',
    '\t"Enable Auto Save RQ2" = "0"',
    '\t"Auto Save Folder" = "' + autoSaveFolder + '"',
    '',
    '["Other Section"]',
    '\t"X" = "1"',
    ''
  ].join('\n');
}

/* 造一份缓存目录：若干文件，大小固定，便于断言字节数 */
function cacheTree(dir, files, sizeEach) {
  mkdirp(dir);
  for (let i = 0; i < files; i++) {
    fs.writeFileSync(path.join(dir, 'chunk-' + i + '.aecache'), Buffer.alloc(sizeEach, 0x41));
  }
}

/**
 * 建一份 fixture。
 * @returns {{home, prefsDir, cacheDir, files, bytes, cleanup, osStub}}
 */
function makeFixture(opts) {
  opts = opts || {};
  const files = opts.files === undefined ? 6 : opts.files;
  const sizeEach = opts.sizeEach === undefined ? 1024 : opts.sizeEach;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-sysmon-fixture-'));
  const prefsDir = path.join(home, 'AppData', 'Roaming', 'Adobe', 'After Effects', VER);
  const folder = path.join(home, 'cache');
  const cacheDir = path.join(folder, 'Adobe', 'After Effects',
    VER, 'Disk Cache - ' + HOST + '.noindex');

  // Folder 7 里写的是 AE 的「编码后」形式：中文按 UTF-8 拆成十六进制片段，
  // 例如「中」写作 "E4B8AD"，「李」写作 "E69D8E"。
  const hex = Buffer.from(CN_USER, 'utf8').toString('hex').toUpperCase(); // E69D8E
  const encoded = folder.split(CN_USER).join('"' + hex + '"');

  writeFile(path.join(prefsDir, '设置.txt'), prefsText(encoded));

  // 自动保存目录：造一个新版 .aep，用来验证 latestAutoSave 真的能找到最新一份
  const autoSaveFolder = path.join(home, 'Documents', 'Adobe', 'After Effects', 'Auto-Save');
  mkdirp(autoSaveFolder);
  fs.writeFileSync(path.join(autoSaveFolder, 'demo 2026-10-25 14-00-00.aep'),
    Buffer.alloc(2048, 0x42));
  const autoEncoded = autoSaveFolder.split(CN_USER).join('"' + hex + '"');

  writeFile(path.join(prefsDir, 'Adobe After Effects ' + VER + ' Prefs-indep-general.txt'),
    generalPrefsText(autoEncoded));
  cacheTree(cacheDir, files, sizeEach);

  // 让 ae-cache 以为自己在真机上：只替换 homedir，其余 os 能力照旧
  const osStub = Object.create(os);
  osStub.homedir = () => home;
  osStub.hostname = () => HOST;
  osStub.platform = 'win32';
  osStub.userInfo = () => ({ username: CN_USER, homedir: home });

  return {
    home,
    prefsDir,
    cacheDir,
    folder,
    autoSaveFolder,
    ver: VER,
    host: HOST,
    maxGB: MAX_GB,
    bufferGB: BUFFER_GB,
    files,
    bytes: files * sizeEach,
    osStub,
    cleanup() {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
    }
  };
}

module.exports = { makeFixture, VER, HOST, MAX_GB, BUFFER_GB, CN_USER };
