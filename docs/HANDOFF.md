# 嗷呜计数 — 交接 / 继续开发说明

> 生成时间：2026-11-08 00:30（Asia/Shanghai）。下次继续时先读本文件即可恢复全部上下文。

## 1. 当前状态（已完成并交付）

- 插件：**嗷呜计数 v1.4.1**（Photoshop CEP 扩展，不是 UXP）
- 项目目录：`aowu-counter/`
- 安装包：`嗷呜计数_v1.4.1.zip`（工作区根目录，已构建并安装）
- 已安装到：`%APPDATA%\Adobe\CEP\extensions\com.aowu.counter`
- 用户使用：**完全退出并重启 Photoshop → 窗口 > 扩展（旧版）> 嗷鸣计数**
- 数据：`%APPDATA%\AowuCounter\aowu-counter-data.txt`（重装/升级不清；当前已清空为全新状态）
- 当前 PS 进程：0；PS 布局已用测试前快照还原；未留下 `.debug` / `e2e` / 测试数据。
- 单元测试：**107 / 107 通过**
  - 命令：项目根目录 `powershell -NoProfile -ExecutionPolicy Bypass -File tests\run-tests.ps1`
- 打包：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1`

## 2. 版本规则（用户明确要求）

- 修复 / 小迭代：1.0.1、1.0.2…
- 新增功能：1.1.0、1.1.1、1.1.2…（次版本号 +1）
- 2.0.0：仅用户明确要求时使用
- 改版本号需同步：`CSXS/manifest.xml`、`js/app.js`（如写死）、README、打包脚本参数；面板顶栏版本徽标取自 state.version。

## 3. 技术架构（重要，别推翻已真机验证的方案）

- **CEP + ExtendScript**。Photoshop 2025 (26.0) / CEP 12 实测可用。
- 检测原理：**读 `app.activeDocument.historyStates` 的 DOM 包装对象序列**，和历史状态引用做身份对比（diff）。
  - 撤销/重做只改 active、不改列表 → 不计数；
  - 撤销后继续画 / 剪枝 / 一次多笔 → 新对象出现在列表 → 按名称计入；
  - 历史状态名 = 本地化工具名：中文 **画笔工具 / 铅笔**（铅笔历史名不含「工具」），英文 Brush Tool / Pencil；
  - paintNames 从 `application.tools` 的 paintbrushTool/pencilTool 的 toolTip 学习，并自动补短名（去掉「工具/Tool」）+ 中英文兜底。
- **不要用** Action Manager 的 `historyState` ID / 按 index get：CEP evalScript 环境实测报 -1715「获取当前不可用」。
- 文件结构与职责见 `docs/ARCHITECTURE.md`；检测调研/踩坑见 `docs/DETECTION-RESEARCH.md`。
- 关键文件：
  - `jsx/host.jsx`：PS 端主逻辑（tick、计数器关联/改名跟随、持久化、面板 API；含仅测试用的 e2e 文件通道）
  - `jsx/dom-detector.jsx`：纯逻辑检测器（token 序列 diff），Node 可单测
  - `jsx/core.jsx`：纯逻辑模型/行格式序列化（UTF-8 BOM，字符串纯 ASCII）
  - `js/bridge.js`：面板 ↔ PS evalScript 封装（2.5s 超时 + 900ms 冷却，防止 PS 忙时排爆脚本队列）
  - `js/app.js`：UI + 150ms 轮询（后台/隐藏页降到约 0.9s，**不停止轮询**）
- 规则：计数器最多 10 个、单画布 1000 亿封顶、新画布自动建 0 笔、Save As 改名跟随（重名合并）、清空/手动改名/删除。

## 4. 测试现状与已知问题

- 真机验证过（PS 2025）：真实画笔 3 笔=3、撤销不扣、重做不加、新建图层/滤镜不计、清空、Save As 改名跟随。
- 自动化长回归脚本（`_aowu-qa/counter-e2e/`）后期有抖动：
  - 原因：PS 画画/面板在后台时脚本通道繁忙（COM `RPC_E_SERVERCALL_RETRYLATER`、evalScript 排队），不一定是计数逻辑错误。
  - 脚本：`run-e2e.ps1`（全量，文件通道版，稳一些但慢）、`focus-e2e.ps1`（短版）、`stroke-debug.ps1`（排查用）、`quick-core-check.js`。
  - 真机测试必须遵守用户规则：**先 `_aowu-qa/ps-layout-save.ps1` 快照，结束 `ps-layout-restore.ps1` 还原**；测试文档只放 `_aowu-qa`；不要最大化/改变 PS 窗口布局。
- 尚未在真机完全闭环的项（明天优先）：
  1. 铅笔（二值笔）真机 +1（代码已修，需一次干净手测确认）
  2. 关闭 PS 重开同名 PSD 继续累计（持久化）
  3. 10 个画布上限/第 11 个不计
  4. 1000 亿封顶
  5. 面板切后台/隐藏时仍持续计数（轮询节流版，需确认）

## 5. 用户偏好 / 硬性约束

- **不要更改用户的 Photoshop 布局**；必须调试时按上面快照/还原流程。
- 只统计画笔/铅笔真实笔迹；菜单/工具/图层/滤镜操作不能计入。
- 撤销不能扣数、重做不能重复加；最多 10 个画布；单画布 1000 亿封顶。
- 面板保持打开才计数（完全关闭期间不补算）。
- 中文界面；深色主题；不要引入外部网络资源。
- 用户对现状评价：「目前非常不错」，明天继续加功能。

## 6. 明日候选功能（等用户确认优先级）

1. **工具名校准设置**：面板里可自定义哪些历史记录名算「画笔」（兼容其他语言/特殊画笔）。
2. **暂停/恢复计数**开关 + 快捷键。
3. **统计历史/每日笔数**（按天累计、小图表）。
4. **导出/导入计数数据**（JSON/CSV，换电脑迁移）。
5. **清空可撤销**（最近一次清空前快照，防误清）。
6. **多文档同时监听**（不再只盯当前活动文档；需权衡性能）。
7. **面板关闭也统计**（CEP 限制大，可能需常驻辅助面板或评估 UXP 方案）。
8. **计数音效/桌面悬浮窗/成就提示**（趣味向）。
9. **开机自动打开面板 / 固定工作区**。
10. **兼容更多 PS 版本/语言**（英文、日文、繁体）。

> 建议明天先跑 3 分钟手工冒烟（新建画布→画笔几笔→撤销→铅笔→清空→Save As→重启 PS 看是否延续），再做功能；新功能版本从 **1.1.0** 起。

## 7. 快速命令

```powershell
# 单元测试
cd C:\Users\YINHU\Documents\deepseek-harness\default-workspace\aowu-counter
C:\Users\YINHU\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe --test tests/core.test.js tests/dom-detector.test.js

