// =====================================================================
// 嗷呜计数 (Aowu Counter) — 纯逻辑核心 core.jsx
//
// 职责：计数器模型、持久化行格式、历史状态 ID 高水位检测器。
// 运行环境：
//   1) Photoshop ExtendScript：仅使用 ES3 语法（var / function），不依赖 JSON
//      全局，不调用任何 Photoshop API，也不访问 DOM。
//   2) Node 单测：文件末尾通过 module.exports 暴露，可用 vm 沙箱加载。
// 契约：docs/ARCHITECTURE.md 第 3 节；改动接口须同步更新契约文档。
// =====================================================================

var AowuCounterCore = (function () {

  // ===== 3.1 常量 ======================================================
  var MAX_COUNTERS = 100000000;      // 最多同时保存 1 亿个计数器（理论硬上限）
  var MAX_STROKES = 100000000000;    // 单计数器封顶 1000 亿
  var DATA_VERSION = 1;              // 持久化行格式版本
  var MAX_NAME_LENGTH = 260;         // 与 Photoshop 文件名长度上限一致
  var FILE_HEADER = "#AOWU-COUNT v"; // 完整文件头 = FILE_HEADER + DATA_VERSION

  // ===== 3.2 工具函数 ==================================================

  // 当前毫秒时间戳（不用 Date.now，ES3 没有）
  function nowMs() {
    return (new Date()).getTime();
  }

  // 跨执行环境的数组判断（不依赖 Array.isArray）
  function isArray(value) {
    return Object.prototype.toString.call(value) === "[object Array]";
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // 计数归一化：0..MAX_STROKES 的整数。
  // 与 js/bridge.js 的 clampCount 同款宽松转换：先 Number()，再判有限/非负。
  function clampCount(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) { return 0; }
    n = Math.floor(n);
    return n > MAX_STROKES ? MAX_STROKES : n;
  }

  // 千分位格式化：12345 -> "12,345"
  function formatNumber(n) {
    var negative, abs, text, out, i, len, first;
    if (typeof n !== "number" || isNaN(n)) { return "0"; }
    if (!isFinite(n)) { return String(n); }
    negative = n < 0;
    abs = negative ? -n : n;
    if (abs >= 1e21) { return String(n); } // 超出安全格式化范围，原样返回
    text = String(Math.floor(abs));
    out = "";
    len = text.length;
    first = len % 3;
    for (i = 0; i < len; i++) {
      if (i > 0 && (i - first) % 3 === 0) { out += ","; }
      out += text.charAt(i);
    }
    return negative ? "-" + out : out;
  }

  // JSON 字符串转义（只依赖 ES3 字符串方法）
  function jsonEscapeString(value) {
    var out = "\"";
    var i, ch, code, hex;
    for (i = 0; i < value.length; i++) {
      ch = value.charAt(i);
      if (ch === "\"") { out += "\\\""; }
      else if (ch === "\\") { out += "\\\\"; }
      else if (ch === "\r") { out += "\\r"; }
      else if (ch === "\n") { out += "\\n"; }
      else if (ch === "\t") { out += "\\t"; }
      else if (ch === "\b") { out += "\\b"; }
      else if (ch === "\f") { out += "\\f"; }
      else {
        code = value.charCodeAt(i);
        if (code < 32) {
          hex = code.toString(16);
          while (hex.length < 4) { hex = "0" + hex; }
          out += "\\u" + hex;
        } else {
          out += ch;
        }
      }
    }
    return out + "\"";
  }

  // 递归写 JSON 片段；stack 用于循环引用保护
  function jsonWrite(value, parts, stack) {
    var type = typeof value;
    var i, key, item, first;
    if (value === null) { parts.push("null"); return; }
    if (type === "string") { parts.push(jsonEscapeString(value)); return; }
    if (type === "number") {
      if (!isFinite(value)) { parts.push("null"); return; }
      parts.push(String(value));
      return;
    }
    if (type === "boolean") { parts.push(value ? "true" : "false"); return; }
    if (type !== "object") { parts.push("null"); return; } // undefined / function
    for (i = 0; i < stack.length; i++) {
      if (stack[i] === value) { parts.push("null"); return; } // 循环引用输出 null
    }
    stack.push(value);
    if (isArray(value)) {
      parts.push("[");
      for (i = 0; i < value.length; i++) {
        if (i > 0) { parts.push(","); }
        jsonWrite(value[i], parts, stack);
      }
      parts.push("]");
    } else {
      parts.push("{");
      first = true;
      for (key in value) {
        if (!hasOwn(value, key)) { continue; }
        item = value[key];
        if (typeof item === "undefined" || typeof item === "function") { continue; }
        if (!first) { parts.push(","); }
        first = false;
        parts.push(jsonEscapeString(String(key)));
        parts.push(":");
        jsonWrite(item, parts, stack);
      }
      parts.push("}");
    }
    stack.pop();
  }

  // 手写 JSON 序列化：对象 / 数组 / 字符串 / 数字 / 布尔 / null。
  // 输出必须能被面板侧 JSON.parse 解析；NaN、Infinity 输出 null。
  function jsonStringify(value) {
    var parts = [];
    jsonWrite(value, parts, []);
    return parts.join("");
  }

  // ===== 名字与时间的归一化 ============================================

  function isWhitespaceChar(ch) {
    var code;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" ||
        ch === "\f" || ch === "\v") { return true; }
    code = ch.charCodeAt(0);
    return code === 0x00a0 || code === 0x3000 || code === 0xfeff;
  }

  function trimStr(value) {
    var start, end;
    if (typeof value !== "string") { return ""; }
    start = 0;
    end = value.length;
    while (start < end && isWhitespaceChar(value.charAt(start))) { start++; }
    while (end > start && isWhitespaceChar(value.charAt(end - 1))) { end--; }
    return value.substring(start, end);
  }

  // 只去掉末尾一个 .psd（忽略大小写）；"测试.psd.psd" -> "测试.psd"。
  // 这样 PS 文档名 "未标题-1.psd" 与 "未标题-1" 视为同一画布。
  function stripPsdSuffix(name) {
    var trimmed = trimStr(name);
    if (/\.psd$/i.test(trimmed)) {
      var base = trimmed.substring(0, trimmed.length - 4);
      if (base.length > 0) { return base; }
    }
    return trimmed;
  }

  // 合法名字：去首尾空白、去掉末尾一个 .psd 后非空且长度 <= 260；非法返回 null
  function normalizeName(name) {
    var normalized = stripPsdSuffix(name);
    if (normalized.length === 0 || normalized.length > MAX_NAME_LENGTH) { return null; }
    return normalized;
  }

  // 毫秒整数；缺失/非法时退回当前时间
  function normalizeCreatedAt(now) {
    if (typeof now === "number" && isFinite(now) && now >= 0) {
      return Math.floor(now);
    }
    return nowMs();
  }

  // 行格式里的 createdAt 列：空/非法用当前时间，负数不可信也用当前时间
  function parseCreatedAtColumn(text) {
    var trimmed = trimStr(text);
    var value;
    if (trimmed.length === 0) { return nowMs(); }
    value = Number(trimmed);
    if (!isFinite(value) || value < 0) { return nowMs(); }
    return Math.floor(value);
  }

  function encodeNameForFile(name) {
    try {
      return encodeURIComponent(name);
    } catch (e) {
      return "";
    }
  }

  // 解码失败返回 null（调用方丢弃该行）
  function decodeNameFromFile(text) {
    try {
      return decodeURIComponent(text);
    } catch (e) {
      return null;
    }
  }

  function findCounterById(list, id) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].id === id) { return list[i]; }
    }
    return null;
  }

  function findCounterByName(list, name) {
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i].name === name) { return list[i]; }
    }
    return null;
  }

  function isPaintName(paintNames, name) {
    var i;
    for (i = 0; i < paintNames.length; i++) {
      if (paintNames[i] === name) { return true; }
    }
    return false;
  }

  // ===== 3.3 计数器模型 ================================================

  var modelSerial = 0;

  function createModel() {
    var counters = [];
    var idSeq;

    modelSerial++;
    // 以创建时刻为 id 种子，避免跨会话（重新打开面板）生成重复 id
    idSeq = nowMs() * 1000 + modelSerial;

    function findByIdRaw(id) {
      return findCounterById(counters, id);
    }

    function findById(id) {
      if (typeof id === "undefined" || id === null) { return null; }
      return findByIdRaw(String(id));
    }

    function findByNameRaw(name) {
      return findCounterByName(counters, name);
    }

    function findByName(name) {
      // 查询同样去空白、去末尾一个 .psd，保证 "foo.psd" 能命中 "foo"
      var normalized = normalizeName(name);
      if (normalized === null) { return null; }
      return findByNameRaw(normalized);
    }

    function nextId() {
      var id;
      do {
        idSeq++;
        id = "c" + idSeq.toString(36);
      } while (findByIdRaw(id) !== null);
      return id;
    }

    function removeCounter(counter) {
      var i;
      for (i = 0; i < counters.length; i++) {
        if (counters[i] === counter) {
          counters.splice(i, 1);
          return true;
        }
      }
      return false;
    }

    function count() {
      return counters.length;
    }

    function getCounters() {
      return counters; // 只读使用
    }

    // -> {ok:true, counter} | {ok:false, reason:"limit"|"duplicate"|"invalid"}
    function createCounter(name, now) {
      var normalized = normalizeName(name);
      var counter;
      if (normalized === null) { return { ok: false, reason: "invalid" }; }
      if (findByNameRaw(normalized) !== null) { return { ok: false, reason: "duplicate" }; }
      if (counters.length >= MAX_COUNTERS) { return { ok: false, reason: "limit" }; }
      counter = {
        id: nextId(),
        name: normalized,
        count: 0,
        createdAt: normalizeCreatedAt(now)
      };
      counters.push(counter);
      return { ok: true, counter: counter };
    }

    // -> {ok:true, counter} | {ok:false, reason:"missing"|"duplicate"|"invalid"}
    function renameCounter(id, newName) {
      var counter = findById(id);
      var normalized, existing;
      if (counter === null) { return { ok: false, reason: "missing" }; }
      normalized = normalizeName(newName);
      if (normalized === null) { return { ok: false, reason: "invalid" }; }
      existing = findByNameRaw(normalized);
      if (existing !== null && existing !== counter) {
        return { ok: false, reason: "duplicate" };
      }
      counter.name = normalized;
      return { ok: true, counter: counter };
    }

    // 把 source 的笔数并入 target（封顶），然后删除 source
    // -> {ok:true, count} | {ok:false, reason:"missing"|"invalid"}
    function mergeCounterInto(sourceId, targetId) {
      var source = findById(sourceId);
      var target = findById(targetId);
      var merged;
      if (source === null || target === null) { return { ok: false, reason: "missing" }; }
      if (source === target) { return { ok: false, reason: "invalid" }; }
      merged = clampCount(target.count + source.count);
      target.count = merged;
      removeCounter(source);
      return { ok: true, count: merged };
    }

    // -> {ok:true, added, count} | {ok:false, reason:"missing"}
    function increment(id, n) {
      var counter = findById(id);
      var amount, room, added;
      if (counter === null) { return { ok: false, reason: "missing" }; }
      amount = clampCount(n);
      room = MAX_STROKES - counter.count;
      if (room < 0) { room = 0; }
      added = amount < room ? amount : room;
      if (added > 0) { counter.count += added; }
      return { ok: true, added: added, count: counter.count };
    }

    // -> {ok:true} | {ok:false, reason:"missing"}
    function clearCounter(id) {
      var counter = findById(id);
      if (counter === null) { return { ok: false, reason: "missing" }; }
      counter.count = 0;
      return { ok: true };
    }

    // -> {ok:true} | {ok:false, reason:"missing"}
    function deleteCounter(id) {
      var counter = findById(id);
      if (counter === null) { return { ok: false, reason: "missing" }; }
      removeCounter(counter);
      return { ok: true };
    }

    // 深拷贝快照，外部修改不影响模型内部
    // -> {counters:[{id,name,count,createdAt}], maxCounters, maxStrokes}
    function snapshot() {
      var list = [];
      var i;
      for (i = 0; i < counters.length; i++) {
        list.push({
          id: counters[i].id,
          name: counters[i].name,
          count: counters[i].count,
          createdAt: counters[i].createdAt
        });
      }
      return {
        counters: list,
        maxCounters: MAX_COUNTERS,
        maxStrokes: MAX_STROKES
      };
    }

    // 行格式文本，末尾恒有 "\n"
    function serialize() {
      var lines = [];
      var i;
      lines.push(FILE_HEADER + DATA_VERSION);
      for (i = 0; i < counters.length; i++) {
        lines.push(
          counters[i].id + "\t" +
          String(clampCount(counters[i].count)) + "\t" +
          String(Math.floor(counters[i].createdAt)) + "\t" +
          encodeNameForFile(counters[i].name)
        );
      }
      return lines.join("\n") + "\n";
    }

    // 解析行格式；失败返回 {ok:false, errors:[...]}，不抛异常。
    // 成功时用解析结果整体替换模型，返回 {ok:true, counters, errors}；
    // errors 只是提示（坏行、重复、超限等），不阻塞加载。
    function loadFromText(text) {
      var errors = [];
      var parsed = [];
      var rawLines, i, line, parts, id, name, count, createdAt, existing, versionText, versionNumber;
      if (typeof text !== "string") {
        return { ok: false, errors: ["invalid_text"] };
      }
      rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      for (i = 0; i < rawLines.length; i++) {
        line = trimStr(rawLines[i]);
        if (line.length === 0) { continue; }
        if (line.charAt(0) === "#") {
          if (line.substring(0, FILE_HEADER.length) === FILE_HEADER) {
            versionText = trimStr(line.substring(FILE_HEADER.length));
            versionNumber = parseInt(versionText, 10);
            if (versionNumber !== DATA_VERSION) {
              return { ok: false, errors: ["unsupported_version:" + versionText] };
            }
          }
          continue;
        }
        parts = line.split("\t");
        if (parts.length < 4) {
          errors.push("line " + (i + 1) + ": bad_columns");
          continue;
        }
        id = trimStr(parts[0]);
        if (id.length === 0) {
          errors.push("line " + (i + 1) + ": bad_id");
          continue;
        }
        name = normalizeName(decodeNameFromFile(parts[3]));
        if (name === null) {
          errors.push("line " + (i + 1) + ": bad_name");
          continue;
        }
        count = clampCount(trimStr(parts[1]));
        createdAt = parseCreatedAtColumn(parts[2]);
        if (findCounterById(parsed, id) !== null) {
          errors.push("line " + (i + 1) + ": duplicate_id");
          continue;
        }
        existing = findCounterByName(parsed, name);
        if (existing !== null) {
          existing.count = clampCount(existing.count + count);
          errors.push("line " + (i + 1) + ": duplicate_name_merged");
          continue;
        }
        if (parsed.length >= MAX_COUNTERS) {
          errors.push("line " + (i + 1) + ": limit");
          continue;
        }
        parsed.push({ id: id, name: name, count: count, createdAt: createdAt });
      }
      counters.length = 0;
      for (i = 0; i < parsed.length; i++) { counters.push(parsed[i]); }
      return { ok: true, counters: counters, errors: errors };
    }

    return {
      loadFromText: loadFromText,
      serialize: serialize,
      snapshot: snapshot,
      getCounters: getCounters,
      count: count,
      findById: findById,
      findByName: findByName,
      createCounter: createCounter,
      renameCounter: renameCounter,
      mergeCounterInto: mergeCounterInto,
      increment: increment,
      clearCounter: clearCounter,
      deleteCounter: deleteCounter
    };
  }

  // ===== 3.5 检测器：历史状态 ID 高水位 ================================

  function normalizeStateId(value) {
    if (typeof value !== "number" || !isFinite(value)) { return 0; }
    value = Math.floor(value);
    return value < 0 ? 0 : value;
  }

  function createDetector() {
    var docs = {}; // key: String(docId) -> {watermark:number, paintNames:[string]}

    // 首次见到文档时建立基线；返回 true 表示首次，false 表示已建立过
    function ensureDoc(docId, lastStateId, paintNames) {
      var key = String(docId);
      var names = [];
      var i, j, candidate, duplicate;
      if (hasOwn(docs, key)) { return false; }
      if (isArray(paintNames)) {
        for (i = 0; i < paintNames.length; i++) {
          candidate = paintNames[i];
          if (typeof candidate !== "string" || candidate.length === 0) { continue; }
          duplicate = false;
          for (j = 0; j < names.length; j++) {
            if (names[j] === candidate) { duplicate = true; break; }
          }
          if (!duplicate) { names.push(candidate); }
        }
      }
      docs[key] = { watermark: normalizeStateId(lastStateId), paintNames: names };
      return true;
    }

    // tailStates = [{id, name}, ...]（历史顺序，旧 -> 新，最多 8 条）。
    // 只处理 id > watermark 的状态：所有新状态抬水位，名字命中画笔/铅笔的计数。
    // newStateIds = 本次处理的所有新状态 id（含非画笔），按 tail 顺序。
    // 返回 {newStrokeCount, newStateIds, watermark}。
    function scanTail(docId, tailStates) {
      var key = String(docId);
      var doc = hasOwn(docs, key) ? docs[key] : null;
      var newStateIds = [];
      var newStrokeCount = 0;
      var maxId, i, j, state, id, name, seen;
      if (doc === null) {
        // 契约允许未建档时抛错或返回 0；这里返回零结果，保证 host 不抛异常
        return { newStrokeCount: 0, newStateIds: [], watermark: 0 };
      }
      maxId = doc.watermark;
      if (isArray(tailStates)) {
        for (i = 0; i < tailStates.length; i++) {
          state = tailStates[i];
          if (state === null || typeof state !== "object") { continue; }
          id = state.id;
          if (typeof id !== "number" || !isFinite(id)) { continue; }
          id = Math.floor(id);
          if (id <= doc.watermark) { continue; }
          seen = false;
          for (j = 0; j < newStateIds.length; j++) {
            if (newStateIds[j] === id) { seen = true; break; }
          }
          if (seen) { continue; }
          newStateIds.push(id);
          if (id > maxId) { maxId = id; }
          name = state.name;
          if (typeof name === "string" && isPaintName(doc.paintNames, name)) {
            newStrokeCount++;
          }
        }
      }
      doc.watermark = maxId;
      return {
        newStrokeCount: newStrokeCount,
        newStateIds: newStateIds,
        watermark: doc.watermark
      };
    }

    function watermark(docId) {
      var key = String(docId);
      return hasOwn(docs, key) ? docs[key].watermark : 0;
    }

    // 文档关闭时清理（可选）；返回是否真的清理了
    function forgetDoc(docId) {
      var key = String(docId);
      if (!hasOwn(docs, key)) { return false; }
      delete docs[key];
      return true;
    }

    function snapshot() {
      var result = {};
      var key;
      for (key in docs) {
        if (!hasOwn(docs, key)) { continue; }
        result[key] = { watermark: docs[key].watermark };
      }
      return { docs: result };
    }

    return {
      ensureDoc: ensureDoc,
      scanTail: scanTail,
      watermark: watermark,
      forgetDoc: forgetDoc,
      snapshot: snapshot
    };
  }

  // ===== 对外 API ======================================================

  return {
    MAX_COUNTERS: MAX_COUNTERS,
    MAX_STROKES: MAX_STROKES,
    DATA_VERSION: DATA_VERSION,
    clampCount: clampCount,
    formatNumber: formatNumber,
    normalizeName: normalizeName,
    jsonStringify: jsonStringify,
    nowMs: nowMs,
    createModel: createModel,
    createDetector: createDetector
  };
})();

if (typeof module !== "undefined" && module.exports) { module.exports = AowuCounterCore; }
