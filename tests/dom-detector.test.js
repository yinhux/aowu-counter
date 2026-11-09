// 嗷呜计数 — dom-detector.jsx 单元测试（Node 内置 node:test）
// 覆盖：纯追加 / 撤销后新画 / 历史记录剪枝 / 深度撤销后新画 / 多笔 / 非画笔状态。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const file = path.join(__dirname, '..', 'jsx', 'dom-detector.jsx');
const code = fs.readFileSync(file, 'utf8');
const sandbox = {};
vm.runInNewContext(code + '\n;this.AowuCounterDomDetector = AowuCounterDomDetector;', sandbox, { filename: 'dom-detector.jsx' });
const D = sandbox.AowuCounterDomDetector;
const PAINT = ['画笔工具', '铅笔工具'];

function tk(n) {
  const out = [];
  for (let i = 0; i < n; i++) { out.push({ id: i }); }
  return out;
}

test('diffTokenLists: 相同列表无新增', () => {
  const a = tk(3);
  const d = D.diffTokenLists(a, a.slice());
  assert.strictEqual(d.added, 0);
  assert.strictEqual(d.newStart, 3);
});

test('diffTokenLists: 纯追加', () => {
  const prev = tk(3);
  const cur = prev.concat([{ id: 3 }]);
  const d = D.diffTokenLists(prev, cur);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.newStart, 3);
  assert.strictEqual(d.offset, 0);
});

test('diffTokenLists: 撤销后新画（截断后追加）', () => {
  const prev = tk(5);
  const cur = prev.slice(0, 3).concat([{ id: 99 }]);
  const d = D.diffTokenLists(prev, cur);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.newStart, 3);
  assert.strictEqual(d.offset, 0);
});

test('diffTokenLists: 历史记录剪枝（头部丢弃 + 末尾追加）', () => {
  const prev = tk(10);
  const cur = prev.slice(1).concat([{ id: 99 }]);
  const d = D.diffTokenLists(prev, cur);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.offset, 1);
  assert.strictEqual(d.matched, 9);
});

test('diffTokenLists: 深度撤销后新画（完整 prev 列表可对齐）', () => {
  const prev = tk(100);
  const cur = prev.slice(0, 64).concat([{ id: 99 }]);
  const d = D.diffTokenLists(prev, cur);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.newStart, 64);
});

test('diffTokenLists: 一次 tick 内多笔', () => {
  const prev = tk(4);
  const cur = prev.concat([{ id: 90 }, { id: 91 }, { id: 92 }]);
  const d = D.diffTokenLists(prev, cur);
  assert.strictEqual(d.added, 3);
});

test('detector: 基线不计数，追加按名称计数', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(2);
  assert.strictEqual(det.ensureDoc(1, base), true);
  assert.strictEqual(det.ensureDoc(1, base), false);
  const r = det.appendStates(1, [{ id: 10 }, { id: 11 }], ['画笔工具', '新建图层']);
  assert.strictEqual(r.newStrokeCount, 1);
  assert.strictEqual(r.added, 2);
});

test('detector: 铅笔也计数', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  det.ensureDoc(2, tk(2));
  const r = det.appendStates(2, [{ id: 20 }], ['铅笔工具']);
  assert.strictEqual(r.newStrokeCount, 1);
});

test('detector: scanFull 撤销后新画', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(5);
  det.ensureDoc(3, base);
  const cur = base.slice(0, 3).concat([{ id: 99 }]);
  const r = det.scanFull(3, cur, ['新建', '新建', '画笔工具', '画笔工具']);
  assert.strictEqual(r.newStrokeCount, 1);
  assert.strictEqual(r.newStart, 3);
});

test('detector: scanFull 剪枝', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(10);
  det.ensureDoc(4, base);
  const cur = base.slice(1).concat([{ id: 99 }]);
  const names = new Array(10).fill('新建图层');
  names[9] = '画笔工具';
  const r = det.scanFull(4, cur, names);
  assert.strictEqual(r.newStrokeCount, 1);
  assert.strictEqual(r.offset, 1);
});

test('detector: 非画笔状态只推进、不计数', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(2);
  det.ensureDoc(5, base);
  const r = det.appendStates(5, [{ id: 30 }, { id: 31 }], ['新建图层', '高斯模糊']);
  assert.strictEqual(r.newStrokeCount, 0);
  const r2 = det.scanFull(5, base.concat([{ id: 30 }, { id: 31 }]), ['新建', '新建', '新建图层', '高斯模糊']);
  assert.strictEqual(r2.newStrokeCount, 0);
});

test('detector: 撤销/重做不产生新 token → 无计数', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(4);
  det.ensureDoc(6, base);
  // 撤销/重做只改 active，tokens 不变；host 不会调用 scan，这里验证 diff 结果为 0
  const d = D.diffTokenLists(base, base.slice());
  assert.strictEqual(d.added, 0);
  const r = det.scanFull(6, base.slice(), ['画笔工具', '画笔工具', '画笔工具', '画笔工具']);
  assert.strictEqual(r.newStrokeCount, 0);
});

test('detector: forgetDoc 后重新基线', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  det.ensureDoc(7, tk(3));
  assert.strictEqual(det.forgetDoc(7), true);
  assert.strictEqual(det.forgetDoc(7), false);
  const r = det.scanFull(7, tk(3), ['画笔工具', '画笔工具', '画笔工具']);
  assert.strictEqual(r.newStrokeCount, 0);
  assert.strictEqual(det.ensureDoc(7, tk(3)), true);
});

test('detector: 多文档隔离', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  det.ensureDoc(8, tk(2));
  det.ensureDoc(9, tk(5));
  const r8 = det.appendStates(8, [{ id: 80 }], ['画笔工具']);
  assert.strictEqual(r8.newStrokeCount, 1);
  const r9 = det.appendStates(9, [{ id: 90 }], ['新建图层']);
  assert.strictEqual(r9.newStrokeCount, 0);
});

test('detector: 画笔名称集合可更新（本地化）', () => {
  const det = D.createDetector();
  det.setPaintNames(['Brush Tool']);
  det.ensureDoc(10, tk(1));
  let r = det.appendStates(10, [{ id: 100 }], ['Brush Tool']);
  assert.strictEqual(r.newStrokeCount, 1);
  r = det.appendStates(10, [{ id: 101 }], ['画笔工具']);
  assert.strictEqual(r.newStrokeCount, 0);
});

test('detector: appendStatesAtCap 头部剪枝 + 尾部追加（性能快速路径）', () => {
  const det = D.createDetector();
  det.setPaintNames(PAINT);
  const base = tk(5);
  det.ensureDoc(9, base);
  const r = det.appendStatesAtCap(9, [{ id: 100 }, { id: 101 }], ['画笔工具', '新建图层'], 2, 5);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.newStrokeCount, 1);
  const snap = det.snapshot();
  assert.strictEqual(snap.docs['9'].tokens, 5);
  // 长度对不上时必须拒绝，让 host 回退全量扫描
  const bad = det.appendStatesAtCap(9, [{ id: 200 }], ['画笔工具'], 1, 99);
  assert.strictEqual(bad.ok, false);
});