# 打包
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build.ps1

# 安装/卸载
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1

# 真机 E2E（注意 PS 布局规则与用户避让）
powershell -NoProfile -ExecutionPolicy Bypass -File ..\_aowu-qa\counter-e2e\focus-e2e.ps1
```

下次继续对话直接说「继续嗷呜计数」即可，先读本交接文件与 `docs/ARCHITECTURE.md`。

## 8. 2026-11-08 v1.1.0 增量（已交付）

用户新需求：小面板/最小化横条、排行榜、帮助、去掉 100 亿文案、上限提升 1000 亿、连接只显示红绿点。
- 版本 1.1.0；manifest 300×480（min 260×48）；`CSInterface.resizeContent` 用于最小化。
- UI（ui-shell 负责）：index.html/css/app.js/CSXS/preview 截图；新增 minimized/help/tabs/leaderboard 稳定 id。
- Lead：core MAX_STROKES=100000000000 与 tests 更新（107 通过）、host/bridge VERSION=1.1.0、build/install 1.1.0、README/ARCHITECTURE/HANDOFF、真机 UI E2E 脚本、打包安装。
- 真机验证脚本：`_aowu-qa/counter-e2e/ui-feature-test.ps1`（CDP 验证 resize/最小化/帮助/排行榜）。
- 若用户继续提功能：沿用 1.1.x / 1.2.0 规则；先读本文件恢复上下文。
## 9. v1.1.0 交付验收结果（2026-11-08）

- 单元测试：**107 / 107 通过**（core + dom-detector；已把上限改成 1000 亿并更新断言）。
- 真机 UI E2E：`_aowu-qa/counter-e2e/ui-feature-test.ps1` → **14/14 PASS**：
  - 版本 v1.1.0、帮助/最小化按钮存在、底部无“亿”文字、连接只剩圆点（无 connText）；
  - 默认窗口 300×482 → 点最小化后 58px、body.minimized、横条含 当前笔数/数值/红绿点；
  - 展开恢复 300×484；帮助弹窗 display=flex → 关闭 display=none；
  - 排行榜 2 行、第一名 夜行神龙.psd / 12,345 笔（倒序正确）。
- 安装：已用 install.ps1 干净安装到 `%APPDATA%\Adobe\CEP\extensions\com.aowu.counter`（manifest 1.1.0，无 e2e/.debug 残留）。
- 数据：测试数据已清理（`%APPDATA%\AowuCounter` 为空，全新状态）；测试后 PS 布局已还原、PS 已关闭。
- 已知自动化环境抖动：CDP 每次 eval 偶发很慢/端口掉（PS 忙时），不影响插件功能；真机 UI 验证已全绿。
## 10. v1.1.1 交付（2026-11-08）

- 用户反馈：删掉底部提示句；最小化更小/字图标更小；隐藏 PS 面板标题；爪印可拖动；折叠也继续计数；重开若记住小高度要自动展开。
- 实现：footer 删除；MINI 240×40（manifest MinSize 190×36）；`setWindowTitle(' ')`（展开恢复）；`jsx/window-drag.ps1` + host 隐藏启动 + bridge 临时文件拖拽 API（含预热）；init 2 分钟周期自动展开；最小化期间轮询不停。
- 关键坑：CEP `cep.fs.getTemporaryDirectory()` 与实际 `%TEMP%` 可能不一致，拖拽控制文件必须用 host `Folder.temp`（init 返回 tempDir）——否则 helper 永远收不到 want/move。
- 验证：`ui-v111-test.ps1` 真机 **11/11 PASS**（300×482、最小化 240×42/窗口 242×93、空白标题、拖拽 +120/+80、展开恢复、最小化期间 state.ts 持续更新）。
- 安装：`嗷呜计数_v1.1.1.zip` 已构建并干净安装；用户数据 `%APPDATA%\AowuCounter` 保留（测试脚本不再删除数据）。
- 已知限制：PS 面板自带标签栏/边框约 50px，插件无法去掉；若想要完全无 PS 标签栏的细条，需要独立桌面小窗口（另立版本）。
## 11. v1.1.2 交付（2026-11-08）

- 用户反馈：最小化再小；关闭 PS 时若最小化，重开也要最小化；最小化时命令窗口一闪而过。
- 实现：MINI 230×28（manifest MinSize 180×24）；localStorage 持久化 minimized/prevW/prevH 并在 init 恢复（跳过 autoExpand + 15s guard）；host 用 `.vbs` + WScript.Shell.Run(...,0,False) 隐藏启动 helper，消除 cmd 闪窗。
- 真机验证：`ui-v112-test.ps1` **12/12 PASS**（最小化 230×30、窗口 232×81、空白标题、关闭重开仍最小化、展开 300×484、拖拽 +120/+80）。
- 数据：`%APPDATA%\AowuCounter` 保留；测试脚本不再删除数据，结束时清 localStorage 以便下次默认展开。
- 若未来还要“完全无 PS 标签栏”的细条，需独立桌面小窗口（未做）。
## 12. v1.1.3 交付（2026-11-08）

- 用户需求：顶栏 ? 前加「关于嗷呜计数」，二级页面写作者、B站「寅虎嗷呜呜」，链接用主题色可点击打开 B站主页。
- 实现：btnAbout/aboutModal/aboutBiliLink；`#39F0FF` 链接色；点击 `CSInterface.openURLInDefaultBrowser`，URL `https://space.bilibili.com/438278539?spm_id_from=333.1007.0.0`；关于/帮助互斥，X/遮罩/Esc 关闭；mock `?mock=1&view=about`。
- 版本：manifest/host/bridge/build/install/README/ARCHITECTURE/HANDOFF 全部 1.1.3；headless 231 项通过。
- 真机 E2E `ui-v113-about-test.ps1` **11/11 通过**（版本、关于按钮顺序、弹窗内容、链接色 rgb(57,240,255)、href、点击调用外部浏览器、关闭、帮助回归、顶栏不溢出）。\n- 用户后续要求去掉关于弹窗里的「反馈 / 欢迎通过 B 站私信反馈问题与建议」一行，已删除并重拍 preview-about。
## 13. v1.1.4 交付（2026-11-08）

