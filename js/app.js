/*!
 * 嗷呜计数 (Aowu Counter) v1.1.3 — 面板 UI / 交互
 *
 * 经典脚本（非 ES module）。依赖顺序（index.html）：
 *   js/csinterface.js → js/bridge.js → js/app.js
 *
 * 职责：
 *   - 150ms 轮询 bridge.getState()：上一请求未返回则跳过；state 签名未变不重绘；
 *     面板隐藏/后台时降到约 0.9s 一次（不停止轮询，保证继续计数）
 *   - 渲染：顶栏（连接圆点 / 关于 / ? / 最小化）/ 当前画布卡片 / 上限警告条 /
 *     计数记录 / 排行榜 / 最小化横条 / 空状态
 *   - 交互：改名（Enter 保存 / Esc 取消 / 失焦保存）、行内删除二次确认、
 *     清空当前二次确认（3 秒还原）、排行榜删除、帮助/关于弹窗、最小化/展开、toast
 *   - v1.1.1：移除主面板底部提示；最小化时用 CSInterface.setWindowTitle(' ') 隐藏 PS
 *     面板标题、展开恢复「嗷呜计数」；最小化横条爪印可拖拽移动窗口
 *     （bridge.beginPanelDrag/updatePanelDrag/endPanelDrag，缺失时静默降级；
 *     移动 >3px 不会误触发展开）
 *   - v1.1.2：最小化横条再压缩到约 230×28；用 localStorage 记住最小化状态与上次
 *     展开尺寸（aowuCounter.minimized / aowuCounter.prevW / aowuCounter.prevH），
 *     最小化时关闭 PS 再打开面板会直接以最小化横条恢复，展开恢复上次尺寸；
 *     不可用时静默降级（旧行为）
 *   - v1.1.3：顶栏「?」前新增「关于」入口 + 关于弹窗（作者「寅虎嗷呜呜」B 站
 *     链接为主题青色可点击），点击用外部浏览器打开 B 站主页；关于/帮助互斥
 *   - 最小化：body.minimized + CSInterface.resizeContent(230, 28)；展开恢复保存尺寸
 *   - 连接失败：只把圆点变红并静默重试，不弹 toast
 *   - 帮助 / 关于 / 排行榜 / 最小化可在 mock 预览模式用 URL 参数直接展示：
 *       index.html?mock=1&view=leaderboard | help | about | mini
 *
 * 安全：所有用户可见文本一律用 textContent 写入；innerHTML 仅用于本文件内的
 *       常量 SVG 图标（绝不拼接用户数据）。
 *
 * 调试（仅控制台）：window.AowuCounterApp.getState() / pollNow() / mockAddStroke() /
 *   switchTab('leaderboard') / openHelp() / openAbout() / minimize() / expand() /
 *   isDragging() / _lastExternalUrl()
 */
