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
    var VERSION = '1.1.3';
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
        detector: null,
        paintNames: [],
        dataPath: '',
        dataWarning: '',
        lastSaveError: '',
        docRuntime: {},
        lastTickError: '',
        lastRead: null,
        initialized: false,
        e2eEnabled: false,
        e2eDir: '',
        e2eLastWrite: 0
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

    function errText(e) {
        try { if (e && e.message) { return str(e.message); } } catch (x1) { }
        return str(e);
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

    function dataFilePath() {
        var sep = '/';
        return normalizePath(Folder.userData.fsName) + sep + 'AowuCounter' + sep + 'aowu-counter-data.txt';
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
        return readOk;
    }

    function saveData() {
        if (!state.model) { return false; }
        try {
            var folderPath = normalizePath(Folder.userData.fsName) + '/AowuCounter';
            var folder = new Folder(folderPath);
            if (!folder.exists) { folder.create(); }
            var text = state.model.serialize();
            var f = new File(state.dataPath || dataFilePath());
            f.encoding = 'UTF-8';
            if (!f.open('w')) {
                state.lastSaveError = 'open_failed';
                return false;
            }
            f.write(text);
            f.close();
            state.lastSaveError = '';
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
        try { name = str(doc.name); } catch (e0) { return null; }
        if (rt && rt.counterId) {
            var byId = state.model.findById(rt.counterId);
            if (byId && byId.name === name) { return byId; }
        }
        return state.model.findByName(name);
    }

    /* -> {ok:true, counter, created} | {ok:false, reason:'limit'|...} */
    function ensureCounterForDoc(doc, rt) {
        var name = '';
        try { name = str(doc.name); } catch (e0) { name = ''; }
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
        var doc = activeDocOrNull();
        if (!doc) { return; }
        var docId = 0;
        var docName = '';
        var docSaved = true;
        var count = -1;
        var lastToken = null;
        try {
            docId = doc.id;
            docName = str(doc.name);
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
                if (inc && inc.ok) { saveData(); }
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
                docName = str(doc.name);
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
        var tool = '';
        try { tool = str(app.currentTool); } catch (e2) { }
        var obj = {
            ok: true,
            version: VERSION,
            dataPath: state.dataPath,
            activeDoc: docObj,
            activeCounterId: activeCounterId,
            counters: counters,
            maxCounters: state.core.MAX_COUNTERS,
            maxStrokes: state.core.MAX_STROKES,
            paintNames: state.paintNames,
            tool: tool,
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

    function publicInit(extensionRoot) {
        try {
            state.extRoot = normalizePath(extensionRoot);
            state.initialized = false;
            state.core = null;
            if (extensionRoot) { state.extRoot = normalizePath(extensionRoot); }
            var ok = ensureInit();
            if (!ok) { return makeErrorJson('core_load_failed', state.coreError); }
            try { tick(); } catch (e0) { }
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
            return withState({ ok: true });
        } catch (e0) {
            return makeErrorJson('rename_failed', errText(e0));
        }
    }

    function publicGetVersion() {
        return '{"ok":true,"version":"' + VERSION + '"}';
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
        getVersion: publicGetVersion,
        startWindowDragHelper: publicStartWindowDragHelper,
        _debugSetCount: publicDebugSetCount,
        _debugResetAll: publicDebugResetAll,
        _debugInfo: publicDebugInfo
    };
})();

try { $.global.AowuCounter = AowuCounter; } catch (e0) { }