- 用户担心长数字显示：当前画布/记录/排行榜/小横条在 1000 亿时是否完整。修复：记录/排行榜 `is-long` 10px、max-width 112px、nowrap；小横条 `mini-count` 100px / 长数字 10px + 隐藏「当前笔数」标签。
- headless mock 注入 100,000,000,000 验证 full（当前 173/173、记录 96/96、排行 96/96、小横条 80/80）。
- 版本 1.1.4 全链路；单测 107 通过。
## 14. v1.2.0 交付（2026-11-09）

- 用户需求：随时暂停；快捷键 P（可自定义/可取消）；暂停按钮在主面板上方中间（红框位置）和最小化横条绿框位置；暂停不记录任何、恢复后继续。
- 实现：host `setPaused` + `tick` 暂停跳过 + 恢复重建基线；`jsx/hotkey.ps1` 隐藏全局热键助手 + `configureHotkey`；UI 两个暂停按钮、关于弹窗快捷键设置（localStorage）。
- 真机：pause 按钮/最小化按钮/暂停态 UI、P 快捷键、K 改键、禁用助手均通过；`ui-v120-test.ps1` 15/16（T4 测试进程检测失败，但热键实际生效）。
- 已知：默认 P 会占用 Photoshop 钢笔工具快捷键（UI 已提示可改/关闭）；暂停状态本身不持久化，快捷键设置持久化。
## 15. v1.2.1 交付（2026-11-09）

