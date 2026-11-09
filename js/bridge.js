/*
 * 嗷呜计数 (Aowu Counter) v1.1.0 — CEP bridge + browser mock.
 *
 * 面板侧唯一与 Photoshop 通信的入口：window.AowuCounterBridge
 *   isCEP (bool), VERSION, isMock(), init(), getState(), clearCurrent(),
 *   deleteCounter(id), renameCounter(id, newName), mockAddStroke()
 *
 * 与 PS 通信约定：host.jsx 的每个公开函数都返回 JSON 字符串；
 * 本文件负责 evalScript 封装 + JSON.parse + mock 数据（浏览器预览）。
 */
(function (root) {
  'use strict';

  var VERSION = '1.4.1';
  var MAX_COUNTERS = 100000000;
  var MAX_STROKES = 100000000000;
  var cs = null;
  var mockCounters = null;
  var mockLeaderboard = null;
  var mockLeaderboardDeleted = {};
  var mockActiveId = null;
  var mockDocName = null;
  var mockListeners = [];
  var mockPaused = false;
  var mockHotkey = { enabled: false, key: 'P', status: 'disabled', error: '' };

  function isCEP() {
    return !!root.__adobe_cep__;
  }

  function isMock() {
    return !isCEP();
  }

  function nowMs() {
    return (new Date()).getTime();
  }

  function clampCount(n) {
    n = Number(n);
    if (!isFinite(n) || n < 0) { return 0; }
    n = Math.floor(n);
    return n > MAX_STROKES ? MAX_STROKES : n;
  }

  function getCS() {
    if (!cs) {
      if (typeof root.CSInterface !== 'function') {
        throw new Error('CSInterface 未加载');
      }
      cs = new root.CSInterface();
    }
    return cs;
  }

  var EVAL_TIMEOUT_MS = 2500;
  var lastEvalTimeoutAt = 0;

  function evalScript(script) {
    return new Promise(function (resolve, reject) {
      // Photoshop 正在画画时 evalScript 可能长时间不返回：超时后短暂冷却，
      // 避免把大量过期脚本排进 Photoshop 脚本队列（否则恢复后会卡很久）。
      if (nowMs() - lastEvalTimeoutAt < 900) {
        reject(new Error('Photoshop 忙，稍后重试'));
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          lastEvalTimeoutAt = nowMs();
          reject(new Error('与 Photoshop 通信超时'));
        }
      }, EVAL_TIMEOUT_MS);
      try {
        getCS().evalScript(script, function (result) {
          if (done) { return; }
          done = true;
          clearTimeout(timer);
          if (result === null || result === undefined || result === '' ||
              result === 'EvalScript error.' || result === 'EvalScript error') {
            reject(new Error('Photoshop 没有返回数据'));
            return;
          }
          resolve(result);
        });
      } catch (e) {
        if (!done) { done = true; clearTimeout(timer); reject(e); }
      }
    });
  }

  function callHost(fnCall) {
    if (isMock()) { return Promise.resolve(mockAction(fnCall)); }
    return evalScript(fnCall).then(function (raw) {
      var data;
      try { data = JSON.parse(raw); } catch (e) { throw new Error('Photoshop 返回数据无法解析'); }
      return data;
    });
  }

  function fire() {
    var i;
    for (i = 0; i < mockListeners.length; i++) {
      try { mockListeners[i](mockState()); } catch (e) { }
    }
  }

  /* ------------------------------------------------------------------ */
  /* browser mock                                                       */
  /* ------------------------------------------------------------------ */

  function ensureMock() {
    if (mockCounters) { return; }
    mockCounters = [
      { id: 'm1', name: '未命名-1', count: 12, createdAt: nowMs() - 86400000 },
      { id: 'm2', name: '线稿-草稿.psd', count: 3456, createdAt: nowMs() - 172800000 },
      { id: 'm3', name: '上色练习.psd', count: 0, createdAt: nowMs() - 259200000 }
    ];
    /* v1.4.0：排行榜独立；多一条“已从记录删除”的历史高笔数，用于预览/测试 */
    mockLeaderboard = [
      { id: 'lh1', name: '历史高笔数', count: 999, createdAt: nowMs() - 345600000 },
      { id: 'm2', name: '线稿-草稿.psd', count: 3456, createdAt: nowMs() - 172800000 },
      { id: 'm1', name: '未命名-1', count: 12, createdAt: nowMs() - 86400000 },
      { id: 'm3', name: '上色练习.psd', count: 0, createdAt: nowMs() - 259200000 }
    ];
    mockLeaderboardDeleted = {};
    mockDocName = '未命名-1';
    mockActiveId = 'm1';
  }

  function mockFindLeaderboardByName(name) {
    var i;
    for (i = 0; i < mockLeaderboard.length; i++) {
      if (mockLeaderboard[i].name === name) { return mockLeaderboard[i]; }
    }
    return null;
  }

  function mockSyncLeaderboard(name, count, createdAt) {
    if (mockLeaderboardDeleted[name]) { return; }
    var entry = mockFindLeaderboardByName(name);
    if (entry) {
      if (count > entry.count) { entry.count = count; }
      return;
    }
    mockLeaderboard.push({ id: 'lh-' + name, name: name, count: count, createdAt: createdAt || nowMs() });
  }

  function mockFindByName(name) {
    var i;
    for (i = 0; i < mockCounters.length; i++) {
      if (mockCounters[i].name === name) { return mockCounters[i]; }
    }
    return null;
  }

  function mockFindById(id) {
    var i;
    for (i = 0; i < mockCounters.length; i++) {
      if (mockCounters[i].id === id) { return mockCounters[i]; }
    }
    return null;
  }

  function mockState() {
    ensureMock();
    var counters = [];
    var i;
    for (i = 0; i < mockCounters.length; i++) {
      counters.push({
        id: mockCounters[i].id,
        name: mockCounters[i].name,
        count: mockCounters[i].count,
        createdAt: mockCounters[i].createdAt
      });
    }
    var leaderboard = [];
    for (i = 0; i < mockLeaderboard.length; i++) {
      leaderboard.push({
        id: mockLeaderboard[i].id,
        name: mockLeaderboard[i].name,
        count: mockLeaderboard[i].count,
        createdAt: mockLeaderboard[i].createdAt
      });
    }
    return {
      ok: true,
      version: VERSION,
      dataPath: '（浏览器预览模式，未连接 Photoshop）',
      activeDoc: { id: 1, name: mockDocName, saved: false },
      activeCounterId: mockActiveId,
      counters: counters,
      leaderboard: leaderboard,
      maxCounters: MAX_COUNTERS,
      maxStrokes: MAX_STROKES,
      paintNames: ['画笔工具', '铅笔工具'],
      tool: 'paintbrushTool',
      paused: mockPaused,
      hotkey: {
        enabled: mockHotkey.enabled === true,
        key: mockHotkey.key,
        status: mockHotkey.status,
        error: mockHotkey.error
      },
      warning: ''
    };
  }

  function mockAction(fnCall) {
    ensureMock();
    var m = /AowuCounter\.([A-Za-z_]+)\((.*)\)/.exec(fnCall);
    var name = m ? m[1] : '';
    if (name === 'getState') { return mockState(); }
    if (name === 'setPaused') {
      mockPaused = /true/i.test(String(m[2] || ''));
      fire();
      return { ok: true, paused: mockPaused, state: mockState() };
    }
    if (name === 'configureHotkey') {
      var hkParts = /AowuCounter\.configureHotkey\((true|false)\s*,\s*['"]([^'"]*)['"]\)$/i.exec(fnCall);
      var hkEnabled = hkParts ? (hkParts[1].toLowerCase() === 'true') : false;
      var hkKey = hkParts ? String(hkParts[2]).toUpperCase() : 'P';
      mockHotkey = {
        enabled: hkEnabled,
        key: hkKey,
        status: hkEnabled ? 'active' : 'disabled',
        error: ''
      };
      fire();
      return { ok: true, hotkey: mockHotkey, state: mockState() };
    }
    if (name === 'clearCurrent') {
      var active = mockActiveId ? mockFindById(mockActiveId) : null;
      if (active) { active.count = 0; }
      fire();
      return { ok: !!active, state: mockState(), error: active ? '' : 'no_active_counter' };
    }
    if (name === 'deleteCounter') {
      var id = m[2].replace(/^['"]|['"]$/g, '');
      var idx = -1;
      var i;
      for (i = 0; i < mockCounters.length; i++) { if (mockCounters[i].id === id) { idx = i; break; } }
      if (idx >= 0) { mockCounters.splice(idx, 1); }
      if (mockActiveId === id) { mockActiveId = null; }
      fire();
      return { ok: idx >= 0, state: mockState() };
    }
    if (name === 'deleteAllCounters') {
      var deleted = mockCounters.length;
      mockCounters.length = 0;
      mockActiveId = null;
      fire();
      return { ok: true, deleted: deleted, state: mockState() };
    }
    if (name === 'deleteLeaderboardCounter') {
      var lid = m[2].replace(/^['"]|['"]$/g, '');
      var lentry = null;
      var li;
      for (li = 0; li < mockLeaderboard.length; li++) {
        if (mockLeaderboard[li].id === lid) { lentry = mockLeaderboard[li]; break; }
      }
      if (lentry) {
        mockLeaderboardDeleted[lentry.name] = true;
        mockLeaderboard.splice(li, 1);
      }
      fire();
      return { ok: !!lentry, state: mockState() };
    }
    if (name === 'deleteAllLeaderboard') {
      var ldel = mockLeaderboard.length;
      var lj;
      for (lj = 0; lj < mockLeaderboard.length; lj++) { mockLeaderboardDeleted[mockLeaderboard[lj].name] = true; }
      mockLeaderboard.length = 0;
      fire();
      return { ok: true, deleted: ldel, state: mockState() };
    }
    if (name === 'renameCounter') {
      var parts = /AowuCounter\.renameCounter\(([^,]+),([\s\S]*)\)$/.exec(fnCall);
      var cid = parts ? parts[1].replace(/^\s*['"]|['"]\s*$/g, '') : '';
      var newName = parts ? parts[2].replace(/^\s*['"]|['"]\s*$/g, '') : '';
      var c = mockFindById(cid);
      var dup = mockFindByName(newName);
      if (!c) { return { ok: false, error: 'missing', state: mockState() }; }
      if (!newName || dup) { return { ok: false, error: dup ? 'duplicate' : 'invalid', state: mockState() }; }
      c.name = newName;
      fire();
      return { ok: true, state: mockState() };
    }
    if (name === 'getVersion') { return { ok: true, version: VERSION }; }
    return { ok: false, error: 'mock_unknown_call' };
  }

  /* ------------------------------------------------------------------ */
  /* 面板拖拽（v1.1.1）                                                   */
  /* CEP 没有移动窗口的 API；用 PS 端 host 启动一个隐藏的 PowerShell 助手， */
  /* 助手按 %TEMP%\aowu-counter-drag.ctrl 里的坐标移动面板的 OWL.Dock 窗口， */
  /* 并把当前窗口 rect 写到 %TEMP%\aowu-counter-drag.status。              */
  /* ------------------------------------------------------------------ */

  var dragState = { active: false, startedAt: 0, rect: null, startX: 0, startY: 0, helperAt: 0 };
  var dragTempDirOverride = '';

  function getCepFs() {
    try { return (root.cep && root.cep.fs) ? root.cep.fs : null; } catch (e) { return null; }
  }

  function dragTempDir() {
    if (dragTempDirOverride) { return dragTempDirOverride.replace(/[\\\/]+$/, ''); }
    try {
      var fs = getCepFs();
      if (fs && typeof fs.getTemporaryDirectory === 'function') {
        var d = String(fs.getTemporaryDirectory() || '');
        if (d) { return d.replace(/[\\\/]+$/, ''); }
      }
    } catch (e) { }
    return 'C:\\Windows\\Temp';
  }

  function dragStatusPath() { return dragTempDir() + '\\aowu-counter-drag.status'; }
  function dragCtrlPath() { return dragTempDir() + '\\aowu-counter-drag.ctrl'; }

  function dragEncodingCandidates() {
    var list = [];
    try {
      var cep = root.cep;
      if (cep && cep.encoding) {
        if (cep.encoding.utf8 !== undefined) { list[list.length] = cep.encoding.utf8; }
        if (cep.encoding.UTF8 !== undefined) { list[list.length] = cep.encoding.UTF8; }
      }
    } catch (e) { /* ignore */ }
    list[list.length] = 'utf8';
    list[list.length] = 'UTF8';
    return list;
  }

  function dragReadText(path) {
    var fs = getCepFs();
    if (!fs || typeof fs.readFile !== 'function') { return null; }
    var candidates = [null].concat(dragEncodingCandidates());
    var i;
    for (i = 0; i < candidates.length; i++) {
      try {
        var r = (candidates[i] === null) ? fs.readFile(path) : fs.readFile(path, candidates[i]);
        if (r && r.err === 0) { return String(r.data || ''); }
      } catch (e) { /* try next */ }
    }
    return null;
  }

  function dragWriteText(path, text) {
    var fs = getCepFs();
    if (!fs || typeof fs.writeFile !== 'function') { return false; }
    var candidates = [null].concat(dragEncodingCandidates());
    var i;
    var data = String(text);
    for (i = 0; i < candidates.length; i++) {
      try {
        var r = (candidates[i] === null) ? fs.writeFile(path, data) : fs.writeFile(path, data, candidates[i]);
        var ok = (!r) || r.err === 0 || r.err === undefined || r.err === null;
        if (ok) { return true; }
      } catch (e) { /* try next */ }
    }
    return false;
  }

  function dragDeleteFile(path) {
    try {
      var fs = getCepFs();
      if (fs && typeof fs.deleteFile === 'function') { fs.deleteFile(path); }
    } catch (e) { }
  }

  function parseDragStatus(text) {
    if (!text) { return null; }
    var o = {};
    var lines = String(text).replace(/\r/g, '').split('\n');
    var i;
    for (i = 0; i < lines.length; i++) {
      var m = /^([a-z]+)=(.*)$/.exec(lines[i]);
      if (m) { o[m[1]] = m[2]; }
    }
    if (o.found !== '1') { return null; }
    var x = parseFloat(o.x);
    var y = parseFloat(o.y);
    var w = parseFloat(o.w);
    var h = parseFloat(o.h);
    if (!isFinite(x) || !isFinite(y)) { return null; }
    return { x: x, y: y, w: isFinite(w) ? w : 0, h: isFinite(h) ? h : 0, ts: parseFloat(o.ts || '0') };
  }

  function ensureDragHelper() {
    if (!isCEP()) { return; }
    if (dragState.helperAt && (nowMs() - dragState.helperAt) < 1200) { return; }
    dragState.helperAt = nowMs();
    evalScript('AowuCounter.startWindowDragHelper()').catch(function () { });
  }

  /* 预热：最小化后先启动 helper 并告诉它面板尺寸，首次拖拽无启动延迟。 */
  function warmPanelDrag() {
    if (!isCEP() || !getCepFs()) { return false; }
    var wantW = 0;
    var wantH = 0;
    try { wantW = Math.round(Number(root.innerWidth) || 0); } catch (eW) { wantW = 0; }
    try { wantH = Math.round(Number(root.innerHeight) || 0); } catch (eH) { wantH = 0; }
    if (wantW > 0 && wantH > 0) {
      dragWriteText(dragCtrlPath(), 'want:' + wantW + ',' + wantH + '\n');
    }
    ensureDragHelper();
    return true;
  }


  function beginPanelDrag(screenX, screenY) {
    return new Promise(function (resolve) {
      if (!isCEP() || !getCepFs()) {
        resolve({ ok: false, error: 'not_cep' });
        return;
      }
      dragDeleteFile(dragCtrlPath());
      dragDeleteFile(dragStatusPath());
      /* 把当前面板内容尺寸告诉助手，助手只匹配这个尺寸的 PSViewC 子窗口，
         避免在多面板环境里移动错窗口（如右侧工具栏 dock）。 */
      var wantW = 0;
      var wantH = 0;
      try { wantW = Math.round(Number(root.innerWidth) || 0); } catch (eW) { wantW = 0; }
      try { wantH = Math.round(Number(root.innerHeight) || 0); } catch (eH) { wantH = 0; }
      if (wantW > 0 && wantH > 0) {
        dragWriteText(dragCtrlPath(), 'want:' + wantW + ',' + wantH + '\n');
      }
      dragState.active = false;
      if (!dragState.helperAt) { ensureDragHelper(); }
      var started = nowMs();
      (function pollStatus() {
        if ((nowMs() - started) > 2500) {
          resolve({ ok: false, error: 'helper_timeout' });
          return;
        }
        var rect = parseDragStatus(dragReadText(dragStatusPath()));
        if (rect) {
          dragState.rect = rect;
          dragState.startX = Number(screenX) || 0;
          dragState.startY = Number(screenY) || 0;
          dragState.active = true;
          resolve({ ok: true, rect: rect });
          return;
        }
        setTimeout(pollStatus, 120);
      })();
    });
  }

  function updatePanelDrag(screenX, screenY) {
    if (!dragState.active || !dragState.rect) { return false; }
    var nx = Math.round(dragState.rect.x + (Number(screenX) || 0) - dragState.startX);
    var ny = Math.round(dragState.rect.y + (Number(screenY) || 0) - dragState.startY);
    return dragWriteText(dragCtrlPath(), 'move:' + nx + ',' + ny + '\n');
  }

  function endPanelDrag() {
    dragState.active = false;
    return true;
  }

  /* 展开/卸载时调用：让助手进程退出，避免后台残留。 */
  function stopPanelDragHelper() {
    dragState.active = false;
    dragState.helperAt = 0;
    dragDeleteFile(dragCtrlPath());
    if (isCEP()) {
      dragWriteText(dragCtrlPath(), 'stop\n');
    }
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */

  var API = {
    VERSION: VERSION,
    isCEP: isCEP(),
    isMock: isMock,

    init: function () {
      if (isMock()) {
        ensureMock();
        return Promise.resolve({ ok: true, mock: true });
      }
      var extPath = '';
      try {
        var c = getCS();
        if (c && typeof c.getSystemPath === 'function') {
          extPath = c.getSystemPath('extension') || '';
        }
      } catch (e) {
        extPath = '';
      }
      // 让 PS 端 host.jsx 知道扩展根目录，以便 $.evalFile 加载 jsx/core.jsx
      return evalScript('AowuCounter.init(' + JSON.stringify(String(extPath)) + ')').then(function (raw) {
        var data;
        try { data = JSON.parse(raw); } catch (e2) { return { ok: false, error: 'bad_json' }; }
        /* host 返回的 Folder.temp 与 window-drag.ps1 的 $env:TEMP 是同一目录；
           CEP 的 cep.fs.getTemporaryDirectory() 在部分版本为空/不同，故以 host 为准。 */
        if (data && data.tempDir) { dragTempDirOverride = String(data.tempDir); }
        return data;
      }).catch(function (err) {
        return { ok: false, error: (err && err.message) ? err.message : 'eval_failed' };
      });
    },

    getState: function () {
      return callHost('AowuCounter.getState()');
    },

    /* v1.2.0：暂停 / 继续计数 */
    setPaused: function (paused) {
      return callHost('AowuCounter.setPaused(' + (paused ? 'true' : 'false') + ')');
    },

    /* v1.2.0：启用/禁用全局暂停快捷键（key 为单键 A-Z / 0-9 / F1-F12） */
    configureHotkey: function (enabled, key) {
      return callHost('AowuCounter.configureHotkey(' + (enabled ? 'true' : 'false') + ',' + JSON.stringify(String(key || 'P')) + ')');
    },

    clearCurrent: function () {
      return callHost('AowuCounter.clearCurrent()');
    },

    deleteCounter: function (id) {
      return callHost('AowuCounter.deleteCounter(' + JSON.stringify(String(id)) + ')');
    },

    /* v1.3.0：用户主动全部删除记录（不影响独立排行榜） */
    deleteAllCounters: function () {
      return callHost('AowuCounter.deleteAllCounters()');
    },

    /* v1.4.0：排行榜独立删除 */
    deleteLeaderboardCounter: function (id) {
      return callHost('AowuCounter.deleteLeaderboardCounter(' + JSON.stringify(String(id)) + ')');
    },
    deleteAllLeaderboard: function () {
      return callHost('AowuCounter.deleteAllLeaderboard()');
    },

    renameCounter: function (id, newName) {
      return callHost('AowuCounter.renameCounter(' + JSON.stringify(String(id)) + ',' + JSON.stringify(String(newName)) + ')');
    },

    getVersion: function () {
      return callHost('AowuCounter.getVersion()');
    },

    /* v1.1.1：最小化横条拖拽（无 CEP 能力时返回 ok:false，不抛错） */
    warmPanelDrag: function () {
      return warmPanelDrag();
    },
    beginPanelDrag: function (screenX, screenY) {
      return beginPanelDrag(screenX, screenY);
    },
    updatePanelDrag: function (screenX, screenY) {
      return updatePanelDrag(screenX, screenY);
    },
    endPanelDrag: function () {
      return endPanelDrag();
    },
    stopPanelDragHelper: function () {
      return stopPanelDragHelper();
    },


    onMockChange: function (cb) {
      if (typeof cb === 'function') { mockListeners.push(cb); }
    },

    /* 预览模式专用：模拟画一笔 +1（暂停时冻结，与真机 host 行为一致） */
    mockAddStroke: function () {
      if (!isMock() || mockPaused) { return; }
      ensureMock();
      var c = mockActiveId ? mockFindById(mockActiveId) : mockFindByName(mockDocName);
      if (c) {
        c.count = clampCount(c.count + 1);
        mockSyncLeaderboard(c.name, c.count, c.createdAt);
      }
      fire();
    }
  };

  root.AowuCounterBridge = API;
})(window);
