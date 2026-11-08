/*
 * 嗷呜计数 — core.jsx 单元测试（Node 内置 node:test / node:assert）
 *
 * 运行方式：tests/run-tests.ps1（优先使用本机内置 Node）
 * 覆盖范围：工具函数、计数器模型、持久化行格式、历史状态高水位检测器、
 *          ES3 静态约束与 vm / require 双加载方式。
 *
 * core.jsx 是 ExtendScript 脚本，Node 里用 require 直接加载（未知扩展名按 JS 处理）；
 * 若某些 Node 版本不支持，则回退到 vm.runInContext 沙箱加载。
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PROJECT_ROOT = path.join(__dirname, "..");
const CORE_PATH = path.join(PROJECT_ROOT, "jsx", "core.jsx");
const CORE_SOURCE = fs.readFileSync(CORE_PATH, "utf8");

// ---------- 加载 core.jsx（require 优先，vm 兜底） ----------

function loadSandbox(extraGlobals) {
  const sandbox = { module: { exports: {} } };
  if (extraGlobals) {
    for (const key of Object.keys(extraGlobals)) { sandbox[key] = extraGlobals[key]; }
  }
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: CORE_PATH });
  return sandbox;
}

let Core = null;
let LOAD_MODE = "";
try {
  Core = require(CORE_PATH);
  LOAD_MODE = "require";
} catch (err) {
  Core = loadSandbox().module.exports;
  LOAD_MODE = "vm";
}

// 跨 vm realm 的对象转成当前 realm 的普通对象，便于 deepEqual
function plain(value) {
  if (typeof value === "undefined") { return undefined; }
  return JSON.parse(JSON.stringify(value));
}

// 去掉 JS 注释（保留字符串内容），供 ES3 静态检查使用，避免注释里的词造成误报
function stripJsComments(source) {
  let out = "";
  let i = 0;
  const length = source.length;
  while (i < length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < length && source.charAt(i) !== "\n") { i++; }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < length && !(source.charAt(i) === "*" && source.charAt(i + 1) === "/")) { i++; }
      i += 2;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      out += ch;
      i++;
      while (i < length) {
        const inner = source.charAt(i);
        out += inner;
        if (inner === "\\") {
          if (i + 1 < length) { out += source.charAt(i + 1); }
          i += 2;
          continue;
        }
        i++;
        if (inner === quote) { break; }
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// 去掉注释放供静态检查的代码文本：去掉开头 BOM（BOM 只用于 ExtendScript 识别编码）
const CORE_CODE = stripJsComments(CORE_SOURCE).replace(/^\uFEFF/, "");

const PAINTS = ["画笔工具", "铅笔工具"];

function state(id, name) {
  return { id: id, name: name };
}

function newModel() {
  return Core.createModel();
}

function addCounter(model, name, now) {
  const result = model.createCounter(name, now === undefined ? 1700000000000 : now);
  assert.equal(result.ok, true, "createCounter 应成功：" + String(name));
  return result.counter;
}

// =====================================================================
// 常量与工具函数
// =====================================================================

test("常量与契约一致", () => {
  assert.equal(Core.MAX_COUNTERS, 10);
  assert.equal(Core.MAX_STROKES, 100000000000);
  assert.equal(Core.DATA_VERSION, 1);
});

test("导出 API 齐全", () => {
  const funcs = ["clampCount", "formatNumber", "jsonStringify", "nowMs", "createModel", "createDetector"];
  for (const name of funcs) {
    assert.equal(typeof Core[name], "function", "缺少函数 " + name);
  }
});

test("clampCount 处理常规数值与上下界", () => {
  assert.equal(Core.clampCount(0), 0);
  assert.equal(Core.clampCount(5), 5);
  assert.equal(Core.clampCount(5.9), 5);
  assert.equal(Core.clampCount(-1), 0);
  assert.equal(Core.clampCount(-0.5), 0);
  assert.equal(Core.clampCount(Core.MAX_STROKES), Core.MAX_STROKES);
  assert.equal(Core.clampCount(Core.MAX_STROKES + 1), Core.MAX_STROKES);
  assert.equal(Core.clampCount(1e15), Core.MAX_STROKES);
  assert.equal(typeof Core.clampCount(7.8), "number");
});

test("clampCount 处理非数字（与 bridge.js 同款宽松转换）", () => {
  assert.equal(Core.clampCount(NaN), 0);
  assert.equal(Core.clampCount(undefined), 0);
  assert.equal(Core.clampCount(null), 0);
  assert.equal(Core.clampCount("abc"), 0);
  assert.equal(Core.clampCount(Infinity), 0);
  assert.equal(Core.clampCount(-Infinity), 0);
  // Number("12") 可转换 => 12（js/bridge.js 的 clampCount 行为一致）
  assert.equal(Core.clampCount("12"), 12);
});

test("formatNumber 输出千分位", () => {
  assert.equal(Core.formatNumber(0), "0");
  assert.equal(Core.formatNumber(7), "7");
  assert.equal(Core.formatNumber(999), "999");
  assert.equal(Core.formatNumber(1000), "1,000");
  assert.equal(Core.formatNumber(12345), "12,345");
  assert.equal(Core.formatNumber(1234567), "1,234,567");
  assert.equal(Core.formatNumber(100000000000), "100,000,000,000");
  assert.equal(Core.formatNumber(-12345), "-12,345");
});

test("formatNumber 对小数与非数字兜底", () => {
  assert.equal(Core.formatNumber(1234.9), "1,234");
  assert.equal(Core.formatNumber(NaN), "0");
  assert.equal(Core.formatNumber(undefined), "0");
  assert.equal(Core.formatNumber(null), "0");
  assert.equal(Core.formatNumber("12345"), "0");
});

test("nowMs 返回毫秒时间戳", () => {
  const before = Date.now();
  const value = Core.nowMs();
  const after = Date.now();
  assert.equal(typeof value, "number");
  assert.equal(Math.floor(value), value);
  assert.ok(value >= before && value <= after + 1000, "时间戳应落在调用前后");
});

test("jsonStringify 处理原始类型", () => {
  assert.equal(Core.jsonStringify(null), "null");
  assert.equal(Core.jsonStringify(true), "true");
  assert.equal(Core.jsonStringify(false), "false");
  assert.equal(Core.jsonStringify(0), "0");
  assert.equal(Core.jsonStringify(-1), "-1");
  assert.equal(Core.jsonStringify(3.5), "3.5");
  assert.equal(Core.jsonStringify("abc"), "\"abc\"");
});

test("jsonStringify 正确转义字符串", () => {
  const value = "引号\" 反斜杠\\ 回车\r 换行\n 制表\t 控制\u0001 中文";
  const encoded = Core.jsonStringify(value);
  assert.equal(typeof encoded, "string");
  assert.equal(JSON.parse(encoded), value);
  assert.match(encoded, /\\"/);
  assert.match(encoded, /\\\\/);
  assert.match(encoded, /\\r/);
  assert.match(encoded, /\\n/);
  assert.match(encoded, /\\t/);
  assert.match(encoded, /\\u0001/);
});

test("jsonStringify 处理对象与数组", () => {
  const value = {
    ok: true,
    n: 10,
    name: "画布",
    list: [1, "a", null, false],
    nested: { x: -2.5 }
  };
  assert.deepEqual(JSON.parse(Core.jsonStringify(value)), value);
  assert.equal(Core.jsonStringify({}), "{}");
  assert.equal(Core.jsonStringify([]), "[]");
});

test("jsonStringify 转义对象键名", () => {
  const obj = {};
  obj["a\"b"] = 1;
  obj["c\\d"] = 2;
  obj["换行\n"] = 3;
  const parsed = JSON.parse(Core.jsonStringify(obj));
  assert.equal(parsed["a\"b"], 1);
  assert.equal(parsed["c\\d"], 2);
  assert.equal(parsed["换行\n"], 3);
});

test("jsonStringify 处理 undefined、NaN 与 Infinity", () => {
  assert.equal(Core.jsonStringify({ a: 1, b: undefined }), "{\"a\":1}");
  assert.equal(Core.jsonStringify([1, undefined, NaN, Infinity]), "[1,null,null,null]");
  assert.equal(Core.jsonStringify(NaN), "null");
  assert.equal(Core.jsonStringify(Infinity), "null");
  assert.equal(Core.jsonStringify(undefined), "null");
});

test("jsonStringify 遇到循环引用不崩溃", () => {
  const obj = { n: 1 };
  obj.self = obj;
  assert.equal(Core.jsonStringify(obj), "{\"n\":1,\"self\":null}");
});

test("jsonStringify 输出可被面板 JSON.parse 解析（快照场景）", () => {
  const model = newModel();
  const counter = addCounter(model, "画布 \"A\"");
  model.increment(counter.id, 5);
  const parsed = JSON.parse(Core.jsonStringify(model.snapshot()));
  assert.equal(parsed.maxCounters, 10);
  assert.equal(parsed.maxStrokes, 100000000000);
  assert.equal(parsed.counters.length, 1);
  assert.equal(parsed.counters[0].name, "画布 \"A\"");
  assert.equal(parsed.counters[0].count, 5);
});

// =====================================================================
// 计数器模型：创建 / 查找 / 上限
// =====================================================================

test("createCounter 基本创建", () => {
  const model = newModel();
  const result = model.createCounter("画布 1", 1790000000000);
  assert.equal(result.ok, true);
  assert.equal(typeof result.counter.id, "string");
  assert.ok(result.counter.id.length > 0);
  assert.equal(result.counter.name, "画布 1");
  assert.equal(result.counter.count, 0);
  assert.equal(result.counter.createdAt, 1790000000000);
  assert.equal(model.count(), 1);
  assert.equal(model.findById(result.counter.id), result.counter);
  assert.equal(model.findByName("画布 1"), result.counter);
});

test("createCounter 去掉名字首尾空白", () => {
  const model = newModel();
  const counter = addCounter(model, "  画布 1  ");
  assert.equal(counter.name, "画布 1");
  assert.equal(model.findByName("画布 1"), counter);
});

test("createCounter 拒绝非法名字", () => {
  const model = newModel();
  const badNames = ["", "   ", "\t\n", 123, null, undefined, {}, []];
  for (const bad of badNames) {
    assert.deepEqual(plain(model.createCounter(bad, 1)), { ok: false, reason: "invalid" });
  }
  assert.equal(model.count(), 0);
  // 长度边界：260 合法，261 非法
  assert.equal(model.createCounter("x".repeat(260), 1).ok, true);
  assert.deepEqual(plain(model.createCounter("y".repeat(261), 1)), { ok: false, reason: "invalid" });
  assert.equal(model.count(), 1);
});

test("createCounter 的 createdAt 归一化", () => {
  const model = newModel();
  const before = Date.now();
  const defaulted = model.createCounter("默认时间").counter;
  const nullNow = model.createCounter("空 now", null).counter;
  const afterFirst = Date.now();
  assert.ok(defaulted.createdAt >= before && defaulted.createdAt <= afterFirst);
  assert.ok(nullNow.createdAt >= before && nullNow.createdAt <= afterFirst);
  assert.equal(model.createCounter("小数", 1790000000000.9).counter.createdAt, 1790000000000);
  assert.equal(model.createCounter("零", 0).counter.createdAt, 0);
  assert.ok(model.createCounter("NaN now", NaN).counter.createdAt >= before);
  assert.ok(model.createCounter("负数 now", -5).counter.createdAt >= before);
});

test("createCounter 名字唯一且区分大小写", () => {
  const model = newModel();
  addCounter(model, "a");
  assert.deepEqual(plain(model.createCounter("a")), { ok: false, reason: "duplicate" });
  assert.deepEqual(plain(model.createCounter(" a ")), { ok: false, reason: "duplicate" });
  assert.equal(model.createCounter("A").ok, true);
  assert.equal(model.count(), 2);
});

test("最多 10 个计数器，第 11 个返回 limit", () => {
  const model = newModel();
  for (let i = 1; i <= 10; i++) {
    assert.equal(model.createCounter("画布-" + i).ok, true);
  }
  assert.equal(model.count(), 10);
  assert.deepEqual(plain(model.createCounter("画布-11")), { ok: false, reason: "limit" });
  assert.equal(model.count(), 10);
  // 删除一个后可以再创建
  const victim = model.findByName("画布-3");
  assert.equal(model.deleteCounter(victim.id).ok, true);
  assert.equal(model.createCounter("画布-11").ok, true);
  assert.equal(model.count(), 10);
});

test("findById / findByName 查找规则", () => {
  const model = newModel();
  const counter = addCounter(model, "画布A");
  assert.equal(model.findById(counter.id), counter);
  assert.equal(model.findById("不存在的id"), null);
  assert.equal(model.findById(null), null);
  assert.equal(model.findById(undefined), null);
  assert.equal(model.findByName("画布A"), counter);
  assert.equal(model.findByName("  画布A  "), counter); // 与创建规则一致：trim 后精确匹配
  assert.equal(model.findByName("画布a"), null);        // 区分大小写
  assert.equal(model.findByName("画布"), null);
  assert.equal(model.findByName(123), null);
});

test("count / getCounters 反映内部状态", () => {
  const model = newModel();
  assert.equal(model.count(), 0);
  assert.equal(model.getCounters().length, 0);
  const first = addCounter(model, "a");
  const second = addCounter(model, "b");
  assert.equal(model.count(), 2);
  assert.equal(model.getCounters().length, 2);
  assert.equal(model.getCounters()[0], first);
  assert.equal(model.getCounters()[1], second);
});

test("删除后新建的 id 不与历史 id 重复", () => {
  const model = newModel();
  const ids = [];
  for (let i = 1; i <= 10; i++) {
    ids.push(addCounter(model, "旧-" + i).id);
  }
  for (const counter of model.getCounters().slice()) {
    assert.equal(model.deleteCounter(counter.id).ok, true);
  }
  assert.equal(model.count(), 0);
  for (let i = 1; i <= 10; i++) {
    const id = addCounter(model, "新-" + i).id;
    assert.equal(ids.indexOf(id), -1, "新 id 不应与旧 id 重复：" + id);
    ids.push(id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("不同模型实例互不影响", () => {
  const first = newModel();
  const second = newModel();
  addCounter(first, "同名");
  assert.equal(first.count(), 1);
  assert.equal(second.count(), 0);
  assert.equal(second.findByName("同名"), null);
});

// =====================================================================
// 计数器模型：改名 / 加数 / 清空 / 删除 / 合并 / 快照
// =====================================================================

test("renameCounter 成功并去空白", () => {
  const model = newModel();
  const counter = addCounter(model, "旧名");
  const result = model.renameCounter(counter.id, "  新名  ");
  assert.equal(result.ok, true);
  assert.equal(result.counter, counter);
  assert.equal(counter.name, "新名");
  assert.equal(model.findByName("旧名"), null);
  assert.equal(model.findByName("新名"), counter);
});

test("renameCounter 失败分支", () => {
  const model = newModel();
  const first = addCounter(model, "a");
  const second = addCounter(model, "b");
  assert.deepEqual(plain(model.renameCounter("missing", "x")), { ok: false, reason: "missing" });
  assert.deepEqual(plain(model.renameCounter(first.id, "")), { ok: false, reason: "invalid" });
  assert.deepEqual(plain(model.renameCounter(first.id, "b")), { ok: false, reason: "duplicate" });
  assert.deepEqual(plain(model.renameCounter(first.id, " b ")), { ok: false, reason: "duplicate" });
  assert.equal(first.name, "a");
  assert.equal(second.name, "b");
  // 改成自己当前名字（含空白归一化）应成功
  assert.equal(model.renameCounter(first.id, " a ").ok, true);
  // 大小写不同算不同名字
  assert.equal(model.renameCounter(first.id, "A").ok, true);
  assert.equal(first.name, "A");
});

test("increment 基本累加", () => {
  const model = newModel();
  const counter = addCounter(model, "画布");
  assert.deepEqual(plain(model.increment(counter.id, 1)), { ok: true, added: 1, count: 1 });
  assert.deepEqual(plain(model.increment(counter.id, 4)), { ok: true, added: 4, count: 5 });
  assert.equal(counter.count, 5);
  assert.deepEqual(plain(model.increment("missing", 1)), { ok: false, reason: "missing" });
});

test("increment 封顶 1000 亿", () => {
  const model = newModel();
  const counter = addCounter(model, "画布");
  model.increment(counter.id, Core.MAX_STROKES - 5);
  assert.equal(counter.count, Core.MAX_STROKES - 5);
  assert.deepEqual(
    plain(model.increment(counter.id, 10)),
    { ok: true, added: 5, count: Core.MAX_STROKES }
  );
  assert.deepEqual(
    plain(model.increment(counter.id, 1)),
    { ok: true, added: 0, count: Core.MAX_STROKES }
  );
  // 一次增加超过上限：实际增加量为剩余空间
  const other = newModel();
  const maxCounter = addCounter(other, "画布2");
  assert.deepEqual(
    plain(other.increment(maxCounter.id, Core.MAX_STROKES + 999)),
    { ok: true, added: Core.MAX_STROKES, count: Core.MAX_STROKES }
  );
});

test("increment 参数边界", () => {
  const model = newModel();
  const counter = addCounter(model, "画布");
  assert.deepEqual(plain(model.increment(counter.id, 0)), { ok: true, added: 0, count: 0 });
  assert.deepEqual(plain(model.increment(counter.id, -3)), { ok: true, added: 0, count: 0 });
  assert.deepEqual(plain(model.increment(counter.id, 2.9)), { ok: true, added: 2, count: 2 });
  // 数值字符串与 bridge.js 的宽松 Number 转换一致
  assert.deepEqual(plain(model.increment(counter.id, "3")), { ok: true, added: 3, count: 5 });
  assert.deepEqual(plain(model.increment(counter.id, "abc")), { ok: true, added: 0, count: 5 });
  assert.deepEqual(plain(model.increment(counter.id, NaN)), { ok: true, added: 0, count: 5 });
  assert.deepEqual(plain(model.increment(counter.id, null)), { ok: true, added: 0, count: 5 });
});

test("clearCounter 清零", () => {
  const model = newModel();
  const counter = addCounter(model, "画布");
  model.increment(counter.id, 7);
  assert.deepEqual(plain(model.clearCounter(counter.id)), { ok: true });
  assert.equal(counter.count, 0);
  model.increment(counter.id, 2);
  assert.equal(counter.count, 2);
  // 契约只写了成功分支；不存在 id 返回 missing（host 应先解析存在性）
  assert.deepEqual(plain(model.clearCounter("missing")), { ok: false, reason: "missing" });
});

test("deleteCounter 删除", () => {
  const model = newModel();
  const first = addCounter(model, "a");
  const second = addCounter(model, "b");
  assert.deepEqual(plain(model.deleteCounter(first.id)), { ok: true });
  assert.equal(model.count(), 1);
  assert.equal(model.findById(first.id), null);
  assert.equal(model.findById(second.id), second);
  assert.deepEqual(plain(model.deleteCounter(first.id)), { ok: false, reason: "missing" });
});

test("mergeCounterInto 合并计数并删除源", () => {
  const model = newModel();
  const source = addCounter(model, "源");
  const target = addCounter(model, "目标");
  model.increment(source.id, 7);
  model.increment(target.id, 5);
  assert.deepEqual(plain(model.mergeCounterInto(source.id, target.id)), { ok: true, count: 12 });
  assert.equal(target.count, 12);
  assert.equal(model.count(), 1);
  assert.equal(model.findById(source.id), null);
  assert.equal(model.findByName("源"), null);
  assert.equal(model.findByName("目标"), target);
});

test("mergeCounterInto 封顶 1000 亿", () => {
  const model = newModel();
  const source = addCounter(model, "源");
  const target = addCounter(model, "目标");
  model.increment(source.id, 10);
  model.increment(target.id, Core.MAX_STROKES - 3);
  assert.deepEqual(
    plain(model.mergeCounterInto(source.id, target.id)),
    { ok: true, count: Core.MAX_STROKES }
  );
  assert.equal(target.count, Core.MAX_STROKES);
  assert.equal(model.count(), 1);
});

test("mergeCounterInto 失败分支", () => {
  const model = newModel();
  const first = addCounter(model, "a");
  const second = addCounter(model, "b");
  assert.deepEqual(plain(model.mergeCounterInto("missing", second.id)), { ok: false, reason: "missing" });
  assert.deepEqual(plain(model.mergeCounterInto(first.id, "missing")), { ok: false, reason: "missing" });
  // 合并到自己：拒绝，避免把自身删掉
  assert.deepEqual(plain(model.mergeCounterInto(first.id, first.id)), { ok: false, reason: "invalid" });
  assert.equal(model.count(), 2);
});

test("snapshot 结构与副本隔离", () => {
  const model = newModel();
  const first = addCounter(model, "画布A", 1000);
  model.increment(first.id, 3);
  const second = addCounter(model, "画布B", 2000);
  const snapshot = model.snapshot();
  assert.deepEqual(plain(snapshot), {
    counters: [
      { id: first.id, name: "画布A", count: 3, createdAt: 1000 },
      { id: second.id, name: "画布B", count: 0, createdAt: 2000 }
    ],
    maxCounters: 10,
    maxStrokes: 100000000000
  });
  // 快照是副本：修改不影响模型
  assert.notEqual(snapshot.counters, model.getCounters());
  assert.notEqual(snapshot.counters[0], first);
  snapshot.counters[0].count = 999;
  snapshot.counters.push({ id: "fake", name: "fake", count: 1, createdAt: 1 });
  assert.equal(first.count, 3);
  assert.equal(model.count(), 2);
});

// =====================================================================
// 持久化行格式
// =====================================================================

test("serialize 空模型为仅文件头且末尾换行", () => {
  assert.equal(newModel().serialize(), "#AOWU-COUNT v1\n");
});

test("serialize 行结构符合契约", () => {
  const model = newModel();
  const counter = addCounter(model, "画布 1", 1790000000000);
  model.increment(counter.id, 42);
  const text = model.serialize();
  assert.ok(text.length > 0);
  assert.equal(text.charAt(text.length - 1), "\n");
  const lines = text.split("\n");
  assert.equal(lines[0], "#AOWU-COUNT v1");
  assert.equal(lines[lines.length - 1], ""); // 末尾换行产生的空行
  const columns = lines[1].split("\t");
  assert.equal(columns.length, 4);
  assert.equal(columns[0], counter.id);
  assert.equal(columns[1], "42");
  assert.equal(columns[2], "1790000000000");
  assert.equal(decodeURIComponent(columns[3]), "画布 1");
});

test("serialize / loadFromText 往返一致", () => {
  const names = ["未命名-1", "引号\"名字", "反斜杠\\名字", "制表\t名字", "换行\n名字", "100% 完成"];
  const model = newModel();
  for (let i = 0; i < names.length; i++) {
    const counter = addCounter(model, names[i], 1790000000000 + i);
    model.increment(counter.id, i * 3);
  }
  const text = model.serialize();
  const before = plain(model.snapshot());
  const reloaded = newModel();
  const result = reloaded.loadFromText(text);
  assert.equal(result.ok, true);
  assert.deepEqual(plain(reloaded.snapshot()), before);
  // 再序列化完全一致（格式稳定）
  assert.equal(reloaded.serialize(), text);
  assert.equal(result.errors.length, 0);
});

test("loadFromText 空文本与仅文件头返回空模型", () => {
  const texts = ["", "#AOWU-COUNT v1\n", "\n\n# 随便一段注释\n"];
  for (const text of texts) {
    const model = newModel();
    addCounter(model, "已有");
    const result = model.loadFromText(text);
    assert.equal(result.ok, true);
    assert.equal(model.count(), 0);
    assert.deepEqual(plain(result.counters), []);
    assert.deepEqual(plain(result.errors), []);
  }
});

test("loadFromText 无文件头也可解析", () => {
  const model = newModel();
  const result = model.loadFromText("c1\t5\t1700000000000\t%E7%94%BB%E5%B8%83\n");
  assert.equal(result.ok, true);
  const counters = model.getCounters();
  assert.equal(counters.length, 1);
  assert.equal(counters[0].id, "c1");
  assert.equal(counters[0].name, "画布");
  assert.equal(counters[0].count, 5);
  assert.equal(counters[0].createdAt, 1700000000000);
});

test("loadFromText 跳过空行、空白行与注释行（含 CRLF）", () => {
  const text = "#AOWU-COUNT v1\r\n\r\n   \r\n# 我是注释\r\nc1\t2\t1000\tname1\r\n\r\nc2\t3\t1001\tname2\r\n";
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 2);
  assert.equal(model.findById("c1").count, 2);
  assert.equal(model.findById("c2").count, 3);
  assert.equal(result.errors.length, 0);
});

test("loadFromText 容忍 UTF-8 BOM", () => {
  const model = newModel();
  const result = model.loadFromText("\uFEFF#AOWU-COUNT v1\nc1\t1\t1000\tbom\n");
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findById("c1").name, "bom");
});

test("loadFromText 要求至少 4 列，多余列忽略", () => {
  const text = [
    "c1\t1\t1000",                          // 3 列（坏行）
    "c2\t2\t1001\tfull\textra\tmore"        // 多余列 -> 只取前 4 列
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findById("c1"), null);
  assert.equal(model.findById("c2").name, "full");
  assert.ok(plain(result.errors).some((item) => item.indexOf("bad_columns") >= 0));
});

test("loadFromText 对 count 做 clampCount", () => {
  const text = [
    "#AOWU-COUNT v1",
    "a\t99999999999999\t1000\thuge",
    "b\t-5\t1000\tneg",
    "c\tabc\t1000\tbad",
    "d\t12.9\t1000\tfloat"
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 4);
  assert.equal(model.findById("a").count, Core.MAX_STROKES);
  assert.equal(model.findById("b").count, 0);
  assert.equal(model.findById("c").count, 0);
  assert.equal(model.findById("d").count, 12);
  // 序列化输出的是封顶后的值
  const reloaded = newModel();
  reloaded.loadFromText(model.serialize());
  assert.equal(reloaded.findById("a").count, Core.MAX_STROKES);
});

test("loadFromText 的 createdAt 缺失或非法时用当前时间", () => {
  const text = [
    "#AOWU-COUNT v1",
    "a\t1\t\tblank",
    "b\t1\tabc\tbad",
    "c\t1\t1700000000000\tok",
    "d\t1\t-5\tnegative"
  ].join("\n");
  const before = Date.now();
  const model = newModel();
  const result = model.loadFromText(text);
  const after = Date.now();
  assert.equal(result.ok, true);
  for (const id of ["a", "b", "d"]) {
    const createdAt = model.findById(id).createdAt;
    assert.ok(createdAt >= before && createdAt <= after, id + " 的 createdAt 应回退为当前时间");
  }
  assert.equal(model.findById("c").createdAt, 1700000000000);
});

test("loadFromText 重复 id 丢弃后者", () => {
  const text = [
    "#AOWU-COUNT v1",
    "same\t5\t1000\tfirst",
    "same\t9\t1001\tsecond"
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findById("same").name, "first");
  assert.equal(model.findById("same").count, 5);
  assert.ok(plain(result.errors).some((item) => item.indexOf("duplicate_id") >= 0));
});

test("loadFromText 重复名字合并到先出现者", () => {
  const text = [
    "#AOWU-COUNT v1",
    "a\t5\t1000\t同名",
    "b\t7\t1001\t同名",
    "c\t1\t1002\t另一个"
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 2);
  assert.equal(model.findById("a").count, 12);
  assert.equal(model.findById("b"), null);
  assert.equal(model.findByName("同名").id, "a");
  assert.ok(plain(result.errors).some((item) => item.indexOf("duplicate_name_merged") >= 0));
});

test("loadFromText 重复名字合并时封顶 1000 亿", () => {
  const text = [
    "#AOWU-COUNT v1",
    "a\t" + Core.MAX_STROKES + "\t1000\t同名",
    "b\t" + Core.MAX_STROKES + "\t1001\t同名"
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findById("a").count, Core.MAX_STROKES);
});

test("loadFromText 超过 10 个丢弃多余", () => {
  const lines = ["#AOWU-COUNT v1"];
  for (let i = 1; i <= 11; i++) {
    lines.push("c" + i + "\t" + i + "\t" + (1700000000000 + i) + "\tname-" + i);
  }
  const model = newModel();
  const result = model.loadFromText(lines.join("\n"));
  assert.equal(result.ok, true);
  assert.equal(model.count(), 10);
  assert.equal(model.findById("c10").count, 10);
  assert.equal(model.findById("c11"), null);
  assert.ok(plain(result.errors).some((item) => item.indexOf("limit") >= 0));
});

test("loadFromText 丢弃非法名字行", () => {
  const longName = "x".repeat(261);
  const text = [
    "#AOWU-COUNT v1",
    "a\t1\t1000\t%20%20",                     // 解码后全是空白
    "b\t1\t1000\t",                           // 空名字（同时缺列）
    "c\t1\t1000\t" + encodeURIComponent(longName),
    "d\t1\t1000\t%E0%A4%A"                    // 非法百分号编码
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 0);
  assert.ok(plain(result.errors).length >= 4);
});

test("loadFromText 丢弃非法 id 与坏行", () => {
  const text = [
    "#AOWU-COUNT v1",
    "\t5\t1000\t空id",
    "c1\t1\t1000",
    "  c2\t2\t1001\t带空格id"
  ].join("\n");
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findById("c2").count, 2);
  assert.ok(plain(result.errors).length >= 1);
});

test("loadFromText 拒绝未知版本文件头且不破坏已有数据", () => {
  const model = newModel();
  addCounter(model, "保留");
  const result = model.loadFromText("#AOWU-COUNT v2\nc1\t1\t1000\tx\n");
  assert.equal(result.ok, false);
  assert.deepEqual(plain(result.errors), ["unsupported_version:2"]);
  assert.equal(model.count(), 1);
  assert.equal(model.findByName("保留").name, "保留");
});

test("loadFromText 非字符串输入返回失败且不抛异常", () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    const model = newModel();
    addCounter(model, "保留");
    assert.doesNotThrow(() => model.loadFromText(bad));
    const result = model.loadFromText(bad);
    assert.equal(result.ok, false);
    assert.ok(plain(result.errors).length > 0);
    assert.equal(model.count(), 1);
  }
});

test("loadFromText 成功时整体替换旧数据", () => {
  const model = newModel();
  addCounter(model, "旧1");
  addCounter(model, "旧2");
  const result = model.loadFromText("#AOWU-COUNT v1\nnew1\t1\t1000\t新1\n");
  assert.equal(result.ok, true);
  assert.equal(model.count(), 1);
  assert.equal(model.findByName("旧1"), null);
  assert.equal(model.findById("new1").name, "新1");
});

test("loadFromText 返回 ok / counters / errors 结构", () => {
  const model = newModel();
  const result = model.loadFromText("#AOWU-COUNT v1\nc1\t1\t1000\ta\n");
  assert.equal(result.ok, true);
  assert.equal(Array.isArray(result.counters), true);
  assert.equal(Array.isArray(result.errors), true);
  assert.equal(result.counters.length, 1);
  assert.equal(result.errors.length, 0);
  // 返回内部数组，供 host 只读使用
  assert.equal(result.counters, model.getCounters());
});

test("loadFromText 保留文件顺序", () => {
  const text = "#AOWU-COUNT v1\nc3\t3\t1000\t三\nc1\t1\t1001\t一\nc2\t2\t1002\t二\n";
  const model = newModel();
  const result = model.loadFromText(text);
  assert.equal(result.ok, true);
  const counters = model.getCounters();
  assert.equal(counters[0].id, "c3");
  assert.equal(counters[1].id, "c1");
  assert.equal(counters[2].id, "c2");
});

test("loadFromText 名字区分大小写可共存", () => {
  const model = newModel();
  const result = model.loadFromText("#AOWU-COUNT v1\nc1\t1\t1000\tName\nc2\t2\t1001\tname\n");
  assert.equal(result.ok, true);
  assert.equal(model.count(), 2);
  assert.equal(model.findByName("Name").id, "c1");
  assert.equal(model.findByName("name").id, "c2");
});

// =====================================================================
// 检测器：历史状态 ID 高水位
// =====================================================================

test("ensureDoc 首次返回 true、重复返回 false", () => {
  const detector = Core.createDetector();
  assert.equal(detector.ensureDoc(74, 100, PAINTS), true);
  assert.equal(detector.ensureDoc(74, 100, PAINTS), false);
  assert.equal(detector.watermark(74), 100);
});

test("ensureDoc 建立基线，基线内状态不计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  const result = detector.scanTail(1, [state(99, "画笔工具"), state(100, "画笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 0, newStateIds: [], watermark: 100 });
  assert.equal(detector.watermark(1), 100);
});

test("单笔新状态计数 1", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  const result = detector.scanTail(1, [state(100, "新建图层"), state(101, "画笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 1, newStateIds: [101], watermark: 101 });
});

test("撤销回到旧状态不计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  // 撤销：当前历史状态回到 100，历史列表里仍然有 101
  const undo = detector.scanTail(1, [state(100, "新建图层"), state(101, "画笔工具")]);
  assert.deepEqual(plain(undo), { newStrokeCount: 0, newStateIds: [], watermark: 101 });
});

test("重做不重复计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  // 重做只是切回旧 ID，不会产生 > watermark 的状态
  const redo = detector.scanTail(1, [state(101, "画笔工具")]);
  assert.deepEqual(plain(redo), { newStrokeCount: 0, newStateIds: [], watermark: 101 });
});

test("撤销后继续画会得到新 ID 并计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  // 撤销后没有新状态
  assert.equal(detector.scanTail(1, [state(100, "新建图层")]).newStrokeCount, 0);
  // 继续画一笔：新操作分配新 ID 102
  const result = detector.scanTail(1, [state(100, "新建图层"), state(102, "画笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 1, newStateIds: [102], watermark: 102 });
});

test("一次 tick 之间多笔逐笔计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 500, PAINTS);
  const tail = [state(501, "画笔工具"), state(502, "铅笔工具"), state(503, "画笔工具")];
  const result = detector.scanTail(1, tail);
  assert.deepEqual(plain(result), { newStrokeCount: 3, newStateIds: [501, 502, 503], watermark: 503 });

  // 契约上限场景：tail 最多 8 条，8 笔都能逐笔计数
  const detector2 = Core.createDetector();
  detector2.ensureDoc(2, 0, PAINTS);
  const eight = [];
  for (let i = 1; i <= 8; i++) { eight.push(state(i, "画笔工具")); }
  const result2 = detector2.scanTail(2, eight);
  assert.equal(result2.newStrokeCount, 8);
  assert.equal(result2.watermark, 8);
});

test("非画笔新状态只抬水位、不计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 200, PAINTS);
  const result = detector.scanTail(1, [
    state(201, "新建图层"),
    state(202, "滤镜"),
    state(203, "画笔工具")
  ]);
  assert.deepEqual(plain(result), { newStrokeCount: 1, newStateIds: [201, 202, 203], watermark: 203 });
  // 后续非画笔状态
  const more = detector.scanTail(1, [state(204, "调整图层")]);
  assert.deepEqual(plain(more), { newStrokeCount: 0, newStateIds: [204], watermark: 204 });
});

test("混合新状态：newStateIds 含全部新状态，计数只算画笔", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 10, PAINTS);
  const result = detector.scanTail(1, [
    state(11, "新建图层"),
    state(12, "画笔工具"),
    state(13, "铅笔工具"),
    state(14, "滤镜")
  ]);
  assert.deepEqual(plain(result), { newStrokeCount: 2, newStateIds: [11, 12, 13, 14], watermark: 14 });
});

test("画笔名精确匹配（区分大小写、不去空白）", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 0, ["画笔工具", "Brush Tool"]);
  assert.equal(detector.scanTail(1, [state(1, "画笔工具 ")]).newStrokeCount, 0);
  assert.equal(detector.scanTail(1, [state(2, "brush tool")]).newStrokeCount, 0);
  assert.equal(detector.scanTail(1, [state(3, "Brush Tool")]).newStrokeCount, 1);
  assert.equal(detector.scanTail(1, [state(4, "画笔工具")]).newStrokeCount, 1);
  assert.equal(detector.watermark(1), 4);
});

test("多文档检测互相隔离", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  detector.ensureDoc(2, 500, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  assert.equal(detector.scanTail(2, [state(501, "铅笔工具")]).newStrokeCount, 1);
  assert.equal(detector.scanTail(2, [state(502, "新建图层")]).newStrokeCount, 0);
  assert.equal(detector.scanTail(1, [state(102, "新建图层")]).newStrokeCount, 0);
  assert.equal(detector.watermark(1), 102);
  assert.equal(detector.watermark(2), 502);
});

test("docId 数字与字符串指向同一文档", () => {
  const detector = Core.createDetector();
  assert.equal(detector.ensureDoc(74, 100, PAINTS), true);
  assert.equal(detector.watermark("74"), 100);
  const result = detector.scanTail("74", [state(101, "画笔工具")]);
  assert.equal(result.newStrokeCount, 1);
  assert.equal(detector.watermark(74), 101);
});

test("历史记录剪枝后新状态仍正常计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  // 历史达到上限后，旧状态被剪掉，tail 只剩新状态
  assert.equal(detector.scanTail(1, [state(102, "画笔工具")]).newStrokeCount, 1);
  const result = detector.scanTail(1, [state(103, "画笔工具"), state(104, "铅笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 2, newStateIds: [103, 104], watermark: 104 });
});

test("watermark 单调递增，重复 ensureDoc 不回退", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  detector.scanTail(1, [state(101, "画笔工具")]);
  detector.scanTail(1, [state(103, "画笔工具")]);
  assert.equal(detector.watermark(1), 103);
  // 用更小的基线重复 ensureDoc：不覆盖已建立的水位
  assert.equal(detector.ensureDoc(1, 50, PAINTS), false);
  assert.equal(detector.watermark(1), 103);
  // 继续画，水位继续单调上升
  const result = detector.scanTail(1, [state(104, "画笔工具")]);
  assert.equal(result.newStrokeCount, 1);
  assert.equal(result.watermark, 104);
});

test("tail 乱序时仍按 id > watermark 过滤并取最大 id", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  const result = detector.scanTail(1, [
    state(103, "画笔工具"),
    state(102, "画笔工具"),
    state(104, "画笔工具")
  ]);
  assert.deepEqual(plain(result), { newStrokeCount: 3, newStateIds: [103, 102, 104], watermark: 104 });
});

test("tail 中重复 id 只处理一次", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  const result = detector.scanTail(1, [
    state(101, "画笔工具"),
    state(101, "画笔工具"),
    state(102, "画笔工具")
  ]);
  assert.deepEqual(plain(result), { newStrokeCount: 2, newStateIds: [101, 102], watermark: 102 });
});

test("忽略非法 tail 项", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  const result = detector.scanTail(1, [
    null,
    undefined,
    5,
    "x",
    { name: "画笔工具" },
    { id: "105", name: "画笔工具" },
    { id: NaN, name: "画笔工具" },
    state(103, "画笔工具")
  ]);
  assert.deepEqual(plain(result), { newStrokeCount: 1, newStateIds: [103], watermark: 103 });
});

test("tailStates 非数组时安全返回", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.deepEqual(plain(detector.scanTail(1, null)), { newStrokeCount: 0, newStateIds: [], watermark: 100 });
});

test("空画笔名单：只抬水位不计数", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(3, 10, []);
  const result = detector.scanTail(3, [state(11, "画笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 0, newStateIds: [11], watermark: 11 });
});

test("ensureDoc 过滤非法画笔名并去重", () => {
  const detector = Core.createDetector();
  assert.equal(detector.ensureDoc(4, 0, ["画笔工具", 123, null, "", "画笔工具"]), true);
  assert.equal(detector.scanTail(4, [state(1, "画笔工具")]).newStrokeCount, 1);
  assert.equal(detector.scanTail(4, [state(2, "铅笔工具")]).newStrokeCount, 0);
});

test("scanTail 未见过的文档返回零结果", () => {
  const detector = Core.createDetector();
  const result = detector.scanTail(999, [state(1, "画笔工具")]);
  assert.deepEqual(plain(result), { newStrokeCount: 0, newStateIds: [], watermark: 0 });
  assert.equal(detector.watermark(999), 0);
});

test("forgetDoc 清理后可重新建立基线", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  assert.equal(detector.scanTail(1, [state(101, "画笔工具")]).newStrokeCount, 1);
  assert.equal(detector.forgetDoc(1), true);
  assert.equal(detector.watermark(1), 0);
  // 未建档时扫描安全返回零
  assert.deepEqual(plain(detector.scanTail(1, [state(102, "画笔工具")])), {
    newStrokeCount: 0,
    newStateIds: [],
    watermark: 0
  });
  // 面板重开/文档重新打开后重新建基线
  assert.equal(detector.ensureDoc(1, 200, PAINTS), true);
  const result = detector.scanTail(1, [state(201, "画笔工具")]);
  assert.equal(result.newStrokeCount, 1);
  assert.equal(result.watermark, 201);
});

test("forgetDoc 未见过的文档返回 false 且无副作用", () => {
  const detector = Core.createDetector();
  assert.equal(detector.forgetDoc(123), false);
  assert.equal(detector.watermark(123), 0);
});

test("detector.snapshot 返回 docs 副本", () => {
  const detector = Core.createDetector();
  detector.ensureDoc(1, 100, PAINTS);
  detector.ensureDoc(2, 500, PAINTS);
  detector.scanTail(1, [state(101, "画笔工具")]);
  detector.scanTail(2, [state(501, "铅笔工具")]);
  const snapshot = detector.snapshot();
  assert.deepEqual(plain(snapshot), {
    docs: {
      "1": { watermark: 101 },
      "2": { watermark: 501 }
    }
  });
  // 修改快照不影响检测器
  snapshot.docs["1"].watermark = 9999;
  assert.equal(detector.watermark(1), 101);
});

test("ensureDoc 对非法 lastStateId 归零", () => {
  const detector = Core.createDetector();
  assert.equal(detector.ensureDoc(1, NaN, PAINTS), true);
  assert.equal(detector.ensureDoc(2, "100", PAINTS), true);
  assert.equal(detector.ensureDoc(3, -5, PAINTS), true);
  assert.equal(detector.ensureDoc(4, undefined, PAINTS), true);
  assert.equal(detector.watermark(1), 0);
  assert.equal(detector.watermark(2), 0);
  assert.equal(detector.watermark(3), 0);
  assert.equal(detector.watermark(4), 0);
  const result = detector.scanTail(1, [state(1, "画笔工具")]);
  assert.equal(result.newStrokeCount, 1);
});

test("模拟 host 多次 tick 的完整流程", () => {
  const model = newModel();
  const detector = Core.createDetector();
  const docId = 74;
  const counter = model.createCounter("未命名-1", 1700000000000).counter;

  function tick(tail) {
    const result = detector.scanTail(docId, tail);
    if (result.newStrokeCount > 0) {
      model.increment(counter.id, result.newStrokeCount);
    }
    return result.newStrokeCount;
  }

  // 首次看到文档：基线 = 最后一个历史状态 ID
  detector.ensureDoc(docId, 100, PAINTS);

  // 一次 tick 内画了 3 笔
  assert.equal(tick([state(101, "画笔工具"), state(102, "铅笔工具"), state(103, "画笔工具")]), 3);
  assert.equal(counter.count, 3);

  // 撤销 1 次、再重做：都不增加
  assert.equal(tick([state(101, "画笔工具"), state(102, "铅笔工具"), state(103, "画笔工具")]), 0);
  assert.equal(counter.count, 3);

  // 新建图层（非画笔）：只抬水位
  assert.equal(tick([state(102, "铅笔工具"), state(103, "画笔工具"), state(104, "新建图层")]), 0);
  assert.equal(detector.watermark(docId), 104);

  // 撤销后继续画：新 ID 105 计入
  assert.equal(tick([state(103, "画笔工具"), state(105, "画笔工具")]), 1);
  assert.equal(counter.count, 4);

  // 再快速画 2 笔
  assert.equal(tick([state(106, "画笔工具"), state(107, "画笔工具")]), 2);
  assert.equal(counter.count, 6);

  // 历史剪枝后旧状态消失，新状态仍 > 水位
  assert.equal(tick([state(108, "铅笔工具")]), 1);
  assert.equal(counter.count, 7);
  assert.equal(detector.watermark(docId), 108);

  // 第二个文档独立计数
  const secondDocId = 75;
  const secondCounter = model.createCounter("未命名-2", 1700000000001).counter;
  detector.ensureDoc(secondDocId, 500, PAINTS);
  const secondResult = detector.scanTail(secondDocId, [state(501, "铅笔工具")]);
  assert.equal(secondResult.newStrokeCount, 1);
  model.increment(secondCounter.id, secondResult.newStrokeCount);
  assert.equal(secondCounter.count, 1);
  assert.equal(counter.count, 7);
  assert.equal(detector.watermark(secondDocId), 501);

  // 保存的计数不会超过上限
  assert.equal(model.snapshot().counters.length, 2);
});

// =====================================================================
// 加载方式、ES3 约束与静态检查
// =====================================================================

test("vm 沙箱：全局变量与 module.exports 双通道暴露", () => {
  const sandbox = loadSandbox();
  assert.equal(typeof sandbox.AowuCounterCore.createModel, "function");
  assert.equal(typeof sandbox.AowuCounterCore.createDetector, "function");
  assert.equal(sandbox.module.exports, sandbox.AowuCounterCore);
  assert.equal(sandbox.module.exports.MAX_COUNTERS, 10);
});

test("vm 沙箱：没有 module 时只保留全局 AowuCounterCore", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(CORE_SOURCE, sandbox, { filename: CORE_PATH });
  assert.equal(typeof sandbox.AowuCounterCore.jsonStringify, "function");
  assert.equal(typeof sandbox.module, "undefined");
});

test("无 JSON 全局的环境仍可运行（不依赖 JSON）", () => {
  const sandbox = loadSandbox({ JSON: undefined });
  assert.equal(vm.runInContext("typeof JSON", sandbox), "undefined");
  const CoreInSandbox = sandbox.module.exports;
  const model = CoreInSandbox.createModel();
  const counter = model.createCounter("画布").counter;
  model.increment(counter.id, 2);
  const parsed = JSON.parse(CoreInSandbox.jsonStringify(model.snapshot()));
  assert.equal(parsed.counters[0].name, "画布");
  assert.equal(parsed.counters[0].count, 2);
  assert.equal(CoreInSandbox.formatNumber(12345), "12,345");
  assert.equal(CoreInSandbox.clampCount(-1), 0);
  // 序列化 / 反序列化在无 JSON 环境下也正常
  const reloaded = CoreInSandbox.createModel();
  assert.equal(reloaded.loadFromText(model.serialize()).ok, true);
});

test("Node require 未知扩展名加载（当前方式：" + LOAD_MODE + "）", (t) => {
  if (LOAD_MODE !== "require") {
    t.skip("当前 Node 不支持未知扩展名 require，主加载已回退 vm 沙箱");
    return;
  }
  const viaRequire = require(CORE_PATH);
  assert.equal(typeof viaRequire.createModel, "function");
  assert.equal(typeof viaRequire.createDetector, "function");
  assert.equal(viaRequire.MAX_STROKES, Core.MAX_STROKES);
});

test("静态检查：core.jsx 不含 ES6+ 语法 / ES5 依赖", () => {
  const forbidden = [
    ["let 声明", /(^|[^A-Za-z0-9_$.])let\s+[A-Za-z_$]/],
    ["const 声明", /(^|[^A-Za-z0-9_$.])const\s+[A-Za-z_$]/],
    ["class 声明", /\bclass\s+[A-Za-z_$]/],
    ["箭头函数", /=>/],
    ["模板字符串反引号", /`/],
    ["Promise", /\bPromise\b/],
    ["require 调用", /\brequire\s*\(/],
    ["JSON 全局调用", /\bJSON\s*[.[]/],
    ["ES5 数组/字符串方法", /\.(forEach|map|filter|reduce|some|every|trim|keys|assign|freeze|create|defineProperty)\s*\(/]
  ];
  for (const [label, pattern] of forbidden) {
    assert.doesNotMatch(CORE_CODE, pattern, "core.jsx 不应出现：" + label);
  }
});

test("静态检查：core.jsx 含契约要求的模块导出兜底", () => {
  assert.match(CORE_SOURCE, /var AowuCounterCore = \(function \(\) \{/);
  assert.match(
    CORE_SOURCE,
    /if \(typeof module !== "undefined" && module\.exports\) \{ module\.exports = AowuCounterCore; \}/
  );
});

test("静态检查：core.jsx 以 UTF-8 BOM 保存（ExtendScript 可正确读取中文注释）", () => {
  assert.equal(CORE_SOURCE.charCodeAt(0), 0xfeff, "core.jsx 应以 UTF-8 BOM 开头");
  // 文件能按 UTF-8 无替换字符地读出
  assert.equal(CORE_SOURCE.indexOf("\ufffd"), -1, "core.jsx 含非法 UTF-8 字节");
});

test("静态检查：去掉注释后 core.jsx 为纯 ASCII（字符串字面量不依赖文件编码）", () => {
  assert.doesNotMatch(CORE_CODE, /[^\x00-\x7f]/, "代码与字符串应保持 ASCII，中文只出现在注释里");
});

test("静态检查：core.jsx 不含 Photoshop / DOM API", () => {
  const forbidden = [
    /\bActionReference\b/,
    /\bActionDescriptor\b/,
    /\bexecuteAction\b/,
    /\bstringIDToTypeID\b/,
    /\bcharIDToTypeID\b/,
    /\bapp\.(activeDocument|documents)\b/,
    /\bScriptUI\b/,
    /\bdocument\.getElementById\b/,
    /\bwindow\./
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(CORE_CODE, pattern, "core.jsx 不应依赖：" + pattern);
  }
});
