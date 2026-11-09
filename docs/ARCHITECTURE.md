# 嗷呜计数（Aowu Counter）— 架构与实现契约 v1.0

> 本文是实现的唯一契约。所有文件必须严格按本契约互相调用；改动接口需同步更新本文。

## 1. 技术选型

- **CEP 扩展（Photoshop 2025 实测可用，CEP 12）**，不是 UXP。原因：需要逐笔检测历史记录、读取历史状态 ID、跨重启持久化、并能在本机真机自动化测试。ExtendScript Action Manager 可稳定读取当前历史状态 `{ID, name, count}`、按 index 枚举历史状态，且撤销/重做会回到旧 ID、新操作会得到新 ID。见 `DETECTION-RESEARCH.md`。
- 面板 HTML/CSS/JS 运行在 CEP Chromium（支持 ES5/ES6 常用语法、JSON、Promise、fetch 不需要）。
- PS 端逻辑运行在 ExtendScript（**ES3**：只能用 `var`/`function`，没有 `JSON`，没有 `let/const/箭头函数/模板字符串/class`，没有 `Promise`）。

## 2. 目录与文件所有权

```
aowu-counter/
├─ CSXS/manifest.xml          [UI]   CEP 清单（菜单名 嗷呜计数，AutoVisible）
├─ index.html                 [UI]   <script> 顺序：js/csinterface.js → js/bridge.js → js/app.js
├─ css/style.css              [UI]
├─ icons/icon.png, icon@2x.png[UI]
├─ js/csinterface.js          [Lead] 复用 aowu-perspective/js/csinterface.js（原样复制）
├─ js/bridge.js               [Lead] CEP 桥 + 浏览器 mock（对外 window.AowuCounterBridge）
├─ js/app.js                  [UI]   面板 UI/交互/轮询
├─ jsx/host.jsx               [Lead] ExtendScript：AM 读取、检测、模型、持久化、面板 API
├─ jsx/core.jsx               [Core] 纯逻辑（ES3）：模型 + 检测器 + 行格式序列化 + JSON 序列化
├─ install.ps1 / uninstall.ps1 / 安装.bat / 卸载.bat   [UI]
├─ README.md                  [UI 初稿，Lead 终审]
├─ tools/build.ps1            [Lead] 打包 zip
├─ tests/core.test.js         [Core] Node 单测（node:test）
├─ tests/run-tests.ps1        [Core] 用内置 Node 跑单测
├─ docs/ARCHITECTURE.md, docs/DETECTION-RESEARCH.md   [Lead]
└─ _aowu-qa/…                 [Lead] 真机 E2E（不随插件安装）
```

## 3. `jsx/core.jsx` 契约（纯逻辑，ES3，无 PS API）

文件末尾：
```js
var AowuCounterCore = (function () { /* ... */ return api; })();
if (typeof module !== "undefined" && module.exports) { module.exports = AowuCounterCore; }
```
（ExtendScript 里 `module` 不存在 → 只留下全局 `AowuCounterCore`；Node 单测用 vm 读取或用 require 的兜底。）

### 3.1 常量
```js
MAX_COUNTERS = 100000000;
MAX_STROKES  = 100000000000;  // 1000 亿
DATA_VERSION = 1;
```

### 3.2 工具函数
- `clampCount(n)` → 0..MAX_STROKES 的整数（非数字/NaN→0）。
- `formatNumber(n)` → 千分位字符串（例：12345 → "12,345"）。
- `jsonStringify(value)` → 手写 JSON 序列化（对象/数组/字符串/数字/布尔/null），字符串须转义 `" \ \r \n \t` 及 `<`? 不需要；必须能被面板 `JSON.parse`。
- `nowMs()` → 当前毫秒（`new Date().getTime()`）。

### 3.3 计数器模型
```js
Core.createModel() -> model
model.loadFromText(text)        // 解析行格式；失败返回 {ok:false,errors:[...]}，不抛异常
model.serialize()               // 行格式文本，末尾 \n
model.snapshot()                // {counters:[{id,name,count,createdAt}], maxCounters, maxStrokes}
model.getCounters()             // 内部数组（只读使用）
model.count()                   // 计数器个数
model.findById(id)              // counter|null
model.findByName(name)          // counter|null（精确匹配）
model.createCounter(name, now)  // -> {ok:true, counter} | {ok:false, reason:"limit"|"duplicate"|"invalid"}
model.renameCounter(id, newName)// -> {ok:true, counter} | {ok:false, reason:"missing"|"duplicate"|"invalid"}
model.mergeCounterInto(sourceId, targetId) // 目标 count += 源 count（不超过 MAX_STROKES），删除源；-> {ok:true,count}
model.increment(id, n)          // -> {ok:true, added, count}（封顶 1000 亿；id 不存在 -> {ok:false,reason:"missing"}）
model.clearCounter(id)          // -> {ok:true}
model.deleteCounter(id)         // -> {ok:true} | {ok:false,reason:"missing"}
```
规则：
- `name` 去首尾空白后不能为空、长度 ≤ 260（PS 文件名长度上限）；
- 计数器名字全局唯一（精确、区分大小写）；
- 新建/改名不能产生重复（模型层报错；文档改名自动跟随的合并由 host 调 `mergeCounterInto` 处理）；
- `createdAt` 为毫秒整数，缺失则用 now；
- `increment` 的 `added` 是实际增加量（封顶时可能 < n）。

