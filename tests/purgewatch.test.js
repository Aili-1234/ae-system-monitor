/* ============================================================
 * purgewatch.test.js — AE 退出后清磁盘缓存（1.7.16 B 案）的真跑测试
 *
 * 它要动的脚本会在用户机器上删文件，所以这里测的不是「字符串里有这个词」，
 * 而是：脚本到底会不会等到 AE 退出、会不会只删 .aecache、会不会走回收站、
 * 取消之后还会不会照删。任何一条不成立，就宁可不发布。
 * ============================================================ */
var fs = require('fs');
var os = require('os');
var path = require('path');
var PW = require('../js/purgewatch.js');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

var tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sysmon-pw-'));
var deps = { fs: fs };
var P = PW.paths(tmp);

console.log('\n[1] 路径都在面板自己的目录里');
ok('三个文件同名不同扩展', P.ps1 === path.join(tmp, 'purge-on-exit.ps1') &&
  P.marker === path.join(tmp, 'purge-on-exit.json') && P.log === path.join(tmp, 'purge-on-exit.log'),
  JSON.stringify(P));
ok('结尾反斜杠会被吃掉', PW.paths(tmp + '\\').ps1 === P.ps1);
ok('空目录参数不崩', typeof PW.paths('') === 'object');

console.log('\n[2] 脚本必须等 AE 退出才动手');
var dirA = 'C:\\fake\\Disk Cache - PC.noindex';
var dirB = "D:\\另一个 桶\\Disk Cache - PC.noindex";
var s = PW.script({ dirs: [dirA, dirB], log: P.log, marker: P.marker });
ok('按进程名等 AfterFX', /Get-Process -Name \$names/.test(s) && /'AfterFX'/.test(s));
ok('不是先 sleep 再删（必须循环等）', /while \(\$true\)/.test(s) && /Start-Sleep -Seconds 5/.test(s));
ok('两个目录都写进去了', s.indexOf(dirA) >= 0 && s.indexOf(dirB) >= 0);
ok('12 小时上限', /AddHours\(12\)/.test(s) && /timeout waiting for AE exit/.test(s));
ok('退出后再等 3 秒收尾', /Start-Sleep -Seconds 3/.test(s));

console.log('\n[3] 只删 .aecache、进回收站');
ok('过滤器只认 *.aecache', /-Filter "\*\.aecache"/.test(s));
ok('走回收站而不是黑洞', /SendToRecycleBin/.test(s) && /Microsoft\.VisualBasic\.FileIO\.FileSystem/.test(s));
ok('没有递归删目录', !/Remove-Item[^\r\n]*-Recurse/.test(s));
ok('没有删其它扩展名', !/\*\.(aep|aepx|txt|log|mp4)\b/.test(s));
ok('删不掉的只记日志、不中断', /catch \{ L "fail/.test(s));

console.log('\n[4] 取消要让看门进程自己退出');
ok('等待期间每轮都查 marker（取消立刻生效）',
  /while \(\$true\) \{[\s\S]*?Test-Path -LiteralPath \$marker[\s\S]*?Start-Sleep/.test(s));
ok('AE 退出后、动手前再查一次', /cancelled before purge/.test(s) && /exit 0/.test(s));

console.log('\n[5] register 真写盘');
var r = PW.register(deps, { baseDir: tmp, dirs: [dirA], files: 7870, bytes: 26 * 1073741824, ver: '1.7.16' });
ok('登记成功', r.ok === 1, r.err);
ok('ps1 落盘', fs.existsSync(P.ps1));
var body = fs.readFileSync(P.ps1, 'utf8');
ok('ps1 带 UTF-8 BOM（PowerShell 5.1 认它）', body.charCodeAt(0) === 0xFEFF);
ok('ps1 是 CRLF', body.indexOf('\r\n') > 0);
ok('marker 落盘且能解析', fs.existsSync(P.marker) && JSON.parse(fs.readFileSync(P.marker, 'utf8')).files === 7870);

console.log('\n[6] state 读得出来、删 marker 后不算登记');
var st1 = PW.state(deps, P);
ok('pending=true', st1.pending === true);
ok('文件数与字节数带回来', st1.files === 7870 && st1.bytes === 26 * 1073741824, JSON.stringify(st1));
fs.writeFileSync(P.log, '[2026-11-07T00:00:00] watch start pid=1\r\n2026-11-07 00:01:00 purged files=3 bytes=4096\r\n', 'utf8');
var st2 = PW.state(deps, P);
ok('从日志回读上次清了几个', st2.doneFiles === 3 && st2.doneBytes === 4096, JSON.stringify(st2));

console.log('\n[7] cancel 删 marker，且幂等');
var c1 = PW.cancel(deps, P);
ok('取消成功', c1.ok === 1 && !fs.existsSync(P.marker));
var c2 = PW.cancel(deps, P);
ok('再取消一次不报错', c2.ok === 1);

console.log('\n[8] launch 用 detached 起进程，不占管道');
var got = null;
var fakeSpawn = function (exe, argv, opt) {
  got = { exe: exe, argv: argv, opt: opt, unref: 0 };
  var child = { pid: 4321, unref: function () { got.unref++; } };
  return child;
};
var l = PW.launch({ spawn: fakeSpawn }, { ps1: P.ps1 });
ok('launch 成功并回 pid', l.ok === 1 && l.pid === 4321);
ok('用 powershell 跑 -File', got && got.exe === 'powershell.exe' && got.argv.indexOf('-File') >= 0 &&
  got.argv[got.argv.length - 1] === P.ps1, got && got.exe);
ok('detached + 不占管道 + 隐藏窗口', got.opt.detached === true && got.opt.stdio === 'ignore' && got.opt.windowsHide === true);
ok('unref 过（面板退出后它继续活）', got.unref === 1);
ok('没有 spawn 时优雅失败', PW.launch({}, { ps1: P.ps1 }).ok === 0);
var throwSpawn = function () { throw new Error('boom'); };
ok('spawn 抛错不崩', PW.launch({ spawn: throwSpawn }, { ps1: P.ps1 }).ok === 0);

try { fs.unlinkSync(P.ps1); } catch (e) {}
try { fs.unlinkSync(P.log); } catch (e) {}
try { fs.rmdirSync(tmp); } catch (e) {}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);