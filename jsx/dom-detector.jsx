/*
 * 嗷呜计数 — 历史状态身份检测器（纯逻辑，ES3，无 Photoshop API）
 *
 * 背景（真机实测，PS 2025 / CEP）：在 CEP 的 evalScript 引擎里，
 *   - 用 ActionReference 按 index 取历史状态、或读取历史状态 ID，会报 -1715 "获取当前不可用"；
 *   - 但 Document.historyStates 的 DOM 对象可访问，且同一个历史状态的 HistoryState 包装对象
 *     在多次 evalScript 调用之间用 == / === 比较仍然相等（身份稳定）。
 * 因此检测改为：每次 tick 对比「历史状态包装对象引用序列」，新增的对象就是新操作；
 *   撤销/重做不会改变列表（只改 active），不会产生新对象 → 不计数；
 *   撤销后继续画：旧状态被截断、末尾出现新对象 → 计数；
 *   快速多笔：末尾多出多个新对象 → 逐个按名称判断是否画笔/铅笔。
 *
 * 依赖：无（ExtendScript ES3；Node 测试用 module.exports 兜底）。
 */
var AowuCounterDomDetector = (function () {
  function isArrayLike(v) {
    return !!v && typeof v === "object" && typeof v.length === "number";
  }

  function safeSame(a, b) {
    try {
      return a === b;
    } catch (e) {
      return false;
    }
  }

  function normalizeNames(names) {
    var out = [];
    var i;
    if (!isArrayLike(names)) { return out; }
    for (i = 0; i < names.length; i++) {
      if (typeof names[i] === "string" && names[i].length > 0) {
        var dup = false;
        var j;
        for (j = 0; j < out.length; j++) {
          if (out[j] === names[i]) { dup = true; break; }
        }
        if (!dup) { out.push(names[i]); }
      }
    }
    return out;
  }

  function copyTokens(tokens) {
    var out = [];
    var i;
    if (!isArrayLike(tokens)) { return out; }
    for (i = 0; i < tokens.length; i++) { out.push(tokens[i]); }
    return out;
  }

  /*
   * 对比前后两次完整历史状态 token 序列，返回新增部分的起点。
   * 历史记录的变化只可能是：
   *   a) 末尾追加（新操作）           → prev 是 cur 的前缀
   *   b) 撤销后新操作：截断后追加      → 公共前缀之后是新状态
   *   c) 历史记录达到上限后剪枝：头部被丢弃、末尾追加 → 偏移 d>0 对齐
   * 返回 { matched, offset, newStart, added }：
   *   matched  = 能与 prev 对齐的 cur 前缀长度
   *   offset   = cur[0] 对应 prev[offset]（剪枝时 >0）
   *   newStart = 新状态在 cur 中的起始下标（= matched）
   *   added    = cur.length - newStart
   */
  function diffTokenLists(prevTokens, curTokens) {
    var prev = isArrayLike(prevTokens) ? prevTokens : [];
    var cur = isArrayLike(curTokens) ? curTokens : [];
    var lcp = 0;
    var i, d, m, bestD, bestM;
    while (lcp < prev.length && lcp < cur.length && safeSame(prev[lcp], cur[lcp])) { lcp++; }
    if (lcp === cur.length) {
      return { matched: lcp, offset: 0, newStart: cur.length, added: 0 };
    }
    if (lcp === prev.length) {
      return { matched: lcp, offset: 0, newStart: prev.length, added: cur.length - prev.length };
    }
    // 头部可能被剪枝：找最佳偏移 d>=1，使 cur 前缀与 prev[d..] 最长连续对齐
    bestD = 0;
    bestM = lcp;
    for (d = 1; d < prev.length; d++) {
      m = 0;
      while (m < cur.length && (m + d) < prev.length && safeSame(cur[m], prev[m + d])) { m++; }
      if (m > bestM) { bestM = m; bestD = d; }
    }
    return { matched: bestM, offset: bestD, newStart: bestM, added: cur.length - bestM };
  }

  function createDetector() {
    var docs = {};
    var paintNames = [];

    function hasOwn(obj, key) {
      return Object.prototype.hasOwnProperty.call(obj, key);
    }

    function setPaintNames(names) {
      paintNames = normalizeNames(names);
    }

    function isPaintName(name) {
      var i;
      for (i = 0; i < paintNames.length; i++) {
        if (paintNames[i] === name) { return true; }
      }
      return false;
    }

    // 首次见到文档：只记录基线，不计数
    function ensureDoc(docId, tokens) {
      var key = String(docId);
      if (hasOwn(docs, key)) { return false; }
      docs[key] = { tokens: copyTokens(tokens) };
      return true;
    }

    // 追加路径（调用方已确认是纯追加）：newTokens/newNames 为新增的尾部部分
    function appendStates(docId, newTokens, newNames) {
      var key = String(docId);
      var doc = hasOwn(docs, key) ? docs[key] : null;
      var count = 0;
      var i;
      if (doc === null) { return { newStrokeCount: 0, added: 0 }; }
      var len = isArrayLike(newTokens) ? newTokens.length : 0;
      for (i = 0; i < len; i++) {
        doc.tokens.push(newTokens[i]);
        if (isArrayLike(newNames) && typeof newNames[i] === "string" && isPaintName(newNames[i])) {
          count++;
        }
      }
      return { newStrokeCount: count, added: len };
    }

    // 全量对比路径：tokens/names 为当前完整历史列表
    function scanFull(docId, tokens, names) {
      var key = String(docId);
      var doc = hasOwn(docs, key) ? docs[key] : null;
      var count = 0;
      var i;
      if (doc === null) { return { newStrokeCount: 0, added: 0, newStart: 0, offset: 0, matched: 0 }; }
      var diff = diffTokenLists(doc.tokens, tokens);
      var len = isArrayLike(tokens) ? tokens.length : 0;
      for (i = diff.newStart; i < len; i++) {
        if (isArrayLike(names) && typeof names[i] === "string" && isPaintName(names[i])) {
          count++;
        }
      }
      doc.tokens = copyTokens(tokens);
      return {
        newStrokeCount: count,
        added: len - diff.newStart,
        newStart: diff.newStart,
        offset: diff.offset,
        matched: diff.matched
      };
    }

    function forgetDoc(docId) {
      var key = String(docId);
      if (!hasOwn(docs, key)) { return false; }
      delete docs[key];
      return true;
    }

    function snapshot() {
      var out = {};
      var key;
      for (key in docs) {
        if (!hasOwn(docs, key)) { continue; }
        out[key] = { tokens: docs[key].tokens.length };
      }
      return { paintNames: paintNames.slice ? paintNames.slice(0) : paintNames, docs: out };
    }

    return {
      setPaintNames: setPaintNames,
      ensureDoc: ensureDoc,
      appendStates: appendStates,
      scanFull: scanFull,
      forgetDoc: forgetDoc,
      snapshot: snapshot
    };
  }

  return {
    createDetector: createDetector,
    diffTokenLists: diffTokenLists
  };
})();

if (typeof module !== "undefined" && module.exports) { module.exports = AowuCounterDomDetector; }