### 3.4 持久化行格式（host 落盘用，必须能被 `loadFromText` 解析）
```
#AOWU-COUNT v1
<id>\t<count>\t<createdAt>\t<encodeURIComponent(name)>
```
- 解析：跳过空行与 `#` 注释行；按 `\t` split 至少 4 列；`decodeURIComponent` 失败的行丢弃；
- 每行 count 经 `clampCount`；重复 id 丢弃后者；重复 name 合并计数到先出现者（封顶）；
- 超过 10 个丢弃多余；非法 name 丢弃；
- 返回 `{ok:true, counters, errors}`（errors 只是提示，不阻塞）；
- 文件头缺失/空文件 → 合法空模型 `{ok:true,counters:[]}`。

### 3.5 检测器（历史状态 DOM 引用序列对比）

> 真机实测：在 CEP 的 evalScript 引擎里，`ActionReference.putIndex(historyState, i)`、`getInteger(ID)`
> 会被 Photoshop 拒绝（错误 -1715「获取当前不可用」）；但 `Document.historyStates` 的 DOM 对象可读，
> 且同一个历史状态的 `HistoryState` 包装对象在多次 evalScript 调用之间用 `===` 比较仍然相等。
> 因此检测改用 `jsx/dom-detector.jsx`（纯逻辑，ES3，可 Node 单测）：

```js
var Det = AowuCounterDomDetector;          // 由 jsx/dom-detector.jsx 暴露
var det = Det.createDetector();
det.setPaintNames(['画笔工具','铅笔工具']);   // 本地化工具名，亦可用英文兜底
det.ensureDoc(docId, tokens)               // 首次见到文档：记录全部历史状态引用（token）作为基线，不计数
det.appendStates(docId, newTokens, newNames) // 纯追加：返回 {newStrokeCount, added}
det.scanFull(docId, tokens, names)         // 全量对比：返回 {newStrokeCount, added, newStart, offset, matched}
det.forgetDoc(docId)
det.snapshot()
Det.diffTokenLists(prevTokens, curTokens)  // 暴露给单测：{matched, offset, newStart, added}
```
算法：
- token = `app.activeDocument.historyStates[i]` 这个 DOM 包装对象；同一历史状态在不同 evalScript 调用里身份稳定。
- 历史记录只在末尾追加（新操作），或在「撤销后新操作」时截断后追加，或达到历史上限后剪枝（头部丢弃）。
- `diffTokenLists`：先求最长公共前缀；若 cur 是 prev 前缀 → 追加；否则找最佳偏移 `d>=1` 对齐剪枝；`newStart` 之后都是新状态。
- 只有新状态名 ∈ paintNames 才 +1；撤销/重做不改变列表、不产生新对象 → 不计数、不扣减；
  撤销后继续画会产生新对象 → 计数；一次 tick 内多笔会有多个新对象 → 逐个计数。
- token 数组保存在 host 内存中（每文档最多约 1000 个引用），文档关闭时 `forgetDoc`。
- 单测：`tests/dom-detector.test.js`（纯追加 / 撤销后新画 / 剪枝 / 深度撤销后新画 / 多笔 / 非画笔 / 多文档）。

## 4. `jsx/host.jsx` 契约（Lead 实现，PS 端唯一入口）

### 4.1 启动
- 文件被 CEP 以 `ScriptPath` 载入时立即初始化：`AowuCounter_init()`（幂等）：
  - 读取数据文件 → model.loadFromText；失败 → 空模型并记录 warning；
  - 读取本地化画笔/铅笔工具名（见 4.2）；
  - 注册全局对象 `AowuCounter`（函数都挂在它下面，避免污染全局命名空间）。
- 数据文件：`Folder.userData + "/AowuCounter/aowu-counter-data.txt"`（行格式文本）。目录不存在则创建。**位置固定，重装插件/升级不清数据。**