- 用户反馈：`未标题-1` 与 `未标题-1.psd` 被当成两个记录；要求比较名字时无视末尾 `.psd`，但 `测试.psd.psd` 这种文件名里有一个 `.psd` 属于名字本身。
- 实现：core 只去掉末尾**一个** `.psd`；host docBaseName 统一用于匹配/显示；旧数据加载时合并同名记录并写回。`测试.psd.psd`→`测试.psd`。
- 真机：旧数据两条（42、19）合并为 `未标题-1 / 61`，数据文件 1 行；面板 v1.2.1；测试脚本 v121-name-test.ps1 7/7。
- 数据备份：`%APPDATA%\AowuCounter\aowu-counter-data.backup-v120-20261109-103939.txt`。
## 16. v1.3.0 交付（2026-11-09）

- 用户需求：排行榜记录永不自动消失、只有用户删除；排行榜数量上限 1 亿；新增全部删除；记录画布上限也 1 亿。
- 实现：core MAX_COUNTERS=100000000；host deleteAllCounters + 数据 .bak 备份；移除 loadData 自动写回 (防误清空)；UI 排行榜「全部删除」二次确认、recordsCount 显示 n/1亿。
- 数据恢复：10:47 时发现用户数据被清空（只剩文件头），备份 `aowu-counter-data.backup-v120-20261109-103939.txt` 保留 42+19 原始记录；最终按合并结果恢复 `未标题-1 / 61`。
- 真机验证脚本 `_aowu-qa/counter-e2e/v130-test.ps1`：加载、删除全部、.bak、空状态；测试后还原 PS 布局。
## 17. v1.4.0 交付（2026-11-09）

- 用户纠正：排行榜必须与计数记录独立；删记录不能删排行榜，排行榜只有用户在排行榜里删除才变。
- 实现：host 独立 leaderboard 模型 + 文件 + 墓碑；记录增长同步 max 到排行榜；三个 API 分离；UI 按 tab 使用 counters/leaderboard；上限各 1 亿。
- 真机 host 测试（隔离数据目录）7/7：记录 2psd/5 + 排行榜迁移 未标题-1/42、2psd/5；删记录后排行榜保留；删排行榜后记录不受影响；全部删排行榜不清记录。
- UI headless 457 项通过；测试未碰用户真实数据；PS 布局已还原。
## 18. v1.4.1 交付（2026-11-09）

- Bug：计数记录笔数增长后没有同步到排行榜（此前用户删除过排行榜，墓碑只存名字、永久挡住同步）。
- 修复：墓碑记录删除时笔数；记录当前笔数超过墓碑笔数时自动移除墓碑并重新同步；旧墓碑从排行榜 `.bak` 反查笔数。
- 真机 v141-sync-test（复制用户文件到隔离 QA 目录）6/6：未标题-1/359 重新出现在排行榜，2psd 保持删除，墓碑写回 2psd=5；未改用户真实数据。
- UI v1.4.1 预览重拍；用户需重启 PS 让真实数据自动同步。