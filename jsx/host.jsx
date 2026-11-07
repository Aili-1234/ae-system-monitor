/* ============================================================
 * host.jsx — ExtendScript 端（在 AE 的 JSX 引擎里执行）
 *
 * 只负责取 AE 自己的信息 / 执行 AE 自己的动作，系统数据由面板的 Node 侧负责。
 *
 * 为什么不用 JSON：
 *   ExtendScript 是 ES3，老版本 AE（CC 2017/2018）不一定有全局 JSON，
 *   一旦没有，JSON.stringify 直接抛错，整个状态读取就废了。
 *   因此这里统一用「k=v&k=v」纯文本协议，字符串字段自己 encodeURIComponent，
 *   结果是纯 ASCII，不存在编码问题，也不依赖任何新语法。
 * ============================================================ */

function sysmon_getInfo() {
    var ver = '', num = 0, path = '', has = 0;

    try { ver = String(app.version || ''); } catch (e) {}

    try {
        if (app.project) {
            has = 1;
            num = app.project.numItems || 0;
            if (app.project.file) path = String(app.project.file.fsName || '');
        }
    } catch (e) {}

    return 'v=' + encodeURIComponent(ver) +
           '&n=' + num +
           '&p=' + encodeURIComponent(path) +
           '&d=' + has;
}

/* ------------------------------------------------------------
 * 工程状态 —— 崩溃保护的心跳与信号源
 *   d : 未保存改动。1 有 / 0 无 / -1 取不到（该版本没有 dirty 属性）
 *       dirty 是 AE 17.5 起才有的属性，且官方未文档化，必须容错
 *   r : revision，每次用户操作 +1，可作 dirty 的兜底依据
 *   rq: 渲染队列是否正在渲染
 * 高频调用，必须保持轻量（只读属性，无副作用）。
 * ------------------------------------------------------------ */
function sysmon_projState() {
    var ok = 1, d = -1, rev = 0, num = 0, rq = 0, path = '', err = '';

    try {
        if (!app.project) {
            ok = 0;
        } else {
            num = app.project.numItems || 0;

            try { if (app.project.file) path = String(app.project.file.fsName || ''); } catch (e) {}

            try {
                var dv = app.project.dirty;
                if (dv === true) d = 1;
                else if (dv === false) d = 0;
                else d = -1;
            } catch (e) { d = -1; }

            try { rev = app.project.revision || 0; } catch (e) {}

            try {
                if (app.project.renderQueue && app.project.renderQueue.rendering) rq = 1;
            } catch (e) {}
        }
    } catch (e) {
        ok = 0;
        err = String(e);
    }

    return 'ok=' + ok + '&d=' + d + '&r=' + rev + '&n=' + num +
           '&rq=' + rq + '&p=' + encodeURIComponent(path) +
           '&err=' + encodeURIComponent(err);
}

/* ------------------------------------------------------------
 * 静默保存 —— 等价于「文件 > 保存」
 * 两个安全前提（面板侧会先判定，这里再守一遍）：
 *   1. 必须有 app.project.file。否则 save() 会弹出「另存为」对话框 ——
 *      自动弹窗会打断用户手上的操作，比不保存更糟，所以宁可拒绝。
 *   2. 不传 file 参数。传了等于「另存为」，会把工程指向新文件。
 * 注意：这是阻塞调用，大工程会占住 AE 主线程若干秒，属于预期行为。
 * ------------------------------------------------------------ */
function sysmon_save() {
    var ok = 0, err = '', d = -1, rev = 0;
    var t0 = new Date().getTime();

    var sup = 0;
    try {
        if (app && typeof app.beginSuppressDialogs === 'function') { app.beginSuppressDialogs(0); sup = 1; }
    } catch (e0) { sup = 0; }

    try {
        if (!app.project) {
            err = 'no-project';
        } else if (!app.project.file) {
            err = 'untitled';
        } else {
            app.project.save();
            ok = 1;

            try {
                var dv = app.project.dirty;
                if (dv === true) d = 1;
                else if (dv === false) d = 0;
                else d = -1;
            } catch (e) { d = -1; }

            try { rev = app.project.revision || 0; } catch (e) {}
        }
    } catch (e) {
        ok = 0;
        err = String(e && e.message ? e.message : e);
    }

    // 1.7.13：脚本化保存期间别让 AE 再弹它自己的框（缺字体等）
    if (sup) { try { app.endSuppressDialogs(false); } catch (e2) {} }

    return 'ok=' + ok + '&err=' + encodeURIComponent(err) +
           '&d=' + d + '&r=' + rev +
           '&ms=' + (new Date().getTime() - t0);
}