### 4.2 本地化画笔名称（关键，禁止仅硬编码中文）
- 用 Action Manager 读 `application.tools` 属性（实测：`ref.putProperty(stringIDToTypeID("application"), stringIDToTypeID("tools"))`，descriptor 里 `tools` list 每项有 `toolID`、`toolTip`）。
- 找 `toolID` 为 `paintbrushTool`、`pencilTool` 的项，取 `toolTip`（如 "画笔工具 (B)"），去掉尾部 ` (快捷键)` → "画笔工具"。
- paintNames = 上述两个名字；再并入兜底硬编码：`["画笔工具","Brush Tool","铅笔工具","Pencil Tool"]`。去重。
- 读取失败时用兜底数组，不得抛错。

### 4.3 每次 tick 的读取（性能目标：空闲 < 1ms）
1. `app.documents.length == 0` → 返回无文档状态（不扫描）。
2. `doc = app.activeDocument`；`docId = doc.id`；`docName = doc.name`；
3. AM 读当前历史状态：
```js
var ref = new ActionReference();
ref.putProperty(stringIDToTypeID("historyState"), stringIDToTypeID("currentHistoryState"));
var d = executeActionGet(ref);
var count = d.getInteger(charIDToTypeID("Cnt "));
var currentId = d.getInteger(charIDToTypeID("ID  "));
var currentName = d.getString(charIDToTypeID("Nm  "));
```
4. 文档首次出现（host 维护 `docRuntime[docId]`）：
   - 读最后状态 ID：`ref.putIndex(stringIDToTypeID("historyState"), count)` → `ID`；
   - `detector.ensureDoc(docId, lastStateId, paintNames)`；
   - 建立 `docRuntime[docId] = { name: docName, counterId: null, lastCount: count, lastCurrentId: currentId }`；
   - **新文档自动建计数**：若 `doc.saved === false`（新建画布）→ 尝试 `ensureCounterForDoc`（见 4.4，0 笔，容量满则不建）。
   - 已打开且名字命中已有计数器 → 关联。
5. 非首次：若 `count !== lastCount || currentId !== lastCurrentId`：
   - 读 tail：`for i in max(1,count-7)..count` → `{id, name}`（AM `putIndex(historyState, i)`，实测 index 从 1 开始、0 报错）；
   - `res = detector.scanTail(docId, tail)`；
   - 若 `res.newStrokeCount > 0` → 解析/创建当前文档的计数器（4.4）并 `model.increment(id, res.newStrokeCount)` → `save()`；
   - 更新 lastCount/lastCurrentId。
6. 文档改名（`docRuntime[docId].name !== docName`）：
   - 找该文档关联计数器（4.4 resolve），若存在 → `model.renameCounter`；若重名 → `mergeCounterInto`（源=当前文档计数器，目标=同名计数器）并更新关联；
   - 更新 `docRuntime[docId].name`；`save()`；
   - 若文档此前无关联计数器 → 按名字找已有计数器关联（不新建）。
7. 清理：每 tick 可顺便删除已关闭文档的 runtime（`app.documents` 遍历 id 集合）；detector.forgetDoc。

性能注意：只在 count/currentId 变化时才枚举 tail；空闲 tick 只有 1 次 AM get（≈0.2ms）。

### 4.4 计数器解析/创建（host 内部 `ensureCounterForDoc(doc, createIfMissing)`）
顺序：
1. `docRuntime[docId].counterId` 且模型里存在 → 用它（这是重命名跟随的锚点）；
2. `model.findByName(doc.name)` → 关联并使用；
3. 无计数器：若允许创建且 `model.count() < MAX_COUNTERS` → `model.createCounter(doc.name, now)`；否则返回 `{ok:false, reason:"limit"}` 并记录 warning（面板显示"已达 10 个画布上限，本画布不计数"）。
4. 创建/关联后更新 `docRuntime[docId].counterId`。

### 4.5 面板 API（全部返回**字符串**：手写 JSON；面板会 `JSON.parse`）
- `AowuCounter.getState()` → 见 4.6；同时执行一次 tick（面板每 150ms 调一次）。
- `AowuCounter.clearCurrent()` → `{ok, state}`：清空当前文档关联计数器笔数（无则 `{ok:false,error:"no_active_counter"}`）。
- `AowuCounter.deleteCounter(id)` → `{ok, state}`。
- `AowuCounter.renameCounter(id, newName)` → `{ok, state}` / `{ok:false,error:"duplicate"|"invalid"|"missing", state}`。
- `AowuCounter.getVersion()` → `{ok, version}`。
- `AowuCounter._debugReset()` / `_debugSetCount(name,count)` 仅用于 E2E（保留，不显示在 UI）。
- 所有公开函数 try/catch，返回 `{ok:false,error:"..."}`，绝不把异常抛给 evalScript（否则面板收到 "EvalScript error."）。

