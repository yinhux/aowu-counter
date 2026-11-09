/*
 * 嗷呜计数 (Aowu Counter) v1.0.0 — Photoshop (CEP) ExtendScript host.
 *
 * 依赖同目录 jsx/core.jsx（纯逻辑），由 CEP 清单 ScriptPath 载入本文件。
 * 对外接口（面板通过 CSInterface.evalScript 调用，全部返回 JSON 字符串）：
 *   AowuCounter.init(extensionRoot)   初始化（面板首次打开时传入扩展根目录，用于定位 core.jsx）
 *   AowuCounter.getState()            轮询：执行一次 tick + 返回面板状态
 *   AowuCounter.clearCurrent()        清空当前画布笔数
 *   AowuCounter.deleteCounter(id)     删除一个计数记录
 *   AowuCounter.renameCounter(id,newName) 用户手动改名
 *   AowuCounter.getVersion()
 *   AowuCounter._debug*               E2E 测试辅助
 *
 * 计数原理（已真机验证，详见 docs/DETECTION-RESEARCH.md）：
 *   用 Action Manager 读取当前历史状态的 {ID,count}；每个文档维护历史状态 ID 高水位。
 *   ID > 水位 的新状态 = 插件没见过的操作；名称命中本地化画笔/铅笔工具名 → +1 笔。
 *   撤销/重做只会回到旧 ID，永不大于水位 → 不计数、不扣减；撤销后继续画是新 ID → 计数。
 */