/* 1.7.8：请 AE 自己清理磁盘缓存。
   为什么不在这里删文件：AE 的缓存目录里不只有媒体文件，还有它自己维护的数据库；
   外部删掉文件等于让 AE 的账本对不上，轻则白占空间、重则下次打开报缓存损坏。
   官方入口是菜单「编辑 > 清理 > 全部内存和磁盘缓存」，这里只负责点它。
   返回 ok=1 表示命令发出去了（AE 的清理本身是异步的，成效要过一会儿再看）。

   1.7.14：用户反馈仍然「清理没生效」。上一版只把人话带回来，面板看不见到底是哪条路断的，
   所以这版把每条路的真实结果都写回去（ver / 有没有 PurgeTarget / 每条菜单名找到的 id /
   app.purge 的异常原文），面板会写进 saves.log —— 下次不用猜。
   取序也换了：先试菜单（名字对了就能命中，不依赖 PurgeTarget 枚举是否全局可见），再试 API。 */
function sysmon_purge() {
    var t0 = new Date().getTime();
    var ok = 0, id = 0, how = '', err = '';
    var ver = '', hasEnum = 0, tried = [], apiErr = '';

    try { ver = String(app.version || '') } catch (e0) {}
    try {
        if (typeof PurgeTarget !== 'undefined' && PurgeTarget &&
            PurgeTarget.ALL_CACHES !== undefined) hasEnum = 1;
    } catch (e1) {}

    /* 路径一：菜单命令。中文界面的菜单名写法不一，几种都试；
       找到的 id 无论成败都记进 tried，失败时能看出是「名字不对」还是「执行被拒」。 */
    var names = [
        'Purge>All Memory & Disk Cache',
        'Purge > All Memory & Disk Cache',
        'Edit>Purge>All Memory & Disk Cache',
        '编辑>清理>全部内存和磁盘缓存',
        '清理>全部内存和磁盘缓存',
        'Edit>Purge>All Memory',
        '编辑>清理>全部内存'
    ];
    var i, mid, hit = 0;
    for (i = 0; i < names.length; i++) {
        mid = 0;
        try { mid = app.findMenuCommandId(names[i]) || 0; } catch (e2) { mid = -1; }
        tried.push(names[i] + '=' + mid);
        if (mid > 0) {
            hit = mid;
            try {
                app.executeCommand(mid);
                ok = 1; how = 'menu'; id = mid;
            } catch (e3) {
                apiErr = 'executeCommand(' + mid + ')：' + String(e3 && e3.message ? e3.message : e3);
            }
            break;
        }
    }

    /* 路径二：AE 脚本 API。签名是 purge(target)，target 是 PurgeTarget 枚举 ——
       无参调用会抛「由于调用需要 1 个参数，无法调用 purge」（1.7.10 及以前就是这么错的）。
       枚举拿不到就不猜数字：给错 target 会清错东西。 */
    if (!ok && hasEnum) {
        try {
            app.purge(PurgeTarget.ALL_CACHES);
            ok = 1; how = 'api'; id = -1;
        } catch (e4) {
            if (!apiErr) apiErr = 'app.purge：' + String(e4 && e4.message ? e4.message : e4);
        }
    }

    if (!ok) {
        err = '菜单' + (hit > 0 ? '找到了但执行失败' : '里没有清理命令（试了 ' + names.length + ' 种写法）') +
              (apiErr ? '；' + apiErr : '') +
              '；PurgeTarget ' + (hasEnum ? '存在' : '不存在');
    }

    return 'ok=' + ok + '&id=' + id + '&how=' + how +
           '&ver=' + encodeURIComponent(ver) +
           '&enum=' + hasEnum +
           '&tried=' + encodeURIComponent(tried.join('|')) +
           '&err=' + encodeURIComponent(err) +
           '&ms=' + (new Date().getTime() - t0);
}

/* CEP 会执行 ScriptPath 指向的文件；这里留一个无副作用的表达式 */
sysmon_getInfo();