### 4.6 `getState()` 返回 JSON 结构
```json
{
  "ok": true,
  "version": "1.1.0",
  "dataPath": "C:\\Users\\...\\AowuCounter\\aowu-counter-data.txt",
  "activeDoc": {"id":74,"name":"未命名-1","saved":false},
  "activeCounterId": "c...",
  "counters": [{"id":"c...","name":"未命名-1","count":12,"createdAt":1790000000000}],
  "maxCounters": 10,
  "maxStrokes": 100000000000,
  "paintNames": ["画笔工具","铅笔工具"],
  "tool": "paintbrushTool",
  "warning": ""            // "limit" / "data_load" / "" 
}
```
panel 侧不再做任何计数逻辑，只渲染。

### 4.7 持久化
- 每次模型变更（计数+、清空、改名、删除、新建）立即 `save()`：写临时文件 `aowu-counter-data.txt.tmp` → 再覆盖正式文件（ExtendScript `File` 逐行写；失败则保留内存并置 warning，不抛异常）。
- 退出 PS 无需额外钩子（已即时保存）。
- 面板关闭/重开：host 脚本随面板卸载，但数据已保存；重新打开面板时重新 init 并 tick，检测继续。

## 5. 计数器规则（产品级，host + model 保证）
1. 只有"新历史状态名 == 本地化画笔/铅笔工具名"才 +1（点一下、画一笔都算 1；撤销不扣；重做不重复加）。
2. 上限 10 个画布：没有计数器且已有 10 个 → 不再创建、不计数；面板显示提示。
3. 单画布计数上限 1000 亿，封顶不报错。
4. 新建画布（saved=false 首次出现）自动创建 0 笔计数器，名字=画布名。
5. 已存在同名计数器的画布 → 继续累计。
6. 画布 Save As 改名 → 关联计数器跟着改名；若新名字与另一计数器重名 → 合并笔数（封顶），保留目标计数器。
7. 用户可手动改计数器名（面板）；重名拒绝（面板提示）。
8. 用户可清空当前画布计数（0 笔），之后画笔继续从 0 累加。
9. 用户可删除任意计数器；删除当前画布计数器后，下一次画笔会重新创建/或占用空位。
10. 最多同时保存 10 个计数器（不是同时最多 10 个打开文档）。

## 6. `js/bridge.js` 契约（Lead）
`window.AowuCounterBridge`：
- `isCEP`（bool）、`isMock()`。
- `init()` → Promise<void>（检测 CSInterface；mock 模式初始化假数据）。
- `getState()` → Promise<state 对象>；超时/失败 reject 或 resolve `{ok:false,error}`（app.js 处理）。
- `clearCurrent()`、`deleteCounter(id)`、`renameCounter(id,name)` → Promise<state>（内部 evalScript；失败时 `{ok:false,error}`）。
- `onConnectionChange(cb)`（可选，简单实现即可）。
- mock 模式（浏览器打开 `index.html?mock=1` 时）：内存假数据，支持上述操作，供 UI 预览/截图；不影响 PS。
- evalScript 统一封装：`CSInterface.evalScript(script, cb)`，回调字符串为 `"EvalScript error."` 或空时视为失败。

## 7. `js/app.js` + UI 验收标准（UI  teammate 实现）
- 轮询：`setInterval(150ms)` 调 `bridge.getState()`；上一请求未返回则跳过；签名未变不重绘。
- 顶栏：标题「嗷呜计数」+ 版本徽标；右侧连接状态点（绿=已连接，红=未连接）。
- 当前画布卡片：画布名（单行省略）、大号笔数（千分位）、状态行（正在计数 / 未记录 / 已达 10 个上限 / 没有打开的画布）、按钮「清空当前」（二次确认：按钮变成「确认清空?」，3 秒后还原）。
- 记录列表：标题「计数记录」+「n / 10」；每行：名字（当前画布高亮 + 小标签"当前"）、笔数、编辑按钮（铅笔图标）、删除按钮（垃圾桶图标）。
  - 编辑：点击变输入框（自动聚焦全选），Enter 保存 / Esc 取消 / 失焦保存；空名或重名外部提示（host 返回 error 时 toast）。
  - 删除：行内二次确认（「删除?」+ 删除/取消），3 秒还原。
  - 行数超出滚动。