(function (root) {
  'use strict';

  var bridge = root.AowuCounterBridge;

  var VERSION_FALLBACK = '1.1.3';
  var ABOUT_BILI_URL = 'https://space.bilibili.com/438278539?spm_id_from=333.1007.0.0';
  var POLL_INTERVAL = 150;          // 契约：150ms 轮询
  var HIDDEN_POLL_MS = 900;         // 面板隐藏时的节流间隔
  var CONFIRM_MS = 3000;            // 二次确认 3 秒后还原
  var TOAST_MS = 2000;              // toast 显示 2 秒
  var MAX_COUNTERS_FALLBACK = 10;
  var DEFAULT_W = 300;              // 展开时异常回退尺寸
  var DEFAULT_H = 480;
  var MINI_WIDTH = 230;             // v1.1.2 最小化横条目标尺寸
  var MINI_HEIGHT = 28;
  var AUTO_EXPAND_MAX_HEIGHT = 120; // 重开面板若小于此高度则自动恢复展开
  var DRAG_THRESHOLD = 3;           // 拖拽判定阈值（px）
  var DRAG_THROTTLE_MS = 30;        // 拖拽事件节流

  /* v1.1.2：用 localStorage 记住最小化状态与上次展开尺寸（不可用时静默降级） */
  var LS_KEY_MINIMIZED = 'aowuCounter.minimized';
  var LS_KEY_PREV_W = 'aowuCounter.prevW';
  var LS_KEY_PREV_H = 'aowuCounter.prevH';

  /* 常量图标（不含任何用户数据） */
  var ICON_EDIT =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 20l.9-3.9L16.4 4.6a2.2 2.2 0 0 1 3.1 3.1L8 19.2z"></path>' +
    '<path d="M14.6 6.5l3.1 3.1"></path></svg>';

  var ICON_TRASH =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.5 7h15"></path><path d="M9.5 7V5.2h5V7"></path>' +
    '<path d="M6.5 7l.9 12.2h9.2L17.5 7"></path>' +
    '<path d="M10.2 10.6v5.2M13.8 10.6v5.2"></path></svg>';

  var HOST_ERROR_TEXT = {
    no_active_doc: '没有打开的画布',
    no_active_counter: '当前画布还没有计数记录',
    missing: '记录已不存在',
    duplicate: '名字已存在',
    invalid: '名字不合法',
    core_load_failed: '插件初始化失败（找不到 core.jsx），请重新安装或重启 Photoshop',
    json_failed: '数据序列化失败',
    state_failed: '读取状态失败',
    clear_failed: '清空失败',
    delete_failed: '删除失败',
    rename_failed: '改名失败',
    data_load: '数据文件读取异常',
    data_read_failed: '数据文件读取失败'
  };

  /* ------------------------------------------------------------------ */
  /* DOM / 运行状态                                                     */
  /* ------------------------------------------------------------------ */

  var els = {};
  var lastState = null;
  var lastSignature = '';
  var pollTimer = null;
  var pollInFlight = false;
  var lastHiddenPollAt = 0;         // 面板隐藏时节流用
  var connState = 'idle';           // 'idle' | 'ok' | 'err'
  var lastPollError = '';
  var toastTimers = [];

  var editing = null;               // { id:string, original:string, committing:boolean }
  var pendingDeleteId = null;       // string | null（行内删除确认，记录/排行榜共用）
  var deleteTimer = null;
  var clearConfirm = false;         // 清空按钮二次确认
  var clearTimer = null;
  var clearBusy = false;            // 清空请求进行中
  var started = false;

  var activeTab = 'records';        // 'records' | 'leaderboard'
  var minimized = false;
  var prevW = 0;                    // 最小化前的面板宽高
  var prevH = 0;
  var helpOpen = false;
  var aboutOpen = false;            // v1.1.3 关于弹窗
  var lastExternalUrl = null;       // v1.1.3 最近一次请求外部浏览器打开的 URL（自测钩子）
  var pendingPreviewView = '';      // ?mock=1&view=leaderboard|help|about|mini
  var previewViewApplied = false;

  /* v1.1.1：最小化横条拖拽 + 面板标题 + 尺寸调用记录（供自测断言） */
  var dragActive = false;
  var dragMoved = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var dragLastX = 0;
  var dragLastY = 0;
  var dragLastCallAt = 0;
  var suppressMiniClick = false;
  var lastResizeCall = null;
  var lastWindowTitle = null;

  /* v1.1.2：本次加载是否从 localStorage 恢复了最小化状态（供自测/排障） */
  var restoredMinimized = false;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                           */
  /* ------------------------------------------------------------------ */

  function byId(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  function errText(err) {
    if (!err) { return '未知错误'; }
    if (typeof err === 'string') { return err; }
    if (err.message) { return String(err.message); }
    return String(err);
  }

  function hostErrorText(code) {
    if (!code) { return '未知错误'; }
    code = String(code);
    return HOST_ERROR_TEXT[code] || code;
  }

  function formatNumber(n) {
    var num = Number(n);
    if (!isFinite(num) || num < 0) { num = 0; }
    num = Math.floor(num);
    var s = String(num);
    var out = '';
    var c = 0;
    var i;
    for (i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      c += 1;
      if (c % 3 === 0 && i > 0) { out = ',' + out; }
    }
    return out;
  }

  function findCounter(state, id) {
    if (!state || !state.counters || id === null || id === undefined) { return null; }
    var counters = state.counters;
    var i;
    for (i = 0; i < counters.length; i++) {
      if (counters[i] && counters[i].id === id) { return counters[i]; }
    }
    return null;
  }

  function closestEl(node, selector) {
    if (!node) { return null; }
    if (node.closest) { return node.closest(selector); }
    while (node && node !== root.document) {
      if (node.msMatchesSelector && node.msMatchesSelector(selector)) { return node; }
      node = node.parentNode;
    }
    return null;
  }

  function addClass(node, cls) {
    if (!node) { return; }
    try {
      if (node.classList) { node.classList.add(cls); return; }
    } catch (e) { /* ignore */ }
    var cur = ' ' + (node.className || '') + ' ';
    if (cur.indexOf(' ' + cls + ' ') < 0) { node.className = (node.className ? node.className + ' ' : '') + cls; }
  }

  function removeClass(node, cls) {
    if (!node) { return; }
    try {
      if (node.classList) { node.classList.remove(cls); return; }
    } catch (e) { /* ignore */ }
    var re = new RegExp('(^|\\s)' + cls + '(?=\\s|$)', 'g');
    node.className = String(node.className || '').replace(re, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function findRecordsRow(id) {
    if (!els.recordList) { return null; }
    var rows = els.recordList.querySelectorAll('.record-row');
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].getAttribute('data-counter-id') === String(id)) { return rows[i]; }
    }
    return null;
  }

  function isMockMode() {
    return !!(bridge && bridge.isMock && bridge.isMock());
  }

  function parseQuery() {
    var out = {};
    try {
      var s = (root.location && root.location.search) ? String(root.location.search) : '';
      s = s.replace(/^\?/, '');
      if (!s) { return out; }
      var parts = s.split('&');
      var i;
      for (i = 0; i < parts.length; i++) {
        if (!parts[i]) { continue; }
        var kv = parts[i].split('=');
        var k = decodeURIComponent(kv[0] || '');
        var v = decodeURIComponent(kv.slice(1).join('=') || '');
        if (k) { out[k] = v; }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* v1.1.2：最小化状态持久化（localStorage；不可用时静默降级）           */
  /* ------------------------------------------------------------------ */

  function canPersistPanelState() {
    /* 浏览器 mock 预览（?mock=1&view=...）不写 localStorage，
       避免预览/截图污染下次正常预览；真实 CEP 面板正常持久化。 */
    try {
      if (isMockMode() && pendingPreviewView) { return false; }
    } catch (e) { /* ignore */ }
    return true;
  }

  function lsGet(key) {
    try {
      if (!root.localStorage) { return null; }
      return root.localStorage.getItem(key);
    } catch (e) { return null; }
  }

  function lsSet(key, value) {
    try {
      if (!root.localStorage) { return false; }
      root.localStorage.setItem(key, String(value));
      return true;
    } catch (e) { return false; }
  }

  function isValidPanelSize(w, h) {
    return isFinite(w) && isFinite(h) && w >= 180 && h >= 120 && w <= 4000 && h <= 4000;
  }

  function readSavedPanelState() {
    var min = lsGet(LS_KEY_MINIMIZED) === '1';
    var w = parseInt(lsGet(LS_KEY_PREV_W), 10);
    var h = parseInt(lsGet(LS_KEY_PREV_H), 10);
    if (!isValidPanelSize(w, h)) { w = 0; h = 0; }
    return { minimized: min, prevW: w, prevH: h };
  }

  function writeSavedPanelState(min, w, h) {
    if (!canPersistPanelState()) { return false; }
    lsSet(LS_KEY_MINIMIZED, min ? '1' : '0');
    if (isValidPanelSize(w, h)) {
      lsSet(LS_KEY_PREV_W, Math.round(w));
      lsSet(LS_KEY_PREV_H, Math.round(h));
    }
    return true;
  }

  /* 进入最小化视觉/窗口状态（minimize 与「重开恢复最小化」共用） */
  function enterMinimizedVisualState() {
    minimized = true;
    addClass(root.document.body, 'minimized');
    renderMini(lastState);
    setPanelTitle(' ');
    resizePanel(MINI_WIDTH, MINI_HEIGHT);
    /* 预热拖拽 helper：等 PS 应用新尺寸后就开始查找面板窗口，首次拖拽不用等启动 */
    setTimeout(function () { callBridgeDrag('warmPanelDrag'); }, 180);
  }

  /* ------------------------------------------------------------------ */
  /* 初始化                                                             */
  /* ------------------------------------------------------------------ */

  function init() {
    cacheElements();
    bindEvents();

    if (!bridge) {
      setConnection('err');
      if (els.conn) { els.conn.title = 'bridge.js 未加载，请确认插件文件完整后重新安装'; }
      return;
    }

    var q = parseQuery();
    pendingPreviewView = String(q.view || '').toLowerCase();

    setVersionBadge(null);
    renderChrome(null);
    renderCurrent(null);
    renderWarning(null);
    renderLists(null, true);
    renderMini(null);
    setConnection('idle');

    /* 容错：若 Photoshop 记住的上次面板高度仍是横条高度（例如最小化时关掉面板），
       重新打开时恢复默认展开尺寸 300×480；mock 预览 view=mini 除外。
       Photoshop 会在页面 load 之后才应用被记住的窗口尺寸，所以延迟复查几次。 */
    function autoExpandIfTiny() {
      if (minimized) { return; }
      var h = 0;
      try { h = Number(root.innerHeight) || 0; } catch (eH) { h = 0; }
      if (isMockMode() && pendingPreviewView === 'mini') { return; }
      if (h > 0 && h < AUTO_EXPAND_MAX_HEIGHT) {
        resizePanel(DEFAULT_W, DEFAULT_H);
        setPanelTitle('嗷呜计数');
      }
    }

    /* v1.1.2：记住最小化状态——上次关闭面板时是横条则本次直接恢复最小化，
       并跳过 autoExpandIfTiny（避免被自动展开覆盖）。
       mock 预览带 view 参数时保持预览行为，不受历史状态影响。 */
    var savedPanelState = readSavedPanelState();
    var skipRestoreForPreview = isMockMode() && !!pendingPreviewView;
    if (savedPanelState.minimized && !skipRestoreForPreview) {
      prevW = savedPanelState.prevW || DEFAULT_W;
      prevH = savedPanelState.prevH || DEFAULT_H;
      restoredMinimized = true;
      enterMinimizedVisualState();
      /* PS 可能稍后才应用「上次记住的展开尺寸」，短暂复查并重新压回横条 */
      var miniGuardTries = 0;
      var miniGuardTimer = setInterval(function () {
        miniGuardTries++;
        if (!minimized || miniGuardTries > 15) {
          clearInterval(miniGuardTimer);
          return;
        }
        var mh = 0;
        try { mh = Number(root.innerHeight) || 0; } catch (eM) { mh = 0; }
        if (mh > MINI_HEIGHT + 40) {
          resizePanel(MINI_WIDTH, MINI_HEIGHT);
          setPanelTitle(' ');
        }
      }, 1000);
    } else {
      autoExpandIfTiny();
      /* PS 应用「上次记住的面板尺寸」的时机可能晚于页面 load；持续复查 2 分钟。 */
      var autoExpandTries = 0;
      var autoExpandTimer = setInterval(function () {
        autoExpandTries++;
        autoExpandIfTiny();
        var hh = 0;
        try { hh = Number(root.innerHeight) || 0; } catch (eH2) { hh = 0; }
        if (hh >= AUTO_EXPAND_MAX_HEIGHT || autoExpandTries >= 120) {
          clearInterval(autoExpandTimer);
        }
      }, 1000);
    }

    var boot = null;
    try { boot = bridge.init(); } catch (e) { boot = null; }
    if (boot && typeof boot.then === 'function') {
      boot.then(function (info) {
        /* host.jsx 初始化失败（如找不到 core.jsx）时提示；连接类失败保持静默 */
        if (info && info.ok === false) {
          toast('插件初始化失败：' + hostErrorText(info.error), 'error');
        }
        startPolling();
      }, function () { startPolling(); });
    } else {
      startPolling();
    }
  }

  function cacheElements() {
    els = {
      versionBadge: byId('versionBadge'),
      conn: byId('connection-status'),
      connDot: byId('connDot'),
      currentCard: byId('currentCard'),
      currentName: byId('active-doc-name'),
      currentCount: byId('active-count'),
      currentUnit: byId('currentUnit'),
      currentDot: byId('currentDot'),
      currentStatusText: byId('currentStatusText'),
      btnClear: byId('btnClear'),
      warnBar: byId('warning-bar'),
      warnText: byId('warnText'),
      recordsCount: byId('recordsCount'),
      recordList: byId('counter-list'),
      emptyState: byId('empty-state'),
      toastLayer: byId('toast'),

      tabRecords: byId('tabRecords'),
      tabLeaderboard: byId('tabLeaderboard'),
      tabPanelRecords: byId('tabPanelRecords'),
      tabPanelLeaderboard: byId('tabPanelLeaderboard'),
      leaderboardList: byId('leaderboardList'),
      leaderboardEmpty: byId('leaderboard-empty'),

      btnHelp: byId('btnHelp'),
      btnAbout: byId('btnAbout'),
      btnMinimize: byId('btnMinimize'),
      btnExpand: byId('btnExpand'),
      minimizedBar: byId('minimizedBar'),
      miniDragHandle: byId('miniDragHandle'),
      miniDocName: byId('miniDocName'),
      miniCount: byId('miniCount'),
      miniStatusDot: byId('miniStatusDot'),
      helpModal: byId('helpModal'),
      helpClose: byId('helpClose'),
      aboutModal: byId('aboutModal'),
      aboutClose: byId('aboutClose'),
      aboutBiliLink: byId('aboutBiliLink')
    };
  }

  function bindEvents() {
    if (els.btnClear) { els.btnClear.addEventListener('click', onClearClick); }
    if (els.btnHelp) { els.btnHelp.addEventListener('click', openHelp); }
    if (els.btnAbout) { els.btnAbout.addEventListener('click', openAbout); }
    if (els.btnMinimize) { els.btnMinimize.addEventListener('click', minimizePanel); }
    if (els.btnExpand) { els.btnExpand.addEventListener('click', expandPanel); }

    if (els.tabRecords) {
      els.tabRecords.addEventListener('click', function () { setTab('records'); });
    }
    if (els.tabLeaderboard) {
      els.tabLeaderboard.addEventListener('click', function () { setTab('leaderboard'); });
    }

    if (els.minimizedBar) {
      els.minimizedBar.addEventListener('click', function (e) {
        if (closestEl(e.target, 'button')) { return; }
        /* 拖拽结束后的 click 不触发展开（移动 >3px 时） */
        if (suppressMiniClick) {
          suppressMiniClick = false;
          return;
        }
        expandPanel();
      });
      els.minimizedBar.addEventListener('keydown', function (e) {
        var key = e.key || '';
        if (e.target !== els.minimizedBar) { return; }
        if (key === 'Enter' || key === ' ' || e.keyCode === 13 || e.keyCode === 32) {
          e.preventDefault();
          expandPanel();
        }
      });
    }

    /* v1.1.1：按住爪印拖动最小化横条（bridge 拖拽 API 缺失时静默降级） */
    if (els.miniDragHandle) {
      els.miniDragHandle.addEventListener('mousedown', onMiniDragStart);
    }
    root.document.addEventListener('mousemove', onMiniDragMove);
    root.document.addEventListener('mouseup', onMiniDragEnd);
    root.document.addEventListener('mouseleave', onMiniDragEnd);
    root.addEventListener('blur', onMiniDragEnd);

    if (els.helpClose) {
      els.helpClose.addEventListener('click', closeHelp);
    }
    if (els.helpModal) {
      els.helpModal.addEventListener('click', function (e) {
        if (e.target === els.helpModal) { closeHelp(); }
      });
    }

    /* v1.1.3：关于弹窗 + B 站作者链接 */
    if (els.aboutClose) {
      els.aboutClose.addEventListener('click', closeAbout);
    }
    if (els.aboutModal) {
      els.aboutModal.addEventListener('click', function (e) {
        if (e.target === els.aboutModal) { closeAbout(); }
      });
    }
    if (els.aboutBiliLink) {
      els.aboutBiliLink.addEventListener('click', function (e) {
        try { e.preventDefault(); } catch (eP) { /* ignore */ }
        var url = '';
        try { url = els.aboutBiliLink.getAttribute('href') || ABOUT_BILI_URL; } catch (eH) { url = ABOUT_BILI_URL; }
        openExternalUrl(url);
      });
    }

    bindRecordsEvents();
    bindLeaderboardEvents();

    root.document.addEventListener('keydown', function (e) {
      var key = e.key || '';
      if (key === 'Escape' || e.keyCode === 27) {
        if (aboutOpen) { closeAbout(); return; }
        if (helpOpen) { closeHelp(); return; }
        if (editing) { cancelEdit(); }
        if (pendingDeleteId) { cancelDelete(); }
        if (clearConfirm) { resetClearConfirm(); }
      }
    });

    root.document.addEventListener('visibilitychange', function () {
      try {
        // CEP 面板被切到后台/其他标签时 document.hidden = true。
        // 计数必须继续：隐藏时不停止轮询（Chromium 会节流定时器，pollOnce 内再降到约 0.9s）。
        if (!root.document.hidden && !pollTimer) { startPolling(); }
      } catch (e) { /* ignore */ }
    });

    root.addEventListener('beforeunload', function () {
      stopPolling();
      stopDragHelper();
    });
  }

  /* ------------------------------------------------------------------ */
  /* 轮询 + 连接状态（失败只红点，不弹 toast）                          */
  /* ------------------------------------------------------------------ */

  function startPolling() {
    if (started || pollTimer !== null || !bridge) { return; }
    started = true;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    started = false;
  }

  function pollOnce() {
    if (pollInFlight || !bridge) { return; }
    // 面板在后台/隐藏时 Chromium 会节流定时器；主动降到约 0.9s 一次，
    // 减少 Photoshop 画画期间排队的 evalScript，同时仍能持续计数。
    var now = (new Date()).getTime();
    try {
      if (root.document.hidden && (now - lastHiddenPollAt) < HIDDEN_POLL_MS) { return; }
    } catch (eHidden) { /* ignore */ }
    lastHiddenPollAt = now;
    pollInFlight = true;

    var request;
    try {
      request = bridge.getState();
    } catch (e) {
      pollInFlight = false;
      onPollFailure(errText(e), false);
      return;
    }
    Promise.resolve(request).then(function (state) {
      pollInFlight = false;
      if (!state || state.ok === false) {
        onPollFailure((state && state.error) ? String(state.error) : 'state_failed', true);
        return;
      }
      lastPollError = '';
      setConnection('ok');
      applyState(state, false);
    }, function (err) {
      pollInFlight = false;
      onPollFailure(errText(err), false);
    });
  }

  function onPollFailure(message, hostError) {
    /* 契约 v1.1.0：连接/读取失败只把圆点变红并静默重试，绝不弹红色 toast。
       hostError 参数保留用于未来区分，不参与 UI。 */
    setConnection('err');
    lastPollError = message;
  }

  function setConnection(mode) {
    if (mode === connState) { return; }
    connState = mode;
    if (els.connDot) { els.connDot.className = 'conn-dot ' + mode; }
    if (els.conn) {
      if (mode === 'ok') {
        els.conn.title = isMockMode() ? '已连接（浏览器预览模式）' : '已连接 Photoshop';
      } else if (mode === 'err') {
        els.conn.title = '未连接 Photoshop，正在静默重试…';
      } else {
        els.conn.title = '正在连接 Photoshop…';
      }
    }
    renderMini(lastState);
  }

  function setVersionBadge(state) {
    if (!els.versionBadge) { return; }
    els.versionBadge.textContent = 'v' + ((state && state.version) ||
      (bridge && bridge.VERSION) || VERSION_FALLBACK);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：签名 / 总调度                                                */
  /* ------------------------------------------------------------------ */

  function stateSignature(state) {
    var parts = [];
    parts.push(state.version || '');
    parts.push(state.warning || '');
    parts.push(state.dataPath || '');
    parts.push(state.activeCounterId === null || state.activeCounterId === undefined ? '' : String(state.activeCounterId));
    if (state.activeDoc) {
      parts.push('doc\u0001' + state.activeDoc.id + '\u0001' + state.activeDoc.name + '\u0001' + (state.activeDoc.saved ? '1' : '0'));
    } else {
      parts.push('doc\u0001none');
    }
    var counters = state.counters || [];
    var i;
    for (i = 0; i < counters.length; i++) {
      parts.push(counters[i].id + '\u0001' + counters[i].name + '\u0001' + counters[i].count);
    }
    parts.push('max\u0001' + (state.maxCounters || '') + '\u0001' + (state.maxStrokes || ''));
    return parts.join('\u0002');
  }

  function applyState(state, force) {
    if (!state || state.ok === false) { return; }
    lastState = state;
    var sig = stateSignature(state);
    if (!force && sig === lastSignature) {
      maybeApplyPreviewView();
      return;
    }
    lastSignature = sig;
    renderChrome(state);
    renderCurrent(state);
    renderWarning(state);
    renderLists(state);
    renderMini(state);
    maybeApplyPreviewView();
  }

  function refreshFromLastState() {
    lastSignature = '';
    if (lastState) {
      applyState(lastState, true);
    } else {
      renderChrome(null);
      renderCurrent(null);
      renderWarning(null);
      renderLists(null, true);
      renderMini(null);
    }
  }

  function renderChrome(state) {
    setVersionBadge(state);
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：当前画布卡片                                                 */
  /* ------------------------------------------------------------------ */

  function renderCurrent(state) {
    if (!els.currentName) { return; }

    var doc = (state && state.activeDoc) ? state.activeDoc : null;
    var counter = (state && state.activeCounterId) ? findCounter(state, state.activeCounterId) : null;
    var warning = (state && state.warning) || '';
    var name;
    var countText;
    var statusText;
    var dotClass;
    var unitHidden;
    var clearEnabled;

    if (!doc) {
      name = '没有打开的画布';
      countText = '—';
      statusText = '没有打开的画布';
      dotClass = 'idle';
      unitHidden = true;
      clearEnabled = false;
    } else if (counter) {
      name = doc.name || counter.name || '未命名画布';
      countText = formatNumber(counter.count);
      statusText = '正在计数';
      dotClass = 'ok';
      unitHidden = false;
      clearEnabled = true;
    } else if (warning === 'limit') {
      name = doc.name || '当前画布';
      countText = '—';
      statusText = '已达 10 个画布上限';
      dotClass = 'warn';
      unitHidden = true;
      clearEnabled = false;
    } else {
      name = doc.name || '未命名画布';
      countText = '—';
      statusText = '未记录 · 用画笔在画布上画一笔';
      dotClass = 'idle';
      unitHidden = true;
      clearEnabled = false;
    }

    els.currentName.textContent = name;
    els.currentName.title = name;
    /* 超大数字（如 100,000,000,000）缩小字号，保证完整显示不截断 */
    els.currentCount.className = 'current-count' + (countText.length > 12 ? ' is-long' : '');
    els.currentCount.textContent = countText;
    els.currentUnit.hidden = unitHidden;
    els.currentStatusText.textContent = statusText;
    els.currentDot.className = 'status-dot ' + dotClass;
    if (els.currentCard) {
      els.currentCard.title = statusText + (counter ? ('（' + formatNumber(counter.count) + ' 笔）') : '');
    }
    if (els.btnClear) {
      els.btnClear.disabled = (!clearEnabled || clearBusy);
    }
    updateClearButton();
  }

  function updateClearButton() {
    if (!els.btnClear) { return; }
    els.btnClear.className = 'btn-clear' + (clearConfirm ? ' confirm' : '');
    els.btnClear.textContent = clearConfirm ? '确认清空?' : (clearBusy ? '清空中…' : '清空当前');
    els.btnClear.title = clearConfirm
      ? '再次点击确认清空当前画布笔数（3 秒内有效）'
      : '清空当前画布的笔数（需要二次确认）';
    if (clearBusy) { els.btnClear.disabled = true; }
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：最小化横条                                                   */
  /* ------------------------------------------------------------------ */

  function renderMini(state) {
    if (!els.miniDocName || !els.miniCount || !els.miniStatusDot) { return; }
    var doc = (state && state.activeDoc) ? state.activeDoc : null;
    var counter = (state && state.activeCounterId) ? findCounter(state, state.activeCounterId) : null;

    var name = doc ? (doc.name || '未命名画布') : '没有打开的画布';
    els.miniDocName.textContent = name;
    els.miniDocName.title = name;

    var countText = counter ? formatNumber(counter.count) : '—';
    els.miniCount.textContent = countText;
    els.miniCount.title = counter ? (countText + ' 笔') : '当前没有计数记录';

    /* 绿=正在记录（已连接 + 有画布 + 已关联计数）；红=未记录/未连接 */
    var recording = !!(connState === 'ok' && doc && counter);
    els.miniStatusDot.className = 'mini-dot ' + (recording ? 'ok' : 'err');
    els.miniStatusDot.title = recording ? '正在记录' : (connState === 'ok' ? '未记录' : '未连接');
    if (els.minimizedBar) {
      els.minimizedBar.title = '点击展开 · ' + name + (counter ? (' · 当前笔数 ' + countText) : '');
    }
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：警告条                                                       */
  /* ------------------------------------------------------------------ */

  function warningText(warning) {
    if (warning === 'limit') {
      return '已达 10 个画布上限，新画布不会创建记录。可删除旧记录后重新画一笔。';
    }
    if (warning === 'data_load') {
      return '数据文件读取异常，已从空记录开始；数据文件位置见底部提示。';
    }
    if (warning === 'data_read_failed') {
      return '数据文件暂时无法读取（可能被占用），请稍后重试或重启 Photoshop。';
    }
    return '提示：' + hostErrorText(warning);
  }

  function renderWarning(state) {
    if (!els.warnBar || !els.warnText) { return; }
    var warning = (state && state.warning) || '';
    if (!warning) {
      els.warnBar.hidden = true;
      els.warnText.textContent = '';
      return;
    }
    els.warnText.textContent = warningText(warning);
    els.warnBar.hidden = false;
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：计数记录 / 排行榜                                            */
  /* ------------------------------------------------------------------ */

  function renderLists(state) {
    renderRecordsList(state, false);
    renderLeaderboard(state);
  }

  function renderRecordsList(state, forceRebuild) {
    if (!els.recordList) { return; }

    var counters = (state && state.counters) ? state.counters : [];
    var maxCounters = (state && state.maxCounters) ? state.maxCounters : MAX_COUNTERS_FALLBACK;
    if (els.recordsCount) {
      els.recordsCount.textContent = counters.length + ' / ' + maxCounters;
    }
    var activeId = state ? state.activeCounterId : null;

    /* 轮询重绘时：编辑/删除确认期间不重建列表，避免输入框被 150ms 轮询打断；
       用户主动进入编辑/确认时传 forceRebuild=true，正常渲染输入框/确认行 */
    if (!forceRebuild && (editing || pendingDeleteId)) {
      syncRowCounts(state);
      return;
    }

    while (els.recordList.firstChild) {
      els.recordList.removeChild(els.recordList.firstChild);
    }

    if (counters.length === 0) {
      els.recordList.hidden = true;
      if (els.emptyState) { els.emptyState.hidden = false; }
      return;
    }

    els.recordList.hidden = false;
    if (els.emptyState) { els.emptyState.hidden = true; }

    var i;
    for (i = 0; i < counters.length; i++) {
      var counter = counters[i];
      var isCurrent = !!(activeId && counter.id === activeId);
      if (pendingDeleteId === counter.id) {
        els.recordList.appendChild(buildConfirmRow(counter, isCurrent));
      } else {
        els.recordList.appendChild(buildRow(counter, isCurrent));
      }
    }
  }

  /* 延迟重绘期间只更新笔数 / 名字，避免打断输入 */
  function syncRowCounts(state) {
    if (!els.recordList) { return; }
    var rows = els.recordList.querySelectorAll('.record-row');
    var i;
    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = row.getAttribute('data-counter-id');
      var counter = findCounter(state, id);
      if (!counter) { continue; }
      var countEl = row.querySelector('[data-role="row-count"]');
      if (countEl) {
        countEl.textContent = formatNumber(counter.count) + ' 笔';
        countEl.title = formatNumber(counter.count) + ' 笔';
      }
      if (!editing || editing.id !== id) {
        var nameEl = row.querySelector('[data-role="row-name"]');
        if (nameEl) {
          nameEl.textContent = counter.name;
          nameEl.title = counter.name;
        }
      }
    }
  }

  function buildRow(counter, isCurrent) {
    var row = document.createElement('div');
    row.className = 'record-row' + (isCurrent ? ' is-current' : '');
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-role', 'counter-row');
    row.setAttribute('data-counter-id', String(counter.id));

    var main = document.createElement('div');
    main.className = 'row-main';

    if (editing && editing.id === counter.id) {
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'row-input';
      input.setAttribute('data-role', 'row-input');
      input.setAttribute('aria-label', '修改计数记录名称');
      input.maxLength = 260;
      input.value = String(counter.name);
      main.appendChild(input);
    } else {
      var nameEl = document.createElement('span');
      nameEl.className = 'row-name';
      nameEl.setAttribute('data-role', 'row-name');
      nameEl.textContent = String(counter.name);
      nameEl.title = String(counter.name);
      main.appendChild(nameEl);
      if (isCurrent) {
        var tag = document.createElement('span');
        tag.className = 'tag-current';
        tag.textContent = '当前';
        main.appendChild(tag);
      }
    }

    var countEl = document.createElement('span');
    countEl.className = 'row-count';
    countEl.setAttribute('data-role', 'row-count');
    countEl.textContent = formatNumber(counter.count) + ' 笔';
    countEl.title = formatNumber(counter.count) + ' 笔';

    row.appendChild(main);
    row.appendChild(countEl);
    row.appendChild(makeRowButton('edit', 'edit-counter', ICON_EDIT, '改名', false));
    row.appendChild(makeRowButton('delete', 'delete-counter', ICON_TRASH, '删除', true));
    return row;
  }

  function buildConfirmRow(counter, isCurrent) {
    var row = document.createElement('div');
    row.className = 'record-row confirming' + (isCurrent ? ' is-current' : '');
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-role', 'counter-row');
    row.setAttribute('data-counter-id', String(counter.id));

    var main = document.createElement('div');
    main.className = 'row-main';
    var label = document.createElement('span');
    label.className = 'confirm-label';
    label.textContent = '删除?';
    label.title = '删除「' + String(counter.name) + '」？';
    main.appendChild(label);

    var countEl = document.createElement('span');
    countEl.className = 'row-count';
    countEl.setAttribute('data-role', 'row-count');
    countEl.textContent = formatNumber(counter.count) + ' 笔';
    countEl.title = formatNumber(counter.count) + ' 笔';

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'mini-btn confirm-yes';
    yes.setAttribute('data-action', 'confirm-delete');
    yes.setAttribute('data-role', 'confirm-delete');
    yes.textContent = '删除';
    yes.title = '确认删除「' + String(counter.name) + '」';

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'mini-btn confirm-no';
    no.setAttribute('data-action', 'cancel-delete');
    no.setAttribute('data-role', 'cancel-delete');
    no.textContent = '取消';
    no.title = '取消删除';

    row.appendChild(main);
    row.appendChild(countEl);
    row.appendChild(yes);
    row.appendChild(no);
    return row;
  }

  function renderLeaderboard(state) {
    if (!els.leaderboardList) { return; }
    var counters = (state && state.counters) ? state.counters.slice(0) : [];

    /* 按笔数从高到低；笔数相同按创建时间早的在前，再按名字 */
    counters.sort(function (a, b) {
      var ca = Number(a.count) || 0;
      var cb = Number(b.count) || 0;
      if (cb !== ca) { return cb - ca; }
      var ta = Number(a.createdAt) || 0;
      var tb = Number(b.createdAt) || 0;
      if (ta !== tb) { return ta - tb; }
      return String(a.name) < String(b.name) ? -1 : (String(a.name) > String(b.name) ? 1 : 0);
    });

    var activeId = state ? state.activeCounterId : null;

    while (els.leaderboardList.firstChild) {
      els.leaderboardList.removeChild(els.leaderboardList.firstChild);
    }

    if (counters.length === 0) {
      els.leaderboardList.hidden = true;
      if (els.leaderboardEmpty) { els.leaderboardEmpty.hidden = false; }
      return;
    }

    els.leaderboardList.hidden = false;
    if (els.leaderboardEmpty) { els.leaderboardEmpty.hidden = true; }

    var i;
    for (i = 0; i < counters.length; i++) {
      var counter = counters[i];
      var isCurrent = !!(activeId && counter.id === activeId);
      if (pendingDeleteId === counter.id) {
        els.leaderboardList.appendChild(buildRankConfirmRow(counter, i + 1, isCurrent));
      } else {
        els.leaderboardList.appendChild(buildRankRow(counter, i + 1, isCurrent));
      }
    }
  }

  function buildRankRow(counter, rank, isCurrent) {
    var row = document.createElement('div');
    row.className = 'rank-row' + (rank <= 3 ? (' top-' + rank) : '') + (isCurrent ? ' is-current' : '');
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-role', 'rank-row');
    row.setAttribute('data-counter-id', String(counter.id));

    var rankEl = document.createElement('span');
    rankEl.className = 'rank-no';
    rankEl.textContent = String(rank);

    var nameEl = document.createElement('span');
    nameEl.className = 'rank-name';
    nameEl.setAttribute('data-role', 'rank-name');
    nameEl.textContent = String(counter.name);
    nameEl.title = String(counter.name);

    var countEl = document.createElement('span');
    countEl.className = 'rank-count';
    countEl.setAttribute('data-role', 'rank-count');
    countEl.textContent = formatNumber(counter.count) + ' 笔';
    countEl.title = formatNumber(counter.count) + ' 笔';

    row.appendChild(rankEl);
    row.appendChild(nameEl);
    row.appendChild(countEl);
    row.appendChild(makeRowButton('delete', 'rank-delete', ICON_TRASH, '删除', true));
    return row;
  }

  function buildRankConfirmRow(counter, rank, isCurrent) {
    var row = document.createElement('div');
    row.className = 'rank-row confirming' + (rank <= 3 ? (' top-' + rank) : '') + (isCurrent ? ' is-current' : '');
    row.setAttribute('role', 'listitem');
    row.setAttribute('data-role', 'rank-row');
    row.setAttribute('data-counter-id', String(counter.id));

    var rankEl = document.createElement('span');
    rankEl.className = 'rank-no';
    rankEl.textContent = String(rank);

    var label = document.createElement('span');
    label.className = 'confirm-label';
    label.textContent = '删除?';
    label.title = '删除「' + String(counter.name) + '」？';

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'mini-btn confirm-yes';
    yes.setAttribute('data-action', 'confirm-delete');
    yes.setAttribute('data-role', 'confirm-delete');
    yes.textContent = '删除';
    yes.title = '确认删除「' + String(counter.name) + '」';

    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'mini-btn confirm-no';
    no.setAttribute('data-action', 'cancel-delete');
    no.setAttribute('data-role', 'cancel-delete');
    no.textContent = '取消';
    no.title = '取消删除';

    row.appendChild(rankEl);
    row.appendChild(label);
    row.appendChild(yes);
    row.appendChild(no);
    return row;
  }

  function makeRowButton(action, role, svg, title, danger) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn' + (danger ? ' danger' : '');
    btn.setAttribute('data-action', action);
    btn.setAttribute('data-role', role);
    btn.setAttribute('aria-label', title);
    btn.title = title;
    btn.innerHTML = svg;  /* 常量 SVG，无用户数据 */
    return btn;
  }

  /* ------------------------------------------------------------------ */
  /* 交互：Tab 切换                                                     */
  /* ------------------------------------------------------------------ */

  function setTab(tab) {
    if (tab !== 'leaderboard') { tab = 'records'; }
    activeTab = tab;
    var recordsActive = (tab === 'records');

    if (els.tabRecords) {
      els.tabRecords.className = 'tab' + (recordsActive ? ' active' : '');
      els.tabRecords.setAttribute('aria-selected', recordsActive ? 'true' : 'false');
    }
    if (els.tabLeaderboard) {
      els.tabLeaderboard.className = 'tab' + (recordsActive ? '' : ' active');
      els.tabLeaderboard.setAttribute('aria-selected', recordsActive ? 'false' : 'true');
    }
    if (els.tabPanelRecords) { els.tabPanelRecords.hidden = !recordsActive; }
    if (els.tabPanelLeaderboard) { els.tabPanelLeaderboard.hidden = recordsActive; }

    if (lastState) { renderLists(lastState); }
  }

  /* ------------------------------------------------------------------ */
  /* 交互：记录列表事件委托                                             */
  /* ------------------------------------------------------------------ */

  function bindRecordsEvents() {
    if (!els.recordList) { return; }

    els.recordList.addEventListener('click', function (e) {
      var btn = closestEl(e.target, 'button[data-action]');
      if (!btn || !els.recordList.contains(btn)) { return; }
      var row = closestEl(btn, '.record-row');
      var id = row ? row.getAttribute('data-counter-id') : '';
      var action = btn.getAttribute('data-action');
      if (action === 'edit') { startEdit(id); }
      else if (action === 'delete') { askDelete(id); }
      else if (action === 'confirm-delete') { confirmDelete(id); }
      else if (action === 'cancel-delete') { cancelDelete(); }
    });

    els.recordList.addEventListener('keydown', function (e) {
      var input = e.target;
      if (!input || !input.classList || !input.classList.contains('row-input')) { return; }
      if (e.key === 'Enter' || e.keyCode === 13) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === 'Escape' || e.keyCode === 27) {
        e.preventDefault();
        cancelEdit();
      }
    });

    /* 失焦保存（点击面板其它位置 / Tab 离开输入框） */
    els.recordList.addEventListener('focusout', function (e) {
      var input = e.target;
      if (!input || !input.classList || !input.classList.contains('row-input')) { return; }
      if (!editing || editing.committing) { return; }
      commitEdit();
    });
  }

  function bindLeaderboardEvents() {
    if (!els.leaderboardList) { return; }
    els.leaderboardList.addEventListener('click', function (e) {
      var btn = closestEl(e.target, 'button[data-action]');
      if (!btn || !els.leaderboardList.contains(btn)) { return; }
      var row = closestEl(btn, '.rank-row');
      var id = row ? row.getAttribute('data-counter-id') : '';
      var action = btn.getAttribute('data-action');
      if (action === 'delete') { askDelete(id); }
      else if (action === 'confirm-delete') { confirmDelete(id); }
      else if (action === 'cancel-delete') { cancelDelete(); }
    });
  }

  /* ------------------------------------------------------------------ */
  /* 交互：改名                                                         */
  /* ------------------------------------------------------------------ */

  function startEdit(id) {
    var counter = findCounter(lastState, id);
    if (!counter) {
      toast('该记录已不存在，正在刷新…', 'error');
      refreshFromLastState();
      return;
    }
    if (pendingDeleteId) { cancelDelete(); }
    if (clearConfirm) { resetClearConfirm(); }
    /* 若已在编辑别的行：先丢弃旧编辑态，避免移除输入框时触发重复提交 */
    if (editing) { editing = null; }

    editing = { id: id, original: counter.name, committing: false };
    renderRecordsList(lastState, true);

    var row = findRecordsRow(id);
    var input = row ? row.querySelector('.row-input') : null;
    if (input) {
      input.focus();
      try { input.select(); } catch (e) { /* ignore */ }
    }
  }

  function commitEdit() {
    var current = editing;
    if (!current || current.committing) { return; }

    var row = findRecordsRow(current.id);
    var input = row ? row.querySelector('.row-input') : null;
    if (!input) {
      editing = null;
      refreshFromLastState();
      return;
    }

    var value = input.value.replace(/^\s+|\s+$/g, '');
    if (!value) {
      toast('名字不能为空', 'error');
      cancelEdit();
      return;
    }
    if (value === current.original) {
      cancelEdit();
      return;
    }

    current.committing = true;
    bridge.renameCounter(current.id, value).then(function (res) {
      current.committing = false;
      if (editing === current) { editing = null; }
      if (res && res.ok) {
        toast('已改名为「' + value + '」', 'success');
      } else {
        toast('改名失败：' + hostErrorText(res && res.error), 'error');
      }
      if (res && res.state) { applyState(res.state, true); }
      else { refreshFromLastState(); }
    }, function (err) {
      current.committing = false;
      if (editing === current) { editing = null; }
      toast('改名失败：' + errText(err), 'error');
      refreshFromLastState();
    });
  }

  function cancelEdit() {
    if (!editing) { return; }
    editing = null;
    refreshFromLastState();
  }

  /* ------------------------------------------------------------------ */
  /* 交互：行内删除二次确认（记录 / 排行榜共用）                        */
  /* ------------------------------------------------------------------ */

  function askDelete(id) {
    var counter = findCounter(lastState, id);
    if (!counter) {
      toast('该记录已不存在，正在刷新…', 'error');
      refreshFromLastState();
      return;
    }
    if (editing) { editing = null; }
    if (clearConfirm) { resetClearConfirm(); }

    pendingDeleteId = id;
    if (deleteTimer) { clearTimeout(deleteTimer); }
    deleteTimer = setTimeout(function () {
      deleteTimer = null;
      if (!pendingDeleteId) { return; }
      pendingDeleteId = null;
      renderLists(lastState);
    }, CONFIRM_MS);

    renderLists(lastState);
    renderRecordsList(lastState, true);
  }

  function confirmDelete(id) {
    if (pendingDeleteId !== id) { return; }
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
    pendingDeleteId = null;

    bridge.deleteCounter(id).then(function (res) {
      if (res && res.ok) {
        toast('已删除记录', 'success');
      } else {
        toast('删除失败：' + hostErrorText(res && res.error), 'error');
      }
      if (res && res.state) { applyState(res.state, true); }
      else { refreshFromLastState(); }
    }, function (err) {
      toast('删除失败：' + errText(err), 'error');
      refreshFromLastState();
    });
  }

  function cancelDelete() {
    if (!pendingDeleteId) { return; }
    pendingDeleteId = null;
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }
    refreshFromLastState();
  }

  /* ------------------------------------------------------------------ */
  /* 交互：清空当前（二次确认）                                         */
  /* ------------------------------------------------------------------ */

  function onClearClick() {
    if (clearBusy) { return; }
    var counter = (lastState && lastState.activeCounterId)
      ? findCounter(lastState, lastState.activeCounterId)
      : null;

    if (!counter) {
      if (lastState && lastState.warning === 'limit') {
        toast('已达 10 个画布上限，当前画布没有可清空的记录', 'error');
      } else {
        toast('当前画布还没有可清空的记录', 'error');
      }
      return;
    }

    if (!clearConfirm) {
      clearConfirm = true;
      if (clearTimer) { clearTimeout(clearTimer); }
      clearTimer = setTimeout(function () {
        clearTimer = null;
        clearConfirm = false;
        renderCurrent(lastState);
      }, CONFIRM_MS);
      updateClearButton();
      return;
    }

    /* 第二次点击：执行清空 */
    clearConfirm = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    clearBusy = true;
    updateClearButton();

    var counterName = counter.name || '当前画布';
    bridge.clearCurrent().then(function (res) {
      clearBusy = false;
      if (res && res.ok) {
        toast('已清空「' + counterName + '」的笔数', 'success');
      } else {
        toast('清空失败：' + hostErrorText(res && res.error), 'error');
      }
      if (res && res.state) { applyState(res.state, true); }
      else { refreshFromLastState(); }
    }, function (err) {
      clearBusy = false;
      toast('清空失败：' + errText(err), 'error');
      refreshFromLastState();
    });
  }

  function resetClearConfirm() {
    if (!clearConfirm) { return; }
    clearConfirm = false;
    if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
    renderCurrent(lastState);
  }

  /* ------------------------------------------------------------------ */
  /* 交互：最小化 / 展开                                                */
  /* ------------------------------------------------------------------ */

  function getPanelSize() {
    var w = 0;
    var h = 0;
    try {
      w = Number(root.innerWidth) || 0;
      h = Number(root.innerHeight) || 0;
    } catch (e) { /* ignore */ }
    if (!(w >= 100)) { w = DEFAULT_W; }
    if (!(h >= 100)) { h = DEFAULT_H; }
    return { w: w, h: h };
  }

  /* CEP 面板缩放的唯一正确方式：CSInterface.resizeContent(w, h)。
     （window.resizeTo 在 CEP 中无效；浏览器 mock 下返回 false，仅切换 class。） */
  function resizePanel(w, h) {
    var width = Math.max(1, Math.round(Number(w) || 0));
    var height = Math.max(1, Math.round(Number(h) || 0));
    lastResizeCall = { w: width, h: height };   /* 供自测断言实际调用尺寸 */
    try {
      if (typeof root.CSInterface === 'function') {
        var cs = new root.CSInterface();
        if (cs && typeof cs.resizeContent === 'function') {
          cs.resizeContent(width, height);
          return true;
        }
      }
    } catch (e1) { /* ignore */ }
    try {
      if (root.__adobe_cep__ && typeof root.__adobe_cep__.resizeContent === 'function') {
        root.__adobe_cep__.resizeContent(width, height);
        return true;
      }
    } catch (e2) { /* ignore */ }
    return false;
  }

  /* 修改 CEP 面板窗口标题；浏览器 mock / 旧版 CEP 无此 API 时静默忽略。 */
  function setPanelTitle(title) {
    lastWindowTitle = title;
    try {
      if (typeof root.CSInterface === 'function') {
        var cs = new root.CSInterface();
        if (cs && typeof cs.setWindowTitle === 'function') {
          cs.setWindowTitle(title);
          return true;
        }
      }
    } catch (e1) { /* ignore */ }
    try {
      if (root.__adobe_cep__ && typeof root.__adobe_cep__.setWindowTitle === 'function') {
        root.__adobe_cep__.setWindowTitle(title);
        return true;
      }
    } catch (e2) { /* ignore */ }
    return false;
  }

  function minimizePanel() {
    if (minimized) { return; }
    if (helpOpen) { closeHelp(); }
    if (aboutOpen) { closeAbout(); }
    if (editing) { editing = null; }
    if (pendingDeleteId) { pendingDeleteId = null; }
    if (deleteTimer) { clearTimeout(deleteTimer); deleteTimer = null; }

    var size = getPanelSize();
    prevW = size.w;
    prevH = size.h;
    /* v1.1.2：记录最小化状态与展开尺寸（关闭 PS 重开仍以横条恢复） */
    writeSavedPanelState(true, prevW, prevH);
    enterMinimizedVisualState();
  }

  function expandPanel() {
    if (!minimized) { return; }
    if (dragActive) {
      dragActive = false;
      removeClass(root.document.body, 'dragging');
      callBridgeDrag('endPanelDrag');
    }
    /* 优先恢复 localStorage 里上次记录的展开尺寸，无效则回退默认 300×480 */
    var saved = readSavedPanelState();
    var w = saved.prevW || prevW || DEFAULT_W;
    var h = saved.prevH || prevH || DEFAULT_H;
    if (!isValidPanelSize(w, h)) {
      w = DEFAULT_W;
      h = DEFAULT_H;
    }
    minimized = false;
    removeClass(root.document.body, 'minimized');
    /* 先让 helper 取消窗口裁剪/还原位置，再恢复 PS 面板尺寸 */
    resizePanel(w, h);
    /* 展开恢复 PS 面板标题，并记录「已展开 + 本次展开尺寸」 */
    setPanelTitle('嗷呜计数');
    writeSavedPanelState(false, w, h);
    prevW = 0;
    prevH = 0;
    renderMini(lastState);
    stopDragHelper();
    if (lastState) {
      renderCurrent(lastState);
      renderLists(lastState);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 交互：最小化横条拖拽（v1.1.1，拖住爪印移动窗口）                    */
  /* ------------------------------------------------------------------ */

  function callBridgeDrag(name, x, y) {
    try {
      if (!bridge || typeof bridge[name] !== 'function') { return null; }
      return bridge[name](x, y);
    } catch (e) {
      return null;
    }
  }

  /* 展开/关闭面板时让 drag 助手进程退出（bridge v1.1.1 提供；缺失时静默） */
  function stopDragHelper() {
    try {
      if (bridge && typeof bridge.stopPanelDragHelper === 'function') {
        bridge.stopPanelDragHelper();
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function onMiniDragStart(e) {
    if (!minimized) { return; }
    var button = (e && typeof e.button === 'number') ? e.button : 0;
    if (button !== 0) { return; }
    dragActive = true;
    dragMoved = false;
    dragStartX = Number(e.screenX) || 0;
    dragStartY = Number(e.screenY) || 0;
    dragLastX = dragStartX;
    dragLastY = dragStartY;
    dragLastCallAt = 0;
    suppressMiniClick = false;
    addClass(root.document.body, 'dragging');
    var beginResult = callBridgeDrag('beginPanelDrag', dragStartX, dragStartY);
    /* helper 准备好时若鼠标已移动过，补发最新位置，避免首次拖拽丢位移。 */
    if (beginResult && typeof beginResult.then === 'function') {
      beginResult.then(function (res) {
        if (dragActive && dragMoved && res && res.ok) {
          callBridgeDrag('updatePanelDrag', dragLastX, dragLastY);
        }
      });
    }
    try { e.preventDefault(); } catch (eP) { /* ignore */ }
  }

  function onMiniDragMove(e) {
    if (!dragActive) { return; }
    var x = Number(e.screenX) || 0;
    var y = Number(e.screenY) || 0;
    dragLastX = x;
    dragLastY = y;
    var dx = x - dragStartX;
    var dy = y - dragStartY;
    if (!dragMoved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
      dragMoved = true;
    }
    if (!dragMoved) { return; }
    var now = (new Date()).getTime();
    if (now - dragLastCallAt < DRAG_THROTTLE_MS) { return; }
    dragLastCallAt = now;
    callBridgeDrag('updatePanelDrag', x, y);
    try { e.preventDefault(); } catch (eP) { /* ignore */ }
  }

  function onMiniDragEnd() {
    if (!dragActive) { return; }
    dragActive = false;
    removeClass(root.document.body, 'dragging');
    callBridgeDrag('endPanelDrag');
    if (dragMoved) {
      /* 移动过则不把松手当成点击展开；短暂抑制紧接着的 click */
      suppressMiniClick = true;
      setTimeout(function () { suppressMiniClick = false; }, 350);
    }
    dragMoved = false;
  }

  /* ------------------------------------------------------------------ */
  /* 交互：帮助弹窗                                                     */
  /* ------------------------------------------------------------------ */

  function openHelp() {
    if (!els.helpModal) { return; }
    /* 帮助 / 关于互斥：打开一个先关另一个 */
    if (aboutOpen) { closeAbout(); }
    helpOpen = true;
    els.helpModal.hidden = false;
    try {
      if (els.helpClose) { els.helpClose.focus(); }
    } catch (e) { /* ignore */ }
  }

  function closeHelp() {
    if (!helpOpen) { return; }
    helpOpen = false;
    if (els.helpModal) { els.helpModal.hidden = true; }
  }

  /* ------------------------------------------------------------------ */
  /* 交互：关于弹窗 + 外部浏览器（v1.1.3）                              */
  /* ------------------------------------------------------------------ */

  function openAbout() {
    if (!els.aboutModal) { return; }
    /* 帮助 / 关于互斥 */
    if (helpOpen) { closeHelp(); }
    aboutOpen = true;
    els.aboutModal.hidden = false;
    try {
      if (els.aboutClose) { els.aboutClose.focus(); }
    } catch (e) { /* ignore */ }
  }

  function closeAbout() {
    if (!aboutOpen) { return; }
    aboutOpen = false;
    if (els.aboutModal) { els.aboutModal.hidden = true; }
  }

  /* 用默认浏览器打开外部链接：优先 CSInterface，失败再 window.open；
     浏览器 mock 预览只记录 URL，不真的跳转/开新窗口（便于截图与自测）。 */
  function openExternalUrl(url) {
    var target = String(url || '');
    if (!target) { return false; }
    lastExternalUrl = target;
    if (isMockMode()) { return true; }
    try {
      if (typeof root.CSInterface === 'function') {
        var cs = new root.CSInterface();
        if (cs && typeof cs.openURLInDefaultBrowser === 'function' &&
            cs.openURLInDefaultBrowser(target)) {
          return true;
        }
      }
    } catch (e1) { /* ignore */ }
    try {
      if (root.open) {
        root.open(target, '_blank');
        return true;
      }
    } catch (e2) { /* ignore */ }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* 预览参数（仅浏览器 mock）：?mock=1&view=leaderboard|help|about|mini */
  /* ------------------------------------------------------------------ */

  function maybeApplyPreviewView() {
    if (previewViewApplied || !pendingPreviewView) { return; }
    if (!isMockMode()) {
      previewViewApplied = true;
      return;
    }
    previewViewApplied = true;
    if (pendingPreviewView === 'leaderboard') { setTab('leaderboard'); }
    else if (pendingPreviewView === 'help') { openHelp(); }
    else if (pendingPreviewView === 'about') {
      openAbout();
      /* 预览截图时不显示关闭按钮的 focus 高亮，保持画面干净 */
      try { if (els.aboutClose) { els.aboutClose.blur(); } } catch (eB) { /* ignore */ }
    }
    else if (pendingPreviewView === 'mini') { minimizePanel(); }
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                              */
  /* ------------------------------------------------------------------ */

  function toast(message, type) {
    if (!els.toastLayer || !message) { return; }
    while (els.toastLayer.children.length >= 2) {
      els.toastLayer.removeChild(els.toastLayer.firstChild);
    }
    var item = document.createElement('div');
    item.className = 'toast ' + (type === 'error' ? 'error' : (type === 'success' ? 'success' : 'info'));
    item.setAttribute('data-role', 'toast-item');
    item.textContent = String(message);
    els.toastLayer.appendChild(item);

    var timer = setTimeout(function () {
      item.className = item.className + ' hide';
      var removeTimer = setTimeout(function () {
        if (item.parentNode) { item.parentNode.removeChild(item); }
      }, 180);
      toastTimers.push(removeTimer);
    }, TOAST_MS);
    toastTimers.push(timer);
    if (toastTimers.length > 20) { toastTimers = toastTimers.slice(-10); }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 调试/QA 入口（控制台使用，界面上没有对应按钮） */
  root.AowuCounterApp = {
    VERSION: VERSION_FALLBACK,
    getState: function () { return lastState; },
    pollNow: pollOnce,
    mockAddStroke: function () {
      if (bridge && typeof bridge.mockAddStroke === 'function') { bridge.mockAddStroke(); }
    },
    _formatNumber: formatNumber,
    switchTab: setTab,
    getActiveTab: function () { return activeTab; },
    openHelp: openHelp,
    closeHelp: closeHelp,
    isHelpOpen: function () { return helpOpen; },
    /* v1.1.3 关于钩子 */
    openAbout: openAbout,
    closeAbout: closeAbout,
    isAboutOpen: function () { return aboutOpen; },
    _lastExternalUrl: function () { return lastExternalUrl; },
    _openExternalUrl: openExternalUrl,
    minimize: minimizePanel,
    expand: expandPanel,
    isMinimized: function () { return minimized; },
    /* v1.1.1 自测钩子 */
    isDragging: function () { return dragActive; },
    _dragState: function () {
      return { active: dragActive, moved: dragMoved, suppressClick: suppressMiniClick };
    },
    _lastResizeCall: function () { return lastResizeCall; },
    _getWindowTitle: function () { return lastWindowTitle; },
    _setPanelTitle: setPanelTitle,
    _getPanelSize: getPanelSize,
    /* v1.1.2 自测钩子 */
    _getSavedState: readSavedPanelState,
    _wasRestoredMinimized: function () { return restoredMinimized; },
    _canPersistState: canPersistPanelState
  };
})(window);
