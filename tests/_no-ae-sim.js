/* ============================================================
 * _no-ae-sim.js —— 预加载垫片：模拟"没装 AE 的机器"
 *
 * 用法（在插件根目录执行）：
 *   node -r ./tests/_no-ae-sim.js tests/scan.test.js
 *   for f in tests/*.test.js; do node -r ./tests/_no-ae-sim.js "$f"; done
 *
 * 为什么需要它：ae-cache.js 的 prefsRoot() 读 os.homedir()，改 APPDATA
 * 环境变量没用。只有把 homedir 指到空目录，才是真的"没有 AE"。
 *
 * 用途：验证哪些测试依赖本机真实 AE。CI runner 就是这个环境。
 * ============================================================ */
const os = require('os');
const path = require('path');
const fs = require('fs');

const fake = path.join(os.tmpdir(), '__no_ae_home__');
fs.mkdirSync(fake, { recursive: true });
os.homedir = () => fake;