- 底部：v1.1.1 起不再显示提示文字（说明移入 ? 帮助）。
- 空状态：「还没有记录 — 新建画布，或用画笔在画布上画一笔」。
- 上限提示：warning=="limit" 时当前卡片下方黄色提示条。
- Toast：底部浮层，2 秒消失；用于清空/删除/改名成功与错误。
- 深色主题适配 PS 2025，字号 ≥12px，行高紧凑；无外部字体/网络资源；纯 HTML+CSS+JS。
- 浏览器 mock 模式可显示示例数据（≥2 个计数器、1 个当前画布）便于截图。

## 8. 安装/清单（UI 负责）
- `CSXS/manifest.xml`：`ExtensionBundleId="com.aowu.counter"`、`ExtensionBundleVersion="1.1.1"`、Host 版本 `[19.0,99.9]`（PHXS/PHSP）、`Type=Panel`、菜单 `嗷呜计数`、`AutoVisible=true`、尺寸 300×480（min 190×36 / max 1200×2000；最小化时内容区 240×40）、Icons 指向 icons/icon.png。
- `install.ps1`：复制 `CSXS/js/jsx/css/icons/index.html` 到 `%APPDATA%\Adobe\CEP\extensions\com.aowu.counter`；写 HKCU `CSXS.8..13` 的 `PlayerDebugMode=1`；检测 PS 运行中则提示重启；**绝不删除用户数据目录**。
- `uninstall.ps1`：删除扩展目录；提示数据文件位置（默认不删数据，可加 `-RemoveData`）。
- `安装.bat` / `卸载.bat`：`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"` + pause。
- `tools/build.ps1`（Lead）：产出 `嗷呜计数_v1.1.1.zip`（含 CSXS/js/jsx/css/icons/index.html/install/uninstall/安装.bat/卸载.bat/README.md，不含 tests/tools/docs/_aowu-qa）。

