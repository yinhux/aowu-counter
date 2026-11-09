# 画笔计数检测调研（PS 2025 / CEP ExtendScript 实测）

> 本文记录 2026-11-07 在本机 Photoshop 2025 (26.0.0, zh_CN) 上的真机探测结果，是 `ARCHITECTURE.md` 检测算法的依据。
> 探测脚本在 `_aowu-qa/probe-counter/`，不要在正式插件里引用。

## 结论（TL;DR）

可行的、精确到"一笔"的检测方案：

1. **历史状态名称 = 操作名称**。用画笔/铅笔在画布上画一笔 → 历史记录新增一条，名称等于**本地化工具名**（本机：`画笔工具`；铅笔预计 `铅笔工具`）。点一下（一个点）也算 1 条。
2. **Action Manager 可以读历史状态**：
   - 当前状态：`ref.putProperty(stringIDToTypeID("historyState"), stringIDToTypeID("currentHistoryState"))` → `executeActionGet` 得到：
     `{ name:"画笔工具", ID:123, count:57, itemIndex:57, currentHistoryState:true, ... }`
     - `ID`：该历史状态的唯一整数 ID（同 Photoshop 会话内全局递增）。
     - `count`：当前历史状态总数（受"历史记录状态数"偏好上限约束）。
     - `itemIndex`：当前状态在列表中的 1-based 序号。
   - 任意状态：`ref.putIndex(stringIDToTypeID("historyState"), i)`（i 从 1 开始；0 报错）→ 同样得到 `{name, ID, count, itemIndex}`。
   - 性能：单次 get ≈0.22ms（40 次 9ms）；读 1000 条历史状态约 220ms（只在必要时枚举尾部 8 条）。
3. **ID 语义（关键）**：
   - 新操作（画一笔/新建图层/滤镜等）→ 分配**新 ID**；
   - 撤销/重做只是切换当前状态 → **回到旧 ID**；
   - 撤销后继续画（新操作）→ **新 ID**（不复用被丢弃状态的 ID）；实测 75→77→78（撤销到 77）→新操作 79。
   - 因此用"每文档历史状态 ID 高水位（watermark）"即可：`ID > watermark` 的新状态 = 插件未见过的新操作；其中名称命中画笔/铅笔的 = 一笔。撤销/重做永远不会 > 水位 → 不计数；撤销后继续画 → 计 1。
4. **本地化工具名**：`ref.putProperty(application, tools)` 返回 tools 列表，`toolID=paintbrushTool` 的 `toolTip` 是 `"画笔工具 (B)"`；去掉快捷键后缀得本地化名称，因此不依赖中文硬编码。铅笔 `pencilTool` → `铅笔工具`。
5. **只统计真正的绘画**：菜单/工具切换不产生历史状态 → 天然不计；滤镜/调整/图层操作产生的状态名不是工具名 → 不计；即使当时选中画笔工具也不会误计。
6. **`app.scheduleTask` 不存在**，`app.notifiers` 可以 add 但实测事件从不触发（含 `paint`/`historyStateChanged`/`newDocument`）→ 不能用事件驱动；计数由面板 `setInterval` 轮询驱动（面板打开时计数）。
7. **DOM 身份**：ExtendScript `doc.historyStates[i]` 是 `HistoryState` 对象，两个包装对象用 `==`/`===` 可比较身份，但它**没有 id 属性**；跨 evalScript 调用是否保持身份未验证，故不采用 DOM 身份，改用 AM ID 高水位（无跨引擎状态依赖）。
8. 其他实测：
   - 未保存文档 `doc.name` = 文档名（如 `未命名-1`/自定义名）；Save As 后 `doc.name` 变为带扩展名的文件名（如 `x.psd`）；`doc.fullName` 未保存时取值会抛异常。
   - `app.currentTool` 返回内部 ID：画笔=`paintbrushTool`、铅笔=`pencilTool`、橡皮=`eraserTool`（与语言无关）；历史状态名是本地化名。
   - 本机 `app.preferences.numberOfHistoryStates = 1000`；默认可能 50。算法不依赖该值（剪枝后新 ID 仍大于水位）。
   - `JSON` 全局不存在，需手写序列化（`jsx/core.jsx` 提供）。
   - COM `DoJavaScript` 每次调用是独立执行环境，`$.global` 不跨调用保留；**CEP 的 evalScript 是同一引擎，全局保留**（正式插件依赖这一点，需在自测里验证）。
   - CEP 面板可通过 `.debug` 文件 + 端口 8866 做 CDP 自动化（prior project 已验证）。
   - 本机 PS 安装于 `F:\PS 2025 V26.0\Adobe Photoshop 2025\Photoshop.exe`，CEP 12，`窗口 > 扩展（旧版）` 可用。
9. **退而求其次的备选**（若未来某 PS 版本 ID 行为变化）：DOM 名称序列 + 对象身份比较也能检测结构变化，但无法可靠区分"撤销后新画"与"重做"同名状态；不推荐。UXP 有 `Document.historyStates` 且带 `id`（官方文档 22.5+），但 UXP 安装/调试成本高，且本机未开开发者模式，故本版仍用 CEP。

## 关键补充（CEP evalScript 环境实测，2026-11-07 23:xx）

最初方案用 Action Manager 读历史状态 ID（高水位）在 **COM DoJavaScript** 环境成立，但在 **CEP 面板的
evalScript 环境**不成立：

| 操作 | COM DoJavaScript | CEP evalScript |
| --- | --- | --- |
| `get currentHistoryState` 的属性（name/count） | ✅ | ✅ |
| `historyState` 的 `ID` 属性 get | ✅ | ❌ 报 -1715「获取当前不可用」 |
| `putIndex(historyState, i)` 按 index get | ✅ | ❌ 报 -1715 |
| 读 DOM `doc.historyStates[i].name` | ✅ | ✅ |
| `HistoryState` 包装对象跨调用 `===` 身份比较 | 未测（COM 每次独立引擎） | ✅ 稳定（实测 same=3/3，且新增状态能以新对象识别） |

因此正式实现改为 **DOM 历史状态引用序列对比**（`jsx/dom-detector.jsx`）：
- 每 tick 只读 `historyStates.length` 和最后一个状态对象；两者都不变 → 无新操作（撤销/重做不改列表 → 不计数）。
- 变化时：纯追加只读新增尾部状态；否则全量对比「历史状态包装对象引用序列」，算出新增状态（含撤销后新画/剪枝）。
- 新增状态名命中本地化 `画笔工具`/`铅笔工具` → +1。
- 该方案不依赖任何被 CEP 限制的 Action Manager 引用形式；单测见 `tests/dom-detector.test.js`。

> 备注：读本地化工具名用的 `application.tools` 属性 get 在 CEP 环境仍可用（host 初始化时成功学到
> 「画笔工具 / 铅笔工具」，顺序也验证为 learned 而非兜底）。

## 探测脚本索引
- `probe1.jsx`：文档命名、工具、`historyStates` 对象属性、`notifiers` 可注册性。
- `probe2.jsx`/`probe3.jsx`：真实鼠标笔画 → 历史状态名称；撤销/重做行为；Save As 改名；notifier 触发（未触发）。
- `probe4.jsx`：DOM 历史对象身份、撤销后新操作的身份变化。
- `probe5.jsx`：AM 读当前/按 index 读历史状态、ID 生命周期、本地化工具名、性能。
