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

    return 'ok=' + ok + '&err=' + encodeURIComponent(err) +
           '&d=' + d + '&r=' + rev +
           '&ms=' + (new Date().getTime() - t0);
}

/* 1.7.8：请 AE 自己清理磁盘缓存。
   为什么不在这里删文件：AE 的缓存目录里不只有媒体文件，还有它自己维护的数据库；
   外部删掉文件等于让 AE 的账本对不上，轻则白占空间、重则下次打开报缓存损坏。
   官方入口是菜单「编辑 > 清理 > 全部内存和磁盘缓存」，这里只负责点它。
   返回 ok=1 表示命令发出去了（AE 的清理本身是异步的，成效要过一会儿再看）。 */
function sysmon_purge() {
    var t0 = new Date().getTime();
    var ok = 0, id = 0, err = '';

    // AE 多数版本没有 app.purge，只有菜单命令；先探一下，探不到就只走菜单。
    try { if (app.purge) { app.purge(); ok = 1; id = -1; } } catch (e0) {
        err = String(e0 && e0.message ? e0.message : e0);
    }

    if (!ok) {
        // 英文/中文两种界面都试一遍：findMenuCommandId 在中文界面下可能只认本地化名字
        var names = [
            'Purge>All Memory & Disk Cache',
            '\u6e05\u7406>\u5168\u90e8\u5185\u5b58\u548c\u78c1\u76d8\u7f13\u5b58'
        ];
        var i, mid;
        for (i = 0; i < names.length && !ok; i++) {
            try {
                mid = app.findMenuCommandId(names[i]);
                if (mid && mid > 0) {
                    app.executeCommand(mid);
                    ok = 1;
                    id = mid;
                }
            } catch (e1) {
                if (!err) err = String(e1 && e1.message ? e1.message : e1);
            }
        }
        if (!ok && !err) err = 'AE 没有"清理 > 全部内存和磁盘缓存"这条命令';
    }

    return 'ok=' + ok + '&id=' + id +
           '&err=' + encodeURIComponent(err) +
           '&ms=' + (new Date().getTime() - t0);
}

/* CEP 会执行 ScriptPath 指向的文件；这里留一个无副作用的表达式 */
sysmon_getInfo();