## 9. 测试
- 单测：`tests/run-tests.ps1` 用内置 Node（`C:\Users\YINHU\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）跑 `node --test tests/core.test.js`。覆盖：模型规则、行格式解析、计数器数量上限、1000 亿封顶、检测器（撤销/重做/撤销后新画/快速多笔/非画笔状态/多文档隔离/剪枝）、DOM 历史状态引用 diff。
- 真机 E2E（Lead）：安装 → 开面板 → 真实鼠标画 3 笔=3；撤销后画 1 笔=4；重做不增加；滤镜/新建图层不增加；铅笔也计数；Save As 改名跟随；清空=0；关闭 PS 重开同名 PSD 继续累加；第 11 个画布不计数；10 个上限提示。
- 所有 E2E 必须遵守用户 PS 布局规则：测试前快照布局、测试后还原；测试文档只放 `_aowu-qa/`。

## 10. 版本
- 1.1.0（2026-11-08）：小面板/最小化横条、排行榜、帮助、连接圆点、1000 亿上限。
- 1.0.0（2026-11-07）：首版。

## 11. v1.1.0 增量（2026-11-08；v1.1.1 已进一步缩小到 240×40/隐藏标题/可拖拽，见 §12）

- **单画布上限**：`MAX_STROKES = 100000000000`（1000 亿）。
- **面板更小**：manifest 默认 `300×480`，`MinSize 260×48`；CSS 紧凑化。
- **最小化横条**：`CSInterface.resizeContent(w, 56)` 缩成约 56px 横条（v1.1.1 改为 240×40），显示画布名 +「当前笔数」+ 格式化数字 + 记录状态点（绿=正在记录：有当前画布且 activeCounterId；红=未记录/未连接）+ 展开按钮；点击横条展开，恢复保存的 prevW/prevH；最小化期间继续轮询计数。
- **排行榜 tab**：与「计数记录」并用两个 tab；按 count 倒序，名次 + 画布名 +「N 笔」+ 删除（复用 deleteCookie…deleteCounter 流程）。数据即 counters，永久保存在本机。
- **帮助弹窗**：顶栏「?」，内容为用法/注意事项/数据位置/红绿点说明；Esc/遮罩/X 关闭。
- **连接状态精简**：顶栏只显示圆点（绿/红），不再显示文字；连接失败不再弹 toast，只红点静默重试；操作失败仍 toast。
- **底部文案**：去掉「单画布上限 100 亿」，只保留「只统计画笔/铅笔真实笔迹 · 撤销不扣数」。
- **UI 稳定 id**：btnMinimize、btnExpand、minimizedBar、miniDocName、miniCount、miniStatusDot、btnHelp、helpModal、helpClose、tabRecords、tabLeaderboard、leaderboardList、rank-row/rank-name/rank-count；原有 id 全部保留供 E2E。
- 测试：core/dom 单测 107 通过；真机 UI E2E `_aowu-qa/counter-e2e/ui-feature-test.ps1` **14/14 通过**（尺寸/最小化 58px/展开恢复/帮助/排行榜倒序/圆点/底部文案）；headless UI 自测 172 项通过。
## 12. v1.1.1 增量（2026-11-08）

- **底部文案移除**：主面板不再显示「只统计画笔/铅笔真实笔迹 · 撤销不扣数」（该说明保留在 ? 帮助里）。
- **更小的最小化**：manifest `MinSize 190×36`；`MINI_WIDTH=240 / MINI_HEIGHT=40`，真机内容区 240×42、PS 窗口 242×93（PS 自带标签栏约 50px 无法去掉）。最小化时 `setWindowTitle(' ')` 隐藏「嗷呜计数」标题文字，展开恢复。
- **爪印拖拽**：CEP 无移动窗口 API；`host.jsx` 用临时 bat 启动隐藏 `jsx/window-drag.ps1`，按 `%TEMP%\aowu-counter-drag.ctrl` 的 `want:W,H` / `move:x,y` / `stop` 移动面板 OWL.Dock 窗口，并写 `aowu-counter-drag.status`；bridge `beginPanelDrag/updatePanelDrag/endPanelDrag/warmPanelDrag/stopPanelDragHelper` 用 `cep.fs` 读写，temp 目录取 host `Folder.temp`（`init` 返回 `tempDir`，避免 CEP 临时目录差异）。
  - 助手单实例 mutex + PS 退出自退出；最小化后预热 helper，首次拖拽无启动延迟。
- **重开自动展开**：页面 load 后每秒复查 `innerHeight<120` 连续 2 分钟，命中则 `resizeContent(300,480)` 并把标题恢复「嗷呜计数」。
- **计数不中断**：最小化/折叠期间轮询与计数逻辑不变（真机验证最小化 3 秒 state.ts 持续更新）。
- 真机 E2E `_aowu-qa/counter-e2e/ui-v111-test.ps1` **11/11 通过**（无 footer、300×480、最小化 240×42、空标题、拖拽 +120/+80、展开恢复、计数继续）。
## 13. v1.1.2 增量（2026-11-08）

- **最小化再缩小**：`MINI_WIDTH=230 / MINI_HEIGHT=28`，manifest `MinSize 180×24`；真机内容区 230×30、PS 窗口 232×81（v1.1.1 为 242×93）；字体/图标再小（爪印16、画布名11、标签9.5、数字12、圆点6、展开16）。
- **记住最小化状态**：`localStorage` 键 `aowuCounter.minimized`（'1'/'0'）、`aowuCounter.prevW/prevH`；minimize 写入、expand 写 0 并保存尺寸；init 若 minimized=1 直接恢复横条并跳过 autoExpand（含 15s guard 防 PS 晚应用旧尺寸），展开优先用存储尺寸；mock 预览不持久化。
- **命令窗口不再闪**：host 启动拖拽 helper 从 `.bat`（cmd.exe 会闪窗）改为 `.vbs` + `WScript.Shell.Run(..., 0, False)`，真机拖拽验证仍正常。
- 真机 E2E `_aowu-qa/counter-e2e/ui-v112-test.ps1` **12/12 通过**：230×30/窗口 232×81、关闭 PS 重开后仍最小化且标题空白、展开恢复 300×484、拖拽 +120/+80。
- 注意：CEP `localStorage` 真机跨 PS 重启验证保留成功（后续若某版本清理 CEP profile 会丢失最小化记忆，属预期）。
## 14. v1.1.3 增量（2026-11-08）

- 顶栏在 ? 前新增「关于」文字按钮 `btnAbout`；关于弹窗 `aboutModal`/`aboutClose`：版本 v1.1.3、作者 B站「寅虎嗷呜呜」。
- 作者链接 `aboutBiliLink` 使用主题 accent `#39F0FF`；点击 `preventDefault` 后调用 `CSInterface.openURLInDefaultBrowser`（失败回退 `window.open`），URL `https://space.bilibili.com/438278539?spm_id_from=333.1007.0.0`；mock 只记录 `_lastExternalUrl()` 不真跳。
- 关于/帮助弹窗双向互斥；Esc/遮罩/X 关闭；`?mock=1&view=about` 可直接预览。
- 真机 E2E `_aowu-qa/counter-e2e/ui-v113-about-test.ps1` 覆盖：版本、按钮顺序、弹窗、作者内容、链接颜色/href、点击调用外部浏览器、关闭、帮助回归、顶栏不溢出（待真机执行）。
## 15. v1.1.4 增量（2026-11-08）

