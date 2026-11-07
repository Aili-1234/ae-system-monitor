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

/* 1.7.8：请 AE 自己清理缓存。面板一个文件都不删 —— AE 的缓存目录里有它自己维护的账本，
   外部删文件会让账本对不上，轻则白占空间、重则下次打开报缓存损坏。

   1.7.15 查清了两件事（都写在这里，免得下次再猜）：
   - Adobe 官方脚本文档：PurgeTarget.ALL_CACHES **从 AE 24.3 起**才同时清 RAM 与磁盘缓存；
     24.3 之前它**只清 RAM 缓存**。用户是 24.2.1 —— 所以脚本调成功、磁盘缓存也一点不掉。
   - app.findMenuCommandId('Purge>All Memory & Disk Cache') 在多数版本返回 0（社区长期反馈），
     菜单这条路本来就不该当主路。
   返回里带上 ver / apiHow / diskCapable，面板据此说人话，不再把「版本能力不足」说成「没生效」。 */
function sysmon_purge() {
    var t0 = new Date().getTime();
    var ok = 0, how = '', err = '', apiErr = '', menuErr = '';
    var ver = '', hasEnum = 0, apiHow = 'none', diskCapable = 0;

    try { ver = String(app.version || '') } catch (e0) {}
    // 24.3 起 ALL_CACHES 才含磁盘缓存
    try {
        var mm = ver.match(/^(\d+)\.(\d+)/);
        if (mm) diskCapable = (Number(mm[1]) > 24 || (Number(mm[1]) === 24 && Number(mm[2]) >= 3)) ? 1 : 0;
    } catch (e1) {}
    try {
        if (typeof PurgeTarget !== 'undefined' && PurgeTarget &&
            PurgeTarget.ALL_CACHES !== undefined) { hasEnum = 1; }
    } catch (e2) {}

    /* 路径一（主路）：app.purge(target)。枚举拿不到就用文档里的数值 1 = ALL_CACHES。 */
    try {
        if (hasEnum) {
            app.purge(PurgeTarget.ALL_CACHES);
            apiHow = 'enum';
        } else {
            app.purge(1);
            apiHow = 'num';
        }
        ok = 1; how = 'api';
    } catch (e3) {
        apiErr = String(e3 && e3.message ? e3.message : e3);
    }

    /* 路径二（兜底）：菜单命令。名字对了才命中；多数版本返回 0，所以只当兜底。 */
    if (!ok) {
        var names = [
            'Purge>All Memory & Disk Cache',
            'Edit>Purge>All Memory & Disk Cache',
            '编辑>清理>全部内存和磁盘缓存',
            'Purge>All Memory',
            '编辑>清理>全部内存'
        ];
        var i, mid;
        for (i = 0; i < names.length && !ok; i++) {
            mid = 0;
            try { mid = app.findMenuCommandId(names[i]) || 0; } catch (e4) { mid = 0; }
            if (mid > 0) {
                try { app.executeCommand(mid); ok = 1; how = 'menu'; } catch (e5) {
                    if (!apiErr) apiErr = 'executeCommand(' + mid + ')：' + String(e5 && e5.message ? e5.message : e5);
                }
            }
        }
        if (!ok) menuErr = '菜单命令也找不到（多数 AE 版本 findMenuCommandId 对这些项返回 0）；' +
                            '磁盘缓存只能到「编辑 > 清理 > 全部内存和磁盘缓存」手清';
    }

    if (!ok) {
        err = (apiErr ? 'purge 接口：' + apiErr : '');
        if (menuErr) err += (err ? '；' : '') + '菜单：' + menuErr;
        if (!err) err = '原因未知';
    }

    return 'ok=' + ok + '&how=' + how +
           '&ver=' + encodeURIComponent(ver) +
           '&enum=' + hasEnum + '&apiHow=' + apiHow +
           '&disk=' + diskCapable +
           '&err=' + encodeURIComponent(err) +
           '&ms=' + (new Date().getTime() - t0);
}

/* CEP 会执行 ScriptPath 指向的文件；这里留一个无副作用的表达式 */
sysmon_getInfo();
