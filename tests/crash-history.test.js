/* ============================================================
 * crash-history.test.js — 从 WER 读「上次崩溃」
 *   node tests/crash-history.test.js
 *
 * 为什么这条信号值得做：
 *   崩溃往往成簇出现。WER 会把每次 APPCRASH / APPHANG 落成一个目录
 *   （AppCrash_AfterFX.exe_<hash>），目录时间就是崩溃时间，Report.wer 里
 *   还带着异常代码（c0000374 = 堆损坏等）。所以「刚崩过」是可验证的事实，
 *   比任何猜测都硬。
 *
 * 全部用 fixture 目录，不依赖本机真的崩过。
 * ============================================================ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AECache = require(path.join(ROOT, 'js', 'ae-cache.js'));
const AE = AECache.create({ fs, os, path, Buffer });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-wer-'));
const WER = path.join(TMP, 'WER');

function mkEntry(dirName, mtime, wer, enc) {
  const d = path.join(WER, dirName);
  fs.mkdirSync(d, { recursive: true });
  if (wer) {
    if (enc === 'utf16le') {
      // 真实 WER 就是 UTF-16LE + BOM。按 utf8 读会全是 NUL，正则永远匹配不上 ——
      // 第一次实机验证时就是这么翻车的（时间对、代码空），所以这里必须覆盖。
      fs.writeFileSync(path.join(d, 'Report.wer'),
        Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(wer, 'utf16le')]));
    } else {
      fs.writeFileSync(path.join(d, 'Report.wer'), wer, 'utf8');
    }
  }
  fs.utimesSync(d, mtime, mtime);
  return d;
}

const NOW = Date.now();
const H = 3600000;

const crashOld = mkEntry(
  'AppCrash_AfterFX.exe_aaa_111',
  new Date(NOW - 29 * 24 * H),
  'EventType=APPCRASH\nSig[3].Name=故障模块名称\nSig[3].Value=StackHash_34c7\nSig[6].Name=异常代码\nSig[6].Value=c0000374\n'
);

const crashNew = mkEntry(
  'AppCrash_AfterFX.exe_bbb_222',
  new Date(NOW - 3 * H),
  'EventType=APPCRASH\nSig[3].Name=故障模块名称\nSig[3].Value=ngl.dll\nSig[6].Name=异常代码\nSig[6].Value=c0000005\n',
  'utf16le'
);

mkEntry('AppHang_AfterFX.exe_ccc_333', new Date(NOW - 10 * 24 * H),
  'EventType=AppHangB1\nSig[3].Name=Hang Signature\nSig[3].Value=c7ef\n');

// 干扰项：别的程序崩了，绝不能被当成 AE
mkEntry('AppCrash_chrome.exe_ddd_444', new Date(NOW - 1 * H),
  'EventType=APPCRASH\nSig[6].Value=c0000005\n');

console.log('\n[1] 认得出「最近一次」AE 崩溃');
{
  const r = AE.latestCrash({ roots: [WER], now: NOW });
  ok('有记录', !!r);
  ok('取最近的（3 小时前那个）', r && Math.round(r.hoursAgo) === 3, r && r.hoursAgo.toFixed(2));
  ok('不把 10 天前的 AppHang 当最近', r && r.dir.indexOf('bbb_222') >= 0, r && path.basename(r.dir));
}

console.log('\n[2] 不把别的程序当成 AE');
{
  const r = AE.latestCrash({ roots: [WER], now: NOW });
  ok('目录不含 chrome', r && r.dir.indexOf('chrome') < 0, r && r.dir);
}

console.log('\n[3] 解析异常代码与故障模块');
{
  const r = AE.latestCrash({ roots: [WER], now: NOW });
  ok('code = c0000005', r && r.code === 'c0000005', r && r.code);
  ok('code 翻译成人话', r && r.codeText === '访问冲突（读了非法地址）', r && r.codeText);
  ok('module = ngl.dll', r && r.module === 'ngl.dll', r && r.module);
  ok('type = crash', r && r.type === 'crash', r && r.type);
}

console.log('\n[3b] 编码兼容：UTF-8 与 UTF-16LE（WER 实际用后者）');
{
  const w8 = path.join(TMP, 'enc8');
  fs.mkdirSync(w8, { recursive: true });
  const d8 = path.join(w8, 'AppCrash_AfterFX.exe_fff_999');
  fs.mkdirSync(d8, { recursive: true });
  fs.writeFileSync(path.join(d8, 'Report.wer'),
    'EventType=APPCRASH\nSig[3].Value=x.dll\nSig[6].Value=c0000017\n', 'utf8');
  const r8 = AE.latestCrash({ roots: [w8], now: NOW });
  ok('UTF-8 → 解析出 c0000017', r8 && r8.code === 'c0000017', r8 && r8.code);
  ok('UTF-8 → 翻译成"内存不足"', r8 && /内存不足/.test(r8.codeText), r8 && r8.codeText);

  const r16 = AE.latestCrash({ roots: [WER], now: NOW });
  ok('UTF-16LE（带 BOM）→ 解析出 c0000005', r16 && r16.code === 'c0000005', r16 && r16.code);
  ok('UTF-16LE → 模块名也读到了', r16 && r16.module === 'ngl.dll', r16 && r16.module);
}

console.log('\n[4] 只有 AppHang 时也要能认出来');
{
  const only = path.join(TMP, 'onlyhang');
  fs.mkdirSync(only, { recursive: true });
  const h = path.join(only, 'AppHang_AfterFX.exe_eee_555');
  fs.mkdirSync(h, { recursive: true });
  const r = AE.latestCrash({ roots: [only], now: NOW });
  ok('type = hang', r && r.type === 'hang', r && r.type);
  ok('没有 Report.wer 也不报错', !!r);
}

console.log('\n[5] 没有记录时返回 null，不编造');
{
  const empty = path.join(TMP, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  ok('空目录 → null', AE.latestCrash({ roots: [empty], now: NOW }) === null);
  ok('不存在的目录 → null', AE.latestCrash({ roots: [path.join(TMP, 'nope')], now: NOW }) === null);
  ok('多根里都没有 → null', AE.latestCrash({ roots: [empty, path.join(TMP, 'nope')], now: NOW }) === null);
}

console.log('\n[6] 异常代码的翻译表');
{
  ok('c0000374 → 堆损坏', /堆损坏/.test(AE.crashCodeText('c0000374')), AE.crashCodeText('c0000374'));
  ok('c00000fd → 栈溢出', /栈溢出/.test(AE.crashCodeText('c00000fd')));
  ok('c0000017 → 内存不足', /内存不足/.test(AE.crashCodeText('c0000017')));
  ok('0x 前缀也能认', /堆损坏/.test(AE.crashCodeText('0xC0000374')));
  ok('大写也能认', /堆损坏/.test(AE.crashCodeText('C0000374')));
  ok('未知代码返回空串（不瞎猜）', AE.crashCodeText('deadbeef') === '');
  ok('空输入返回空串', AE.crashCodeText('') === '');
}

console.log('\n[7] hoursAgo 会随时间推进而变大');
{
  const a = AE.latestCrash({ roots: [WER], now: NOW });
  const b = AE.latestCrash({ roots: [WER], now: NOW + 5 * H });
  ok('5 小时后应多 5 小时', Math.round(b.hoursAgo - a.hoursAgo) === 5,
     a.hoursAgo.toFixed(1) + ' → ' + b.hoursAgo.toFixed(1));
}

console.log('\n[8] 本机崩溃画像：次数、中位间隔、脾气');
{
  const h = AE.crashHistory({ roots: [WER], now: NOW });
  ok('有画像', !!h);
  ok('近 30 天 3 次（忽略 chrome）', h && h.count30 === 3, h && h.count30);
  ok('近 7 天 1 次', h && h.count7 === 1, h && h.count7);
  ok('总数 3（AfterFX 记录）', h && h.total === 3, h && h.total);
  ok('中位间隔 = (237 + 456) / 2 = 346.5 小时（偶数取中间平均）',
     h && Math.abs(h.medianGapH - 346.5) < 0.5, h && h.medianGapH);
  ok('脾气 = 偶发（2~4 次）', h && h.tier === 'occasional', h && h.tier);
  ok('画像里带最近一次', h && h.last && h.last.code === 'c0000005', h && h.last.code);
  ok('hoursAgo 与 last 一致', h && Math.abs(h.hoursAgo - h.last.hoursAgo) < 1e-6);
}

console.log('\n[9] 画像的边界：没有记录 / 只有一次');
{
  const empty = path.join(TMP, 'empty2');
  fs.mkdirSync(empty, { recursive: true });
  ok('空目录 → null（不编造 0 次）', AE.crashHistory({ roots: [empty], now: NOW }) === null);

  const one = path.join(TMP, 'one');
  const d = path.join(one, 'AppCrash_AfterFX.exe_zzz_000');
  fs.mkdirSync(d, { recursive: true });
  fs.utimesSync(d, new Date(NOW - 2 * H), new Date(NOW - 2 * H));
  const h1 = AE.crashHistory({ roots: [one], now: NOW });
  ok('只有一次 → count30 = 1', h1 && h1.count30 === 1, h1 && h1.count30);
  ok('只有一次 → 算不出中位间隔（null）', h1 && h1.medianGapH === null, h1 && h1.medianGapH);
  ok('只有一次 → 脾气 rare', h1 && h1.tier === 'rare', h1 && h1.tier);
}

console.log('\n[10] 次数决定脾气（供档位推荐使用）');
{
  const many = path.join(TMP, 'many');
  fs.mkdirSync(many, { recursive: true });
  for (let i = 0; i < 6; i++) {
    const dir = path.join(many, 'AppCrash_AfterFX.exe_m' + i + '_000');
    fs.mkdirSync(dir, { recursive: true });
    const t = new Date(NOW - (i + 1) * 12 * H);
    fs.utimesSync(dir, t, t);
  }
  const h6 = AE.crashHistory({ roots: [many], now: NOW });
  ok('6 次 → count30 = 6', h6 && h6.count30 === 6, h6 && h6.count30);
  ok('6 次 → 脾气 chronic', h6 && h6.tier === 'chronic', h6 && h6.tier);
  ok('间隔都是 12 小时 → 中位 12', h6 && h6.medianGapH === 12, h6 && h6.medianGapH);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