- **大数字完整显示**：当前画布笔数 >12 字符自动缩字号（既有）；记录/排行榜 `.row-count/.rank-count` 增加 `is-long`（10px、max-width 112px、nowrap）；最小化横条 `.mini-count` 上限 100px、长数字 10px，并在长数字时隐藏「当前笔数」标签（`.mini-bar.count-long`），保证 `100,000,000,000` 在 230px 小条内完整显示。
- 头less 验证（mock 注入 1000 亿 state）：当前 173/173、记录 96/96、排行榜 96/96、小横条 80/80，全部 full；class 正确 is-long、小横条 count-long、标签隐藏。
- 版本/manifest/host/bridge/build/install 全部 1.1.4；单测 107 通过。
## 16. v1.2.0 增量（2026-11-09）：暂停 / 全局快捷键

- **暂停状态在 host 端**：`AowuCounter.setPaused(true/false)` 写 `state.paused`；暂停时 `tick()` 只处理热键、不读历史状态；恢复时 `resetDetection()` 重建 detector 并清空 `docRuntime`，下个 tick 只建立基线——暂停期间画的笔画不会被补计。
- **面板**：当前画布卡片右侧中部 `btnPause`、最小化横条 `btnMiniPause`；`state.paused` 驱动 `body.paused`、状态「已暂停」、按钮「继续」、mini 黄点。
- **全局快捷键**：`jsx/hotkey.ps1` 是隐藏 PowerShell 助手，RegisterHotKey 单键（默认 P），按下写 `%TEMP%\aowu-counter-hotkey.fire`；host `tick()` 消费 fire 并切换 paused；`configureHotkey(enabled,key)` 启停助手，状态写 `...status`；`beforeunload` 时面板停用助手。
- **设置**：关于弹窗内「暂停快捷键」可改 A-Z/0-9 单键或禁用；localStorage `aowuCounter.hotkeyEnabled/hotkeyKey`。
- **测试**：UI headless 416 项；真机 `_aowu-qa/counter-e2e/ui-v120-test.ps1` 15/16（唯一失败为 T4 用 WMI 数 helper 进程的检测方式；P/K 按键切换暂停、按钮、禁用均 PASS）。
## 17. v1.2.1 增量（2026-11-09）：画布名忽略末尾一个 .psd

- core `normalizeName` 只去掉末尾一个 `.psd`（忽略大小写）：`未标题-1.psd`→`未标题-1`，`测试.psd.psd`→`测试.psd`，`.psd` 本身保留；`findByName` 查询同样归一化，`createCounter/renameCounter/loadFromText` 全部使用。
- host 新增 `docBaseName()`：tick/buildState/ensureCounterForDoc/counterForDoc 使用归一化 doc 名，显示也不再带 `.psd`。
- 旧数据加载时若两条记录归一化后同名则合并笔数；`loadData` 检测序列化变化并立即写回。
- 新增单测：normalizeName、create/find/rename、load 合并；Node 109 项全过。
- 真机 `_aowu-qa/counter-e2e/v121-name-test.ps1` **7/7 通过**：旧数据 42+19 两行合并为 `未标题-1 / 61`，数据文件写回 1 行且无 `.psd`；面板版本 v1.2.1。
## 18. v1.3.0 增量（2026-11-09）：1 亿记录上限 / 全部删除 / 数据保护

- `MAX_COUNTERS = 100000000`（1 亿）；旧数据不再因超过 10 条被丢弃。
- host 新增 `AowuCounter.deleteAllCounters()`：只由用户按钮调用，循环删除所有计数器并保存；bridge 暴露 `deleteAllCounters()`；UI 在排行榜 tab 提供「全部删除」二次确认。
- 数据保护：移除 loadData 里的自动写回（避免读取/解析异常时把文件覆盖成空）；saveData 在覆盖主文件前把上一份“有记录”的内容备份到 `aowu-counter-data.txt.bak`。
- UI 记录数显示 `n / 1亿`；帮助/警告文案同步；单条删除保留。
- 测试：core 109 项全过；UI headless 541 项全过；真机 `v130-test.ps1` 验证加载/删除/备份。
## 19. v1.4.0 增量（2026-11-09）：计数记录与排行榜独立