var AowuCounter = (function () {
    var VERSION = '1.4.3';
    var SP = '/';

    var state = {
        core: null,
        corePath: '',
        coreError: '',
        domLib: null,
        domLibPath: '',
        domLibError: '',
        extRoot: '',
        model: null,
        leaderboardModel: null,
        detector: null,
        paintNames: [],
        dataPath: '',
        dataRootOverride: '',
        leaderboardPath: '',
        leaderboardDeletedPath: '',
        leaderboardDeleted: {},
        leaderboardWarning: '',
        leaderboardDirty: false,
        lastLeaderboardSyncAt: 0,
        dataWarning: '',
        lastSaveError: '',
        docRuntime: {},
        lastTickError: '',
        lastRead: null,
        initialized: false,
        e2eEnabled: false,
        e2eDir: '',
        e2eLastWrite: 0,
        paused: false,
        hotkey: { enabled: false, key: 'P', status: 'disabled', error: '' },
        hotkeyStartedAt: 0,
        hotkeyLastFire: ''
    };

    /* ================================================================ */
    /* 基础工具                                                          */
    /* ================================================================ */

    function str(v) {
        try { return String(v); } catch (e) { return ''; }
    }

    function tempDirPath() {
        try {
            if (Folder && Folder.temp && Folder.temp.fsName) { return String(Folder.temp.fsName); }
        } catch (e0) { }
        return 'C:\\Users\\Public\\AppData\\Local\\Temp';
    }
    function normalizePath(p) {
        var s = str(p);
        if (!s) { return ''; }
        s = s.replace(/\\/g, '/');
        while (s.length > 1 && s.charAt(s.length - 1) === '/') { s = s.substring(0, s.length - 1); }
        return s;
    }

    /* ================================================================ */
    /* 暂停 / 全局快捷键（v1.2.0）                                         */
    /* ================================================================ */

    function readTextFile(path) {
        try {
            var f = new File(path);
            if (!f.exists) { return null; }
            f.encoding = 'UTF-8';
            if (!f.open('r')) { return null; }
            var text = f.read();
            f.close();
            return String(text);
        } catch (e0) {
            return null;
        }
    }

    function writeTextFile(path, text) {
        try {
            var f = new File(path);
            f.encoding = 'UTF-8';
            if (!f.open('w')) { return false; }
            f.write(String(text));
            f.close();
            return true;
        } catch (e0) {
            return false;
        }
    }

    function removeFile(path) {
        try {
            var f = new File(path);
            if (f.exists) { f.remove(); }
        } catch (e0) { }
    }

    function hotkeyPaths() {
        var d = tempDirPath();
        return {
            fire: d + '/aowu-counter-hotkey.fire',
            stop: d + '/aowu-counter-hotkey.stop',
            status: d + '/aowu-counter-hotkey.status'
        };
    }

    function normalizeHotkeyKey(key) {
        var k = str(key).toUpperCase();
        if (/^[A-Z0-9]$/.test(k)) { return k; }
        if (/^F([1-9]|1[0-2])$/.test(k)) { return k; }
        return 'P';
    }

    /* 恢复检测基线：暂停期间画的所有笔画都不补记。 */
    function resetDetection() {
        try {
            if (state.domLib) {
                state.detector = state.domLib.createDetector();
                try { state.detector.setPaintNames(state.paintNames); } catch (e0) { }
            }
        } catch (e1) { }
        state.docRuntime = {};
        state.lastRead = null;
        state.lastTickError = '';
    }

    function setPausedInternal(paused) {
        paused = (paused === true);
        if (state.paused === paused) { return; }
        state.paused = paused;
        if (!paused) { resetDetection(); }
    }

    function refreshHotkeyStatus() {
        if (!state.hotkey.enabled) {
            state.hotkey.status = 'disabled';
            return;
        }
        var p = hotkeyPaths();
        var text = readTextFile(p.status);
        if (text) {
            var lines = String(text).split(/\r?\n/);
            var fields = {};
            var i;
            for (i = 0; i < lines.length; i++) {
                var idx = lines[i].indexOf('=');
                if (idx > 0) { fields[lines[i].substring(0, idx)] = lines[i].substring(idx + 1); }
            }
            if (fields.state === 'registered') {
                state.hotkey.status = 'active';
                state.hotkey.error = '';
            } else if (fields.state === 'error') {
                state.hotkey.status = 'error';
                state.hotkey.error = str(fields.error) || 'hotkey_error';
            }
            return;
        }
        var age = (new Date()).getTime() - state.hotkeyStartedAt;
        state.hotkey.status = (age < 4000) ? 'starting' : 'error';
        state.hotkey.error = (age < 4000) ? '' : 'helper_not_started';
    }

    function stopHotkeyHelper() {
        var p = hotkeyPaths();
        writeTextFile(p.stop, String((new Date()).getTime()));
        state.hotkey.status = 'disabled';
        state.hotkey.error = '';
    }

    function startHotkeyHelper(key) {
        stopHotkeyHelper();
        var p = hotkeyPaths();
        removeFile(p.stop);
        removeFile(p.fire);
        removeFile(p.status);
        state.hotkeyLastFire = '';
        var root = normalizePath(state.extRoot);
        if (!root) { state.hotkey.status = 'error'; state.hotkey.error = 'no_ext_root'; return; }
        var helperPath = root + '/jsx/hotkey.ps1';
        var helper = new File(helperPath);
        if (!helper.exists) { state.hotkey.status = 'error'; state.hotkey.error = 'helper_missing'; return; }
        try {
            var vbsPath = tempDirPath() + '/aowu_hotkey_launcher.vbs';
            var vbs = new File(vbsPath);
            vbs.encoding = 'UTF-8';
            if (!vbs.open('w')) { state.hotkey.status = 'error'; state.hotkey.error = 'vbs_open_failed'; return; }
            vbs.write('Set sh = CreateObject("WScript.Shell")\r\n' +
                'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + helperPath +
                '"" -Key ' + key + ' -FireFile ""' + p.fire + '"" -StopFile ""' + p.stop + '"" -StatusFile ""' + p.status + '""", 0, False\r\n');
            vbs.close();
            var ok = false;
            try { ok = !!vbs.execute(); } catch (e1) { ok = false; }
            if (!ok) { state.hotkey.status = 'error'; state.hotkey.error = 'launch_failed'; return; }
            state.hotkeyStartedAt = (new Date()).getTime();
            state.hotkey.status = 'starting';
        } catch (e2) {
            state.hotkey.status = 'error';
            state.hotkey.error = errText(e2);
        }
    }

    /* 消费助手写入的触发信号；返回 true 表示本 tick 已切换暂停。 */
    function consumeHotkeyFire() {
        var p = hotkeyPaths();
        var text = readTextFile(p.fire);
        if (text === null || text === '') { return false; }
        text = String(text).replace(/\s+$/, '');
        if (!text || text === state.hotkeyLastFire) { return false; }
        state.hotkeyLastFire = text;
        if (!state.hotkey.enabled) { return false; }
        setPausedInternal(!state.paused);
        return true;
    }

    function errText(e) {
        try { if (e && e.message) { return str(e.message); } } catch (x1) { }
        return str(e);
    }

    /* v1.2.1：画布名只保留“去掉末尾一个 .psd”后的名字。
       "未标题-1" 与 "未标题-1.psd" 视为同一画布；"测试.psd.psd" -> "测试.psd"。 */
    function docBaseName(name) {
        var raw = str(name);
        try {
            if (state.core) {
                var normalized = state.core.normalizeName(raw);
                if (normalized !== null) { return normalized; }
            }
        } catch (e0) { }
        return raw;
    }

    function makeErrorJson(code, detail) {
        var s = '{"ok":false,"error":"' + str(code).replace(/["\\]/g, '') + '"';
        if (detail) {
            s += ',"detail":"' + str(detail).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '').replace(/\n/g, ' ') + '"';
        }
        return s + '}';
    }

    /* ================================================================ */
    /* 初始化：加载 core.jsx、读数据、读本地化工具名                      */
    /* ================================================================ */

    function loadCore() {
        if (state.core) { return true; }
        var candidates = [];
        var root = normalizePath(state.extRoot);
        if (root) { candidates.push(root + '/jsx/core.jsx'); }
        try {
            var hostFile = new File($.fileName);
            if (hostFile && hostFile.parent) { candidates.push(normalizePath(hostFile.parent.fsName) + '/core.jsx'); }
        } catch (e0) { }
        var i;
        for (i = 0; i < candidates.length; i++) {
            try {
                var f = new File(candidates[i]);
                if (!f.exists) { continue; }
                $.evalFile(f);
                var core = null;
                try { if (typeof AowuCounterCore !== 'undefined') { core = AowuCounterCore; } } catch (e1) { core = null; }
                if (!core) {
                    try { if ($.global && $.global.AowuCounterCore) { core = $.global.AowuCounterCore; } } catch (e2) { core = null; }
                }
                if (core) {
                    state.core = core;
                    state.corePath = candidates[i];
                    return true;
                }
            } catch (e3) {
                state.coreError = errText(e3);
            }
        }
        if (!state.coreError) { state.coreError = 'core.jsx 未找到：' + candidates.join(' ; '); }
        return false;
    }

    /* 加载历史状态身份检测器（DOM 引用序列对比，见 jsx/dom-detector.jsx）。 */
    function loadDomLib() {
        if (state.domLib) { return true; }
        var candidates = [];
        var root = normalizePath(state.extRoot);
        if (root) { candidates.push(root + '/jsx/dom-detector.jsx'); }
        try {
            var hostFile = new File($.fileName);
            if (hostFile && hostFile.parent) { candidates.push(normalizePath(hostFile.parent.fsName) + '/dom-detector.jsx'); }
        } catch (e0) { }
        var i;
        for (i = 0; i < candidates.length; i++) {
            try {
                var f = new File(candidates[i]);
                if (!f.exists) { continue; }
                $.evalFile(f);
                var lib = null;
                try { if (typeof AowuCounterDomDetector !== 'undefined') { lib = AowuCounterDomDetector; } } catch (e1) { lib = null; }
                if (!lib) {
                    try { if ($.global && $.global.AowuCounterDomDetector) { lib = $.global.AowuCounterDomDetector; } } catch (e2) { lib = null; }
                }
                if (lib) {
                    state.domLib = lib;
                    state.domLibPath = candidates[i];
                    return true;
                }
            } catch (e3) {
                state.domLibError = errText(e3);
            }
        }
        if (!state.domLibError) { state.domLibError = 'dom-detector.jsx 未找到：' + candidates.join(' ; '); }
        return false;
    }

    function dataDirPath() {
        if (state.dataRootOverride) { return normalizePath(state.dataRootOverride); }
        return normalizePath(Folder.userData.fsName) + '/AowuCounter';
    }

    function dataFilePath() {
        return dataDirPath() + '/aowu-counter-data.txt';
    }

    /* ================================================================ */
    /* v1.4.0：独立排行榜                                                 */
    /* 排行榜是单独持久化的历史榜，与“计数记录”完全分开：                  */
    /*   - 记录删除/清空/改名不影响排行榜；                              */
    /*   - 排行榜单条/全部删除也不影响记录；                              */
    /*   - 记录增长时按名字把最高笔数同步进排行榜。                        */
    /* ================================================================ */

    function leaderboardFilePath() {
        return dataDirPath() + '/aowu-counter-leaderboard.txt';
    }

    function leaderboardDeletedPath() {
        return dataDirPath() + '/aowu-counter-leaderboard-deleted.txt';
    }

    function leaderboardDataLineCount(text) {
        if (!text) { return 0; }
        var lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
        var n = 0;
        var i;
        for (i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\s+|\s+$/g, '');
            if (line && line.charAt(0) !== '#') { n++; }
        }
        return n;
    }

    function mergeLeaderboardEntry(name, count, createdAt, force) {
        if (!state.leaderboardModel || !state.core) { return false; }
        var normalized = state.core.normalizeName(name);
        if (normalized === null) { return false; }
        var n = state.core.clampCount(count);
        var tomb = state.leaderboardDeleted[normalized];
        if (tomb !== undefined) {
            /* 当前记录仍然存在：排行榜是记录的实时镜像，直接重新同步并清墓碑。
               墓碑只用于“记录已不存在”的历史条目在用户删除后保持隐藏。 */
            if (!force && n <= Number(tomb)) { return false; }
            delete state.leaderboardDeleted[normalized];
        }
        var entry = state.leaderboardModel.findByName(normalized);
        var changed = (tomb !== undefined);
        if (entry) {
            if (n > entry.count) { entry.count = n; changed = true; }
            return changed;
        }
        if (state.leaderboardModel.count() >= state.core.MAX_COUNTERS) { return false; }
        var created = state.leaderboardModel.createCounter(normalized, createdAt || state.core.nowMs());
        if (!created || !created.ok) { return false; }
        created.counter.count = n;
        return true;
    }

    function syncLeaderboardFromCounter(counter) {
        if (!counter) { return false; }
        var changed = mergeLeaderboardEntry(counter.name, counter.count, counter.createdAt, true);
        if (changed) { saveLeaderboard(); }
        return changed;
    }

    function syncLeaderboardFromRecords() {
        if (!state.leaderboardModel || !state.model || !state.core) { return false; }
        var list = state.model.getCounters();
        var changed = false;
        var i;
        for (i = 0; i < list.length; i++) {
            if (mergeLeaderboardEntry(list[i].name, list[i].count, list[i].createdAt, true)) { changed = true; }
        }
        if (changed) { saveLeaderboard(); }
        return changed;
    }

    function loadLeaderboard() {
        state.leaderboardPath = leaderboardFilePath();
        state.leaderboardDeletedPath = leaderboardDeletedPath();
        state.leaderboardDeleted = {};
        var model = state.core.createModel();
        var existed = false;
        var text = readTextFile(state.leaderboardPath);
        if (text !== null) {
            existed = true;
            var res = null;
            try { res = model.loadFromText(text); } catch (e0) { res = null; }
            if (!res || !res.ok) { state.leaderboardWarning = 'leaderboard_load'; }
        }
        state.leaderboardModel = model;
        /* 删除墓碑：用户亲自删掉的排行榜名字，之后同步记录时不再自动加回 */
        var deletedText = readTextFile(state.leaderboardDeletedPath);
        if (deletedText) {
            var dlines = String(deletedText).replace(/^\uFEFF/, '').split(/\r?\n/);
            var di;
            for (di = 0; di < dlines.length; di++) {
                var dnRaw = dlines[di].replace(/^\s+|\s+$/g, '');
                if (!dnRaw) { continue; }
                var dnParts = dnRaw.split('\t');
                var dn = dnParts[0].replace(/^\s+|\s+$/g, '');
                var dnCount = Number(dnParts.length > 1 ? dnParts[1] : 0);
                if (!isFinite(dnCount) || dnCount < 0) { dnCount = 0; }
                if (dn) { state.leaderboardDeleted[dn] = Math.floor(dnCount); }
            }
        }
        var changed = false;
        /* 首次升级：从“记录数据的上一份备份”恢复历史高笔数，避免升级后排行榜丢失已删记录。
           只在排行榜文件不存在时做一次；之后排行榜完全独立，不再从记录备份重建。 */
        if (!existed) {
            var backupText = readTextFile(state.dataPath + '.bak');
            if (backupText) {
                var bm = state.core.createModel();
                var br = null;
                try { br = bm.loadFromText(backupText); } catch (e1) { br = null; }
                if (br && br.ok) {
                    var blist = bm.getCounters();
                    var bi;
                    for (bi = 0; bi < blist.length; bi++) {
                        if (mergeLeaderboardEntry(blist[bi].name, blist[bi].count, blist[bi].createdAt)) { changed = true; }
                    }
                }
            }
        }
        /* 旧版墓碑只有名字（没有删除时笔数）：尝试从排行榜 .bak 找回当时笔数，
           这样“用户删除后记录继续增长”能正确重新同步；2psd 等无活动记录保持删除。 */
        try {
            var lbBakText = readTextFile(state.leaderboardPath + '.bak');
            if (lbBakText) {
                var lbBakModel = state.core.createModel();
                var lbBakRes = null;
                try { lbBakRes = lbBakModel.loadFromText(lbBakText); } catch (e2) { lbBakRes = null; }
                if (lbBakRes && lbBakRes.ok) {
                    for (var tombName in state.leaderboardDeleted) {
                        if (Number(state.leaderboardDeleted[tombName]) > 0) { continue; }
                        var oldEntry = lbBakModel.findByName(tombName);
                        if (oldEntry) { state.leaderboardDeleted[tombName] = oldEntry.count; }
                    }
                }
            }
        } catch (eBak2) { }
        /* 当前记录始终按最大值同步进排行榜（超过墓碑删除时笔数的会重新显示） */
        var list = state.model.getCounters();
        var i;
        for (i = 0; i < list.length; i++) {
            if (mergeLeaderboardEntry(list[i].name, list[i].count, list[i].createdAt, true)) { changed = true; }
        }
        if (!existed || changed) { saveLeaderboard(); }
    }

    function saveLeaderboard() {
        if (!state.leaderboardModel) { return false; }
        try {
            var folderPath = dataDirPath();
            var folder = new Folder(folderPath);
            if (!folder.exists) { folder.create(); }
            var targetPath = state.leaderboardPath || leaderboardFilePath();
            var text = state.leaderboardModel.serialize();
            /* 覆盖前备份上一份有内容的排行榜 */
            try {
                var prev = readTextFile(targetPath);
                if (prev && leaderboardDataLineCount(prev) > 0) { writeTextFile(targetPath + '.bak', prev); }
            } catch (eBak) { }
            if (!writeTextFile(targetPath, text)) { return false; }
            var names = [];
            for (var k in state.leaderboardDeleted) {
                if (state.leaderboardDeleted[k] || state.leaderboardDeleted[k] === 0) {
                    names.push(k + '\t' + String(Number(state.leaderboardDeleted[k]) || 0));
                }
            }
            writeTextFile(state.leaderboardDeletedPath || leaderboardDeletedPath(), names.join('\n'));
            return true;
        } catch (e0) {
            return false;
        }
    }

    function publicDeleteLeaderboardCounter(id) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            id = str(id);
            var entry = state.leaderboardModel.findById(id);
            if (!entry) { return withState({ ok: false, error: 'missing' }); }
            state.leaderboardDeleted[entry.name] = entry.count;
            state.leaderboardModel.deleteCounter(id);
            saveLeaderboard();
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('leaderboard_delete_failed', errText(e0));
        }
    }

    function publicDeleteAllLeaderboard() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            var list = state.leaderboardModel.getCounters();
            var ids = [];
            var i;
            for (i = 0; i < list.length; i++) {
                state.leaderboardDeleted[list[i].name] = list[i].count;
                ids.push(list[i].id);
            }
            for (i = 0; i < ids.length; i++) { state.leaderboardModel.deleteCounter(ids[i]); }
            saveLeaderboard();
            return withState({ ok: true, deleted: ids.length });
        } catch (e0) {
            return makeErrorJson('leaderboard_delete_all_failed', errText(e0));
        }
    }

    function loadData() {
        state.dataPath = dataFilePath();
        var model = state.core.createModel();
        var text = '';
        var readOk = true;
        try {
            var f = new File(state.dataPath);
            if (f.exists) {
                f.encoding = 'UTF-8';
                if (f.open('r')) {
                    text = f.read();
                    f.close();
                } else {
                    readOk = false;
                }
            }
        } catch (e0) {
            readOk = false;
            state.dataWarning = 'data_read_failed';
        }
        var res = null;
        try {
            res = model.loadFromText(text);
        } catch (e1) {
            res = { ok: false, errors: [errText(e1)] };
        }
        if (!res || !res.ok) {
            state.dataWarning = 'data_load';
        }
        state.model = model;
        /* v1.2.1 的旧名字规范化在 loadFromText 内存里完成；这里不再自动写回，
           避免“文件读取异常/解析为空”时把用户数据覆盖成空文件。下次正常计数保存时自然写回。 */
        return readOk;
    }

    function saveData() {
        if (!state.model) { return false; }
        try {
            var folderPath = dataDirPath();
            var folder = new Folder(folderPath);
            if (!folder.exists) { folder.create(); }
            var text = state.model.serialize();
            var targetPath = state.dataPath || dataFilePath();
            /* v1.3.0：写主数据前把上一份“有记录”的数据备份到 .bak；
               单独清空全部时主文件变文件头，但 .bak 保留上一份，便于误删恢复。 */
            try {
                var prevFile = new File(targetPath);
                if (prevFile.exists) {
                    prevFile.encoding = 'UTF-8';
                    if (prevFile.open('r')) {
                        var prevText = String(prevFile.read());
                        prevFile.close();
                        var prevLines = prevText.replace(/^\uFEFF/, '').split(/\r?\n/);
                        var prevDataLines = 0;
                        var pi;
                        for (pi = 0; pi < prevLines.length; pi++) {
                            var pl = prevLines[pi].replace(/^\s+|\s+$/g, '');
                            if (pl && pl.charAt(0) !== '#') { prevDataLines++; }
                        }
                        if (prevDataLines > 0) {
                            writeTextFile(targetPath + '.bak', prevText);
                        }
                    }
                }
            } catch (eBak) { }
            var f = new File(targetPath);
            f.encoding = 'UTF-8';
            if (!f.open('w')) {
                state.lastSaveError = 'open_failed';
                return false;
            }
            f.write(text);
            f.close();
            state.lastSaveError = '';
            /* v1.4.2：记录有变化就标记排行榜待同步；下一次取状态时兜底同步，
               避免某条新建/改名路径漏掉 syncLeaderboardFromCounter。 */
            state.leaderboardDirty = true;
            return true;
        } catch (e0) {
            state.lastSaveError = errText(e0);
            return false;
        }
    }

    /* 读取本地化画笔/铅笔工具名（application.tools → toolID + toolTip），失败用兜底。
       注意：历史记录里的名称不总等于工具提示全名。实测中文 PS 2025：
         画笔工具 → 历史名「画笔工具」；铅笔工具 → 历史名「铅笔」。
       因此每个学到的名字都同时加入「去掉结尾 工具/Tool」的短名。
       兜底字符串用 \u 转义，保证 JSX 源码即使按其他编码读取也不会破坏匹配。 */
    function readPaintNames() {
        var names = [];
        var fallback = [
            '\u753b\u7b14\u5de5\u5177',          /* 画笔工具 */
            '\u753b\u7b14',                      /* 画笔 */
            'Brush Tool',
            'Brush',
            '\u94c5\u7b14\u5de5\u5177',          /* 铅笔工具 */
            '\u94c5\u7b14',                      /* 铅笔 */
            'Pencil Tool',
            'Pencil'
        ];
        function add(name) {
            name = str(name);
            if (!name) { return; }
            name = name.replace(/\s*\([^)]*\)\s*$/, '');
            if (!name) { return; }
            var i;
            for (i = 0; i < names.length; i++) { if (names[i] === name) { return; } }
            names.push(name);
        }
        function addAll(name) {
            add(name);
            var n = str(name);
            var base = n.replace(/\s*(\u5de5\u5177|Tool)\s*$/, '');
            if (base && base !== n) { add(base); }
        }
        try {
            var ref = new ActionReference();
            ref.putProperty(stringIDToTypeID('application'), stringIDToTypeID('tools'));
            var desc = executeActionGet(ref);
            var list = desc.getList(stringIDToTypeID('tools'));
            var i;
            for (i = 0; i < list.count; i++) {
                var td = list.getObjectValue(i);
                var toolID = '';
                try { toolID = str(td.getString(stringIDToTypeID('toolID'))); } catch (e1) { toolID = ''; }
                if (toolID !== 'paintbrushTool' && toolID !== 'pencilTool') { continue; }
                var tip = '';
                try { tip = str(td.getString(stringIDToTypeID('toolTip'))); } catch (e2) { tip = ''; }
                addAll(tip);
            }
        } catch (e3) { }
        for (var k = 0; k < fallback.length; k++) { addAll(fallback[k]); }
        return names;
    }

    function ensureInit() {
        if (state.initialized) { return true; }
        if (!loadCore()) { return false; }
        if (!loadDomLib()) { return false; }
        state.paintNames = readPaintNames();
        loadData();
        loadLeaderboard();
        state.detector = state.domLib.createDetector();
        try { state.detector.setPaintNames(state.paintNames); } catch (e0) { }
        state.docRuntime = {};
        state.initialized = true;
        // 真机 E2E 文件通道：扩展目录下存在 e2e/ 文件夹和 e2e.flag 时启用
        try {
            if (state.extRoot) {
                var e2eDir = new Folder(normalizePath(state.extRoot) + '/e2e');
                if (e2eDir.exists) {
                    var flag = new File(normalizePath(state.extRoot) + '/e2e/e2e.flag');
                    if (flag.exists) {
                        state.e2eEnabled = true;
                        state.e2eDir = normalizePath(state.extRoot) + '/e2e';
                    }
                }
            }
        } catch (e1) { state.e2eEnabled = false; }
        return true;
    }

    /* ================================================================ */
    /* E2E 文件通道（仅测试启用，用户环境不产生任何额外文件读写）          */
    /* ================================================================ */

    function e2eWriteText(path, text) {
        try {
            var f = new File(path);
            f.encoding = 'UTF-8';
            if (!f.open('w')) { return false; }
            f.write(String(text));
            f.close();
            return true;
        } catch (e0) {
            return false;
        }
    }

    function e2eReadText(path) {
        try {
            var f = new File(path);
            if (!f.exists) { return null; }
            f.encoding = 'UTF-8';
            if (!f.open('r')) { return null; }
            var text = f.read();
            f.close();
            return String(text);
        } catch (e0) {
            return null;
        }
    }

    function e2eMaybeWriteState(obj, force) {
        if (!state.e2eEnabled || !state.core) { return; }
        var now = (new Date()).getTime();
        if (!force && (now - state.e2eLastWrite) < 250) { return; }
        state.e2eLastWrite = now;
        try {
            obj.ts = now;
            obj.e2e = true;
            e2eWriteText(state.e2eDir + '/state.json', state.core.jsonStringify(obj));
        } catch (e0) { }
    }

    function e2eExecCommand(parts) {
        var op = parts.length > 0 ? str(parts[0]) : '';
        var doc, docId, rt, counter, i;
        if (op === 'ping') { return { ok: true }; }
        if (op === 'clear') {
            doc = activeDocOrNull();
            if (!doc) { return { ok: false, error: 'no_active_doc' }; }
            try { docId = doc.id; } catch (e1) { return { ok: false, error: 'doc_error' }; }
            rt = runtimeFor(docId);
            counter = counterForDoc(doc, rt);
            if (!counter) { return { ok: false, error: 'no_active_counter' }; }
            state.model.clearCounter(counter.id);
            if (rt) { rt.counterId = counter.id; }
            saveData();
            return { ok: true };
        }
        if (op === 'delete') {
            var r = state.model.deleteCounter(str(parts[1] || ''));
            if (!r || !r.ok) { return { ok: false, error: 'missing' }; }
            for (i in state.docRuntime) {
                if (state.docRuntime[i].counterId === str(parts[1])) { state.docRuntime[i].counterId = null; }
            }
            saveData();
            return { ok: true };
        }
        if (op === 'rename') {
            var rr = state.model.renameCounter(str(parts[1] || ''), str(parts[2] || ''));
            if (!rr || !rr.ok) { return { ok: false, error: (rr && rr.reason) ? rr.reason : 'missing' }; }
            saveData();
            return { ok: true };
        }
        if (op === 'debugaddcounter') {
            var addName = str(parts[1] || '');
            if (!addName) { return { ok: false, error: 'invalid' }; }
            if (state.model.findByName(addName)) { return { ok: false, error: 'duplicate' }; }
            var addRes = state.model.createCounter(addName, state.core.nowMs());
            if (!addRes || !addRes.ok) {
                return { ok: false, error: (addRes && addRes.reason) ? addRes.reason : 'create_failed' };
            }
            var addCount = Number(parts[2]);
            if (isFinite(addCount) && addCount > 0) {
                addRes.counter.count = Math.min(Math.floor(addCount), state.core.MAX_STROKES);
            }
            saveData();
            return { ok: true };
        }
        if (op === 'debugset') {
            var c = state.model.findByName(str(parts[1] || ''));
            if (!c) { return { ok: false, error: 'missing' }; }
            var n = Number(parts[2]);
            if (!isFinite(n) || n < 0) { n = 0; }
            if (n > state.core.MAX_STROKES) { n = state.core.MAX_STROKES; }
            c.count = Math.floor(n);
            saveData();
            return { ok: true };
        }
        if (op === 'debugreset') {
            var list = state.model.getCounters();
            var guard = 0;
            while (list.length > 0 && guard < 30) {
                guard++;
                state.model.deleteCounter(list[0].id);
                list = state.model.getCounters();
            }
            state.docRuntime = {};
            saveData();
            return { ok: true };
        }
        return { ok: false, error: 'unknown_cmd' };
    }

    function e2eProcessCommand() {
        if (!state.e2eEnabled) { return; }
        var cmdPath = state.e2eDir + '/cmd.txt';
        try {
            var f = new File(cmdPath);
            if (!f.exists) { return; }
            f.encoding = 'UTF-8';
            if (!f.open('r')) { return; }
            var text = f.read();
            f.close();
            try { f.remove(); } catch (e1) { }
            var lines = str(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            var line = '';
            for (var i = 0; i < lines.length; i++) {
                if (str(lines[i]).replace(/^\s+|\s+$/g, '') !== '') { line = lines[i]; break; }
            }
            if (!line) { return; }
            var parts = line.split('\t');
            var res = null;
            try {
                res = e2eExecCommand(parts);
            } catch (e2) {
                res = { ok: false, error: errText(e2) };
            }
            var out = 'ok=' + (res && res.ok ? '1' : '0') + '\nerror=' + ((res && res.error) ? res.error : '') + '\ncmd=' + line + '\n';
            e2eWriteText(state.e2eDir + '/result.txt', out);
        } catch (e3) { }
    }

    /* ================================================================ */
    /* Photoshop 读取                                                     */
    /* ================================================================ */

    function activeDocOrNull() {
        try {
            if (app.documents.length === 0) { return null; }
            return app.activeDocument;
        } catch (e0) {
            return null;
        }
    }

    /* ---------------------------------------------------------------- */
    /* 历史状态读取（DOM；CEP 环境里按 index / ID 的 Action Manager get   */
    /* 会被 PS 拒绝 -1715，实测不可用，所以用 Document.historyStates）      */
    /* ---------------------------------------------------------------- */

    function readHistoryCount(doc) {
        try { return doc.historyStates.length; } catch (e0) { return -1; }
    }

    function readHistoryTokenAt(doc, index) {
        try { return doc.historyStates[index]; } catch (e0) { return null; }
    }

    function readHistoryNameAt(doc, index) {
        try { return str(doc.historyStates[index].name); } catch (e0) { return ''; }
    }

    function readLastHistoryToken(doc) {
        var count = readHistoryCount(doc);
        if (count <= 0) { return null; }
        return readHistoryTokenAt(doc, count - 1);
    }

    function readAllHistory(doc) {
        var tokens = [];
        var names = [];
        var count = readHistoryCount(doc);
        var i;
        for (i = 0; i < count; i++) {
            try {
                var st = doc.historyStates[i];
                tokens.push(st);
                names.push(str(st.name));
            } catch (e0) {
                // 单个状态读取失败时跳过，保持 token/name 对齐
            }
        }
        return { tokens: tokens, names: names, count: tokens.length };
    }

    function sameToken(a, b) {
        try { return a === b; } catch (e0) { return false; }
    }

    /* ================================================================ */
    /* 计数器解析 / 创建 / 改名跟随                                       */
    /* ================================================================ */

    function runtimeFor(docId) {
        return state.docRuntime[docId] || null;
    }

    function counterForDoc(doc, rt) {
        var name = '';
        try { name = docBaseName(doc.name); } catch (e0) { return null; }
        if (rt && rt.counterId) {
            var byId = state.model.findById(rt.counterId);
            if (byId && byId.name === name) { return byId; }
        }
        return state.model.findByName(name);
    }

    /* -> {ok:true, counter, created} | {ok:false, reason:'limit'|...} */
    function ensureCounterForDoc(doc, rt) {
        var name = '';
        try { name = docBaseName(doc.name); } catch (e0) { name = ''; }
        if (!name) { return { ok: false, reason: 'no_name' }; }
        if (rt && rt.counterId) {
            var bound = state.model.findById(rt.counterId);
            if (bound && bound.name === name) {
                return { ok: true, counter: bound, created: false };
            }
            // 用户手动把计数器改成别的名字：按名字规则重新找/建，不强行改回
            rt.counterId = null;
        }
        var byName = state.model.findByName(name);
        if (byName) {
            if (rt) { rt.counterId = byName.id; }
            return { ok: true, counter: byName, created: false };
        }
        if (state.model.count() >= state.core.MAX_COUNTERS) {
            return { ok: false, reason: 'limit' };
        }
        var created = state.model.createCounter(name, state.core.nowMs());
        if (!created || !created.ok) {
            return { ok: false, reason: (created && created.reason) ? created.reason : 'create_failed' };
        }
        if (rt) { rt.counterId = created.counter.id; }
        try { syncLeaderboardFromCounter(created.counter); } catch (eLb) { }
        return { ok: true, counter: created.counter, created: true };
    }

    function handleDocRename(doc, rt, newName) {
        var oldName = rt.name;
        var counter = null;
        if (rt.counterId) { counter = state.model.findById(rt.counterId); }
        if (!counter) { counter = state.model.findByName(oldName); }
        rt.name = newName;
        if (!counter) {
            // 之前没有记录：如果新名字命中已有计数器则关联，否则什么都不做（等画笔再建）
            var byNew = state.model.findByName(newName);
            if (byNew) { rt.counterId = byNew.id; }
            return;
        }
        if (counter.name === newName) { rt.counterId = counter.id; return; }
        var existing = state.model.findByName(newName);
        if (existing && existing.id !== counter.id) {
            var merged = state.model.mergeCounterInto(counter.id, existing.id);
            if (merged && merged.ok) {
                rt.counterId = existing.id;
                saveData();
            }
            return;
        }
        var renamed = state.model.renameCounter(counter.id, newName);
        if (renamed && renamed.ok) {
            rt.counterId = counter.id;
            saveData();
            return;
        }
        // 极端情况：校验时才发现重名 → 合并
        var dup = state.model.findByName(newName);
        if (dup && dup.id !== counter.id) {
            var merged2 = state.model.mergeCounterInto(counter.id, dup.id);
            if (merged2 && merged2.ok) {
                rt.counterId = dup.id;
                saveData();
            }
        }
    }

    /* ================================================================ */
    /* 核心 tick：检测新笔数并累计                                         */
    /* ================================================================ */

    function pruneRuntime() {
        var alive = {};
        var i;
        try {
            for (i = 0; i < app.documents.length; i++) {
                try { alive[app.documents[i].id] = true; } catch (e0) { }
            }
        } catch (e1) {
            return;
        }
        for (var k in state.docRuntime) {
            if (!alive[k]) {
                try { state.detector.forgetDoc(Number(k)); } catch (e2) { }
                try { delete state.docRuntime[k]; } catch (e3) { }
            }
        }
    }

    function tick() {
        pruneRuntime();
        try { refreshHotkeyStatus(); } catch (eHk) { }
        try { if (consumeHotkeyFire()) { return; } } catch (eHf) { }
        if (state.paused) { return; }
        var doc = activeDocOrNull();
        if (!doc) { return; }
        var docId = 0;
        var docName = '';
        var docSaved = true;
        var count = -1;
        var lastToken = null;
        try {
            docId = doc.id;
            docName = docBaseName(doc.name);
            docSaved = (doc.saved === true);
            count = readHistoryCount(doc);
            lastToken = readLastHistoryToken(doc);
        } catch (e0) {
            state.lastTickError = errText(e0);
            return;
        }
        if (count < 0) { return; }
        var currentName = '';
        try { currentName = str(doc.activeHistoryState.name); } catch (e1) { }
        state.lastRead = { docId: docId, count: count, currentName: currentName };
        var rt = state.docRuntime[docId];
        if (!rt) {
            // 首次看到该文档：记录全部历史状态引用作为基线，本 tick 不计数
            var firstList = readAllHistory(doc);
            try { state.detector.ensureDoc(docId, firstList.tokens); } catch (e2) { }
            rt = {
                name: docName,
                counterId: null,
                lastCount: firstList.tokens.length,
                lastToken: firstList.tokens.length > 0 ? firstList.tokens[firstList.tokens.length - 1] : null
            };
            state.docRuntime[docId] = rt;
            var existing = state.model.findByName(docName);
            if (existing) {
                rt.counterId = existing.id;
            } else if (!docSaved) {
                // 新建画布：自动创建 0 笔计数器（容量允许时）
                var createdRes = ensureCounterForDoc(doc, rt);
                if (createdRes && createdRes.ok && createdRes.created) { saveData(); }
            }
            return;
        }
        if (rt.name !== docName) {
            handleDocRename(doc, rt, docName);
        }
        // 撤销/重做不会改变历史状态列表（只移动 active），列表长度与最后一个状态引用都不变；
        // 只有新操作才会让末尾出现新状态对象。
        if (count === rt.lastCount && sameToken(lastToken, rt.lastToken)) {
            return;
        }
        var newStrokeCount = 0;
        try {
            var appendedOnly = (count > rt.lastCount) &&
                (rt.lastCount > 0) &&
                sameToken(rt.lastToken, readHistoryTokenAt(doc, rt.lastCount - 1));
            if (appendedOnly) {
                // 纯追加（最常见的正常绘画）：只读新增的尾部状态
                var newTokens = [];
                var newNames = [];
                for (var n = rt.lastCount; n < count; n++) {
                    try {
                        var st = readHistoryTokenAt(doc, n);
                        newTokens.push(st);
                        newNames.push(str(st.name));
                    } catch (e3) { }
                }
                var appendRes = state.detector.appendStates(docId, newTokens, newNames);
                newStrokeCount = appendRes.newStrokeCount;
                rt.lastCount = count;
                rt.lastToken = lastToken;
            } else {
                // 撤销后新画 / 历史记录剪枝等：全量对比
                var fullList = readAllHistory(doc);
                var scanRes = state.detector.scanFull(docId, fullList.tokens, fullList.names);
                newStrokeCount = scanRes.newStrokeCount;
                rt.lastCount = fullList.tokens.length;
                rt.lastToken = fullList.tokens.length > 0 ? fullList.tokens[fullList.tokens.length - 1] : null;
            }
        } catch (e4) {
            state.lastTickError = errText(e4);
            return;
        }
        if (newStrokeCount > 0) {
            var target = ensureCounterForDoc(doc, rt);
            if (target && target.ok && target.counter) {
                var inc = state.model.increment(target.counter.id, newStrokeCount);
                if (inc && inc.ok) {
                    saveData();
                    try { syncLeaderboardFromCounter(target.counter); } catch (eLb) { }
                }
            }
        }
    }

    /* ================================================================ */
    /* 状态 JSON                                                          */
    /* ================================================================ */

    function buildStateObj() {
        var docObj = null;
        var activeCounterId = null;
        var warning = state.dataWarning || '';
        var doc = activeDocOrNull();
        if (doc) {
            var docId = 0;
            var docName = '';
            var saved = true;
            try {
                docId = doc.id;
                docName = docBaseName(doc.name);
                saved = (doc.saved === true);
            } catch (e0) {
                doc = null;
            }
            if (doc) {
                docObj = { id: docId, name: docName, saved: saved };
                var rt = state.docRuntime[docId];
                var c = counterForDoc(doc, rt);
                if (c) {
                    activeCounterId = c.id;
                    if (rt) { rt.counterId = c.id; }
                } else if (state.model.count() >= state.core.MAX_COUNTERS) {
                    warning = 'limit';
                }
            }
        }
        var counters = [];
        var list = state.model.getCounters();
        for (var i = 0; i < list.length; i++) {
            counters.push({
                id: list[i].id,
                name: list[i].name,
                count: list[i].count,
                createdAt: list[i].createdAt
            });
        }
        var leaderboard = [];
        /* v1.4.2：排行榜实时镜像当前计数记录。
           每次取状态时（最多每 100ms 一次）兜底同步：缺名字就新增、已有名字只升不降。
           这样无论用户删了多少次计数记录、或某条新建路径漏掉即时同步，排行榜都会自动补上。 */
        if (state.leaderboardModel) {
            var lbNow = (new Date()).getTime();
            if (state.leaderboardDirty || (lbNow - state.lastLeaderboardSyncAt) > 100) {
                state.leaderboardDirty = false;
                state.lastLeaderboardSyncAt = lbNow;
                try { syncLeaderboardFromRecords(); } catch (eLbDirty) { }
            }
        }
        if (state.leaderboardModel) {
            var llist = state.leaderboardModel.getCounters();
            var li;
            for (li = 0; li < llist.length; li++) {
                leaderboard.push({
                    id: llist[li].id,
                    name: llist[li].name,
                    count: llist[li].count,
                    createdAt: llist[li].createdAt
                });
            }
        }
        var tool = '';
        try { tool = str(app.currentTool); } catch (e2) { }
        var obj = {
            ok: true,
            version: VERSION,
            dataPath: state.dataPath,
            leaderboardPath: state.leaderboardPath,
            activeDoc: docObj,
            activeCounterId: activeCounterId,
            counters: counters,
            leaderboard: leaderboard,
            maxCounters: state.core.MAX_COUNTERS,
            maxStrokes: state.core.MAX_STROKES,
            paintNames: state.paintNames,
            tool: tool,
            paused: state.paused === true,
            hotkey: {
                enabled: state.hotkey.enabled === true,
                key: state.hotkey.key,
                status: state.hotkey.status,
                error: state.hotkey.error
            },
            warning: warning
        };
        if (state.e2eEnabled) {
            try {
                obj.debug = {
                    lastTickError: state.lastTickError,
                    lastRead: state.lastRead || null,
                    runtime: {},
                    detector: state.detector.snapshot()
                };
                for (var k in state.docRuntime) {
                    obj.debug.runtime[k] = {
                        name: state.docRuntime[k].name,
                        counterId: state.docRuntime[k].counterId,
                        lastCount: state.docRuntime[k].lastCount
                    };
                }
            } catch (e3) { }
        }
        return obj;
    }

    /* ================================================================ */
    /* 公开 API                                                           */
    /* ================================================================ */

    function withState(result) {
        var out = result || { ok: true };
        try { e2eProcessCommand(); } catch (eCmd) { }
        try { tick(); } catch (e0) { }
        var built = null;
        try { built = buildStateObj(); } catch (e1) { }
        if (built) {
            out.state = built;
            try { e2eMaybeWriteState(built, false); } catch (e2) { }
        }
        try { return state.core.jsonStringify(out); } catch (e3) { return makeErrorJson('json_failed', errText(e3)); }
    }

    function publicInit(extensionRoot, dataRoot) {
        try {
            state.extRoot = normalizePath(extensionRoot);
            state.initialized = false;
            state.core = null;
            if (extensionRoot) { state.extRoot = normalizePath(extensionRoot); }
            if (dataRoot) { state.dataRootOverride = normalizePath(dataRoot); }
            var ok = ensureInit();
            if (!ok) { return makeErrorJson('core_load_failed', state.coreError); }
            try { tick(); } catch (e0) { }
            /* 面板重新加载时先停掉上一页可能还活着的全局快捷键助手；
               面板读取 localStorage 后会再调用 configureHotkey 重新启动。 */
            state.hotkey.enabled = false;
            state.hotkey.status = 'disabled';
            state.hotkey.error = '';
            state.hotkeyLastFire = '';
            try {
                var hpInit = hotkeyPaths();
                writeTextFile(hpInit.stop, String((new Date()).getTime()));
                removeFile(hpInit.fire);
                removeFile(hpInit.status);
            } catch (eHkInit) { }
            if (state.e2eEnabled) {
                try {
                    var initState = buildStateObj();
                    initState.ts = (new Date()).getTime();
                    initState.e2e = true;
                    e2eWriteText(state.e2eDir + '/state.json', state.core.jsonStringify(initState));
                    state.e2eLastWrite = initState.ts;
                } catch (eE2E) { }
            }
            var out = {
                ok: true,
                version: VERSION,
                dataPath: state.dataPath,
                paintNames: state.paintNames,
                corePath: state.corePath,
                warning: state.dataWarning || '',
                tempDir: tempDirPath()
            };
            try { return state.core.jsonStringify(out); } catch (e1) { return makeErrorJson('json_failed', errText(e1)); }
        } catch (e2) {
            return makeErrorJson('init_failed', errText(e2));
        }
    }

    function publicGetState() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            try { e2eProcessCommand(); } catch (eCmd) { }
            try { tick(); } catch (e0) { state.lastTickError = errText(e0); }
            var obj = buildStateObj();
            try { e2eMaybeWriteState(obj, false); } catch (eWrite) { }
            try { return state.core.jsonStringify(obj); } catch (e1) { return makeErrorJson('json_failed', errText(e1)); }
        } catch (e2) {
            return makeErrorJson('state_failed', errText(e2));
        }
    }

    function publicClearCurrent() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            var doc = activeDocOrNull();
            if (!doc) { return withState({ ok: false, error: 'no_active_doc' }); }
            var docId = 0;
            try { docId = doc.id; } catch (e0) { }
            var rt = runtimeFor(docId);
            var counter = counterForDoc(doc, rt);
            if (!counter) { return withState({ ok: false, error: 'no_active_counter' }); }
            state.model.clearCounter(counter.id);
            if (rt) { rt.counterId = counter.id; }
            saveData();
            return withState({ ok: true, cleared: counter.name });
        } catch (e1) {
            return makeErrorJson('clear_failed', errText(e1));
        }
    }

    function publicDeleteCounter(id) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            id = str(id);
            var r = state.model.deleteCounter(id);
            if (!r || !r.ok) { return withState({ ok: false, error: 'missing' }); }
            var k;
            for (k in state.docRuntime) {
                if (state.docRuntime[k].counterId === id) { state.docRuntime[k].counterId = null; }
            }
            saveData();
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('delete_failed', errText(e0));
        }
    }

    function publicRenameCounter(id, newName) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            id = str(id);
            newName = str(newName);
            var r = state.model.renameCounter(id, newName);
            if (!r || !r.ok) {
                return withState({ ok: false, error: (r && r.reason) ? r.reason : 'missing' });
            }
            saveData();
            try { syncLeaderboardFromCounter(state.model.findById(id)); } catch (eLb) { }
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('rename_failed', errText(e0));
        }
    }

    /* v1.3.0：用户主动“全部删除”排行榜/记录；只由面板按钮调用，不做任何自动清理。 */
    function publicDeleteAllCounters() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            var list = state.model.getCounters();
            var ids = [];
            var i;
            for (i = 0; i < list.length; i++) { ids.push(list[i].id); }
            var deleted = 0;
            for (i = 0; i < ids.length; i++) {
                var r = state.model.deleteCounter(ids[i]);
                if (r && r.ok) { deleted++; }
            }
            state.docRuntime = {};
            saveData();
            return withState({ ok: true, deleted: deleted });
        } catch (e0) {
            return makeErrorJson('delete_all_failed', errText(e0));
        }
    }

    function publicGetVersion() {
        return '{"ok":true,"version":"' + VERSION + '"}';
    }

    /* v1.2.0：暂停/继续计数。暂停时 tick 不检测新笔画；恢复时重建检测基线，
       所以暂停期间画的笔画不会在恢复后补记。 */
    function publicSetPaused(paused) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            setPausedInternal(paused === true || paused === 'true');
            return withState({ ok: true, paused: state.paused });
        } catch (e0) {
            return makeErrorJson('pause_failed', errText(e0));
        }
    }

    /* v1.2.0：启用/停用全局暂停快捷键。key 支持 A-Z / 0-9 / F1-F12。 */
    function publicConfigureHotkey(enabled, key) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            enabled = (enabled === true || enabled === 'true');
            key = normalizeHotkeyKey(key);
            state.hotkey.enabled = enabled;
            state.hotkey.key = key;
            state.hotkey.error = '';
            if (enabled) {
                startHotkeyHelper(key);
            } else {
                stopHotkeyHelper();
                state.hotkey.status = 'disabled';
            }
            refreshHotkeyStatus();
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('hotkey_failed', errText(e0));
        }
    }

    /* v1.1.1：启动隐藏的 PowerShell 窗口移动助手（最小化横条拖拽用）。
       助手脚本在 jsx/window-drag.ps1，通过临时 bat 调 powershell -WindowStyle Hidden 启动。 */
    function publicStartWindowDragHelper() {
        try {
            var root = normalizePath(state.extRoot);
            if (!root) {
                try {
                    var hf = new File($.fileName);
                    if (hf && hf.parent && hf.parent.parent) {
                        root = normalizePath(hf.parent.parent.fsName);
                    }
                } catch (e0) { }
            }
            if (!root) { return '{"ok":false,"error":"no_ext_root"}'; }
            var helperPath = root + '/jsx/window-drag.ps1';
            var helper = new File(helperPath);
            if (!helper.exists) { return '{"ok":false,"error":"helper_missing"}'; }
            /* v1.1.2：用 .vbs + WScript.Shell.Run(..., 0, False) 启动隐藏 PowerShell，
               避免 .bat 经 cmd.exe 启动时闪一下黑色命令窗口。 */
            var vbsPath = Folder.temp.fsName + '/aowu_drag_launcher.vbs';
            var vbs = new File(vbsPath);
            vbs.encoding = 'UTF-8';
            if (!vbs.open('w')) { return '{"ok":false,"error":"vbs_open_failed"}'; }
            vbs.write('Set sh = CreateObject("WScript.Shell")\r\n' +
                'sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + helperPath + '""", 0, False\r\n');
            vbs.close();
            var ok = false;
            try { ok = !!vbs.execute(); } catch (e1) { ok = false; }
            return ok ? '{"ok":true}' : '{"ok":false,"error":"execute_false"}';
        } catch (e2) {
            return makeErrorJson('drag_helper_failed', errText(e2));
        }
    }

    /* E2E 调试辅助（不显示在 UI） */
    function publicDebugSetCount(name, count) {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            var c = state.model.findByName(str(name));
            if (!c) { return withState({ ok: false, error: 'missing' }); }
            var n = Number(count);
            if (!isFinite(n) || n < 0) { n = 0; }
            if (n > state.core.MAX_STROKES) { n = state.core.MAX_STROKES; }
            c.count = Math.floor(n);
            saveData();
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('debug_failed', errText(e0));
        }
    }

    function publicDebugResetAll() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError); }
            var list = state.model.getCounters();
            while (list.length > 0) {
                state.model.deleteCounter(list[0].id);
                list = state.model.getCounters();
            }
            state.docRuntime = {};
            saveData();
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('debug_failed', errText(e0));
        }
    }

    function publicDebugInfo() {
        try {
            if (!ensureInit()) { return makeErrorJson('core_load_failed', state.coreError + ' | dom=' + state.domLibError); }
            var out = {
                ok: true,
                corePath: state.corePath,
                domLibPath: state.domLibPath,
                dataPath: state.dataPath,
                dataWarning: state.dataWarning,
                lastTickError: state.lastTickError,
                paintNames: state.paintNames,
                detector: null,
                lastRead: state.lastRead || null,
                runtime: {}
            };
            try { out.detector = state.detector.snapshot(); } catch (e0) { }
            for (var k in state.docRuntime) {
                out.runtime[k] = {
                    name: state.docRuntime[k].name,
                    counterId: state.docRuntime[k].counterId,
                    lastCount: state.docRuntime[k].lastCount
                };
            }
            try { return state.core.jsonStringify(out); } catch (e1) { return makeErrorJson('json_failed', errText(e1)); }
        } catch (e2) {
            return makeErrorJson('debug_failed', errText(e2));
        }
    }

    return {
        init: publicInit,
        getState: publicGetState,
        clearCurrent: publicClearCurrent,
        deleteCounter: publicDeleteCounter,
        renameCounter: publicRenameCounter,
        deleteAllCounters: publicDeleteAllCounters,
        deleteLeaderboardCounter: publicDeleteLeaderboardCounter,
        deleteAllLeaderboard: publicDeleteAllLeaderboard,
        getVersion: publicGetVersion,
        setPaused: publicSetPaused,
        configureHotkey: publicConfigureHotkey,
        startWindowDragHelper: publicStartWindowDragHelper,
        _debugSetCount: publicDebugSetCount,
        _debugResetAll: publicDebugResetAll,
        _debugInfo: publicDebugInfo
    };
})();

try { $.global.AowuCounter = AowuCounter; } catch (e0) { }