- 排行榜改为独立持久化模型：`aowu-counter-leaderboard.txt`（Core 模型格式），删除墓碑 `aowu-counter-leaderboard-deleted.txt`。
- 记录增长时按归一化名字把 max(count) 同步进排行榜；记录删除/清空/改名不会删排行榜；排行榜单条/全部删除不会删记录。
- 首次升级若排行榜文件不存在，从 `aowu-counter-data.txt.bak` 迁移历史高笔数到排行榜（只写排行榜，不恢复记录）。
- host API：`deleteLeaderboardCounter(id)`、`deleteAllLeaderboard()`；`deleteCounter`/`deleteAllCounters` 只作用于记录。
- 测试数据路径：`AowuCounter.init(extRoot, dataRoot)` 支持隔离数据目录，供真机测试不碰用户数据；v140-host-test 7/7；UI headless 457 项。
## 20. v1.4.1 增量（2026-11-09）：排行榜同步修复

- 墓碑格式升级：`aowu-counter-leaderboard-deleted.txt` 由“名字”改为“名字<TAB>删除时笔数”。
- `mergeLeaderboardEntry`：若记录当前笔数 > 墓碑笔数，说明用户在删除排行榜后记录又增长了，自动移除墓碑并重新同步进排行榜；未增长则保持删除。
- 旧版“只有名字”的墓碑：加载时从 `aowu-counter-leaderboard.txt.bak` 反查删除时笔数（当前用户 未标题-1=59、2psd=5），从而正确重新同步 359 而不误恢复 2psd。
- 删除单条/全部排行榜时把当前笔数写入墓碑；之后同笔数以内不再回加，超过后才重新同步。
- 真机 `v141-sync-test.ps1` **6/6 通过**（复制用户真实文件到 QA 隔离目录）：记录 未标题-1/359、排行榜重新出现 359、2psd 保持删除、墓碑写回 2psd=5。
## 21. v1.4.2 增量（2026-11-09）：排行榜实时镜像记录

- 症状：删除全部排行榜后再新建记录（如 333/80），排行榜一直空；新建路径漏掉即时同步。
- 修复：每次 `buildStateObj()` 最多每 500ms 兜底调用 `syncLeaderboardFromRecords()`：当前记录缺名字就新增、已有名字只升不降；`saveData()` 同时标记 `leaderboardDirty`，下一次取状态立即同步。
- 真机 v142-sync-test（复制用户文件到隔离目录）验证：载入 333/80 自动进排行榜；`_debugSetCount` 涨到 90 后排行榜实时变 333/90；不修改用户真实记录。
- UI v1.4.2 预览已更新；用户真实数据已自动同步 333/80。
## 22. v1.4.3 增量（2026-11-09）：当前记录强制镜像 / 100ms 同步

- 用户实测：删除全部排行榜后新建画布（名字复用 未标题-1，19 笔），排行榜仍空。原因：v1.4.2 墓碑按“删除时笔数 359”挡住了当前记录 19。
- 修复：`mergeLeaderboardEntry(..., force)`；当前记录（creation/increment/periodic sync）用 force=true：**当前存在的记录始终强制镜像进排行榜并清墓碑**；墓碑只约束“记录已不存在”的历史条目。
- 兜底同步间隔 500ms → **100ms**；`saveData()` 仍置 `leaderboardDirty` 下一次取状态立即同步，新画布检测到就进排行榜。
- 真机 v143-sync-test（复制用户真实文件到隔离目录）5/5：记录 未标题-1/19，排行榜显示 19（无视墓碑 359），墓碑中移除 未标题-1。
## 23. v1.4.4 增量（2026-11-09）：快速绘画性能修复

- 用户环境 `app.preferences.numberOfHistoryStates = 1000`；历史到达上限后，每次新笔画都会让列表“头部剪枝 + 尾部追加”，长度保持不变。v1.4.3 之前每次 tick 走 `readAllHistory()` 全量枚举 1000 条历史，快速绘画时每秒约 6 次 × 1000 次 DOM 读取，导致 PS 主线程严重卡顿。
- 新增 `tryAppendAtCap()`：列表长度不变时只在尾部最多 128 条窗口里找上一 tick 的最后 token，找到后只读新增尾部状态，并用 detector `appendStatesAtCap()` 头部剪枝+尾部追加；找不到才回退全量扫描（撤销后新画/深度剪枝）。
- 一次 `doc.historyStates` 集合缓存复用；空闲 tick 不再读 `doc.activeHistoryState.name`（仅 E2E 调试读）。
- 热键状态/触发文件读取节流（状态 1s、触发 200ms，且热键禁用时不读）；面板轮询 150ms→250ms。
- detector 单测新增 `appendStatesAtCap` 快速路径（110 项全过）。