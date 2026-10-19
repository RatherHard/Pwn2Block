# D / H 接入说明

> 已归档（2026-10-19）。这是早期原型文档，不代表当前生产界面。文中的文件路径和命令按原型原位置理解；运行文件与截图仍在 [design/frontend](../../../design/frontend/README.md)。当前开发见 [00-开发入口](../../00-开发入口.md)。

本交付仅位于 `design/frontend/`。2026-10-15 已对照产品文档 01/04/05/07/08/09/10、现有 web 组件、viewmodel、公开 fixture、Blockly 目录与客户端编译接口。下文描述下一阶段如何接入；本次没有修改生产代码、共享契约、依赖配置或 G3 验收状态。

## 1. 数据边界与责任

D 负责 Lit 页面、API 会话、视图、请求状态、判题/回放和无障碍语义；H 负责 Blockly 工作区、工具箱、归一化与客户端编译桥接。A 负责跨模块契约决策，涉及服务端投影时由 C 协同。视觉 token 与状态样式参考 [design-spec.md](design-spec.md)，可按现有组件边界逐项迁移，无需引入新 UI 框架。

原型 `fixtures.js` 是手写展示模型，**不是符合共享 schema 的请求/响应 fixture**。它使用公开教学布局地址，并把投影简化为 `sp/bp/ip/buffer/ret`；`end`、`roles`、动作上的 `blockId` 都是原型辅助字段。不能将该对象直接传入 API，不能把原型定时器或判题选择逻辑带进产品。I/O 状态代表额外声明 syscalls/fds/feed 的题目变体；生产必须从公开题目声明生成，不能从场景名推断。

允许的输入仅有公开题目、公开 Projection、编译结果和提交 Replay。不读取私有题包、flag 文件、win/fail 条件、虚拟文件内容或环境变量；不在客户端执行 VM、解码机器码、猜测成功条件或补全隐藏字节。

## 2. 逐组件映射

路径均相对仓库根目录。表中“基础控件状态”指规范第 3 节中的普通暗底、悬停提亮、2px 蓝色焦点、原生 disabled 和就近原因说明。

| 原型区域 / 接入责任 | 现有文件 | 输入展示数据与操作 | 普通 / 悬停 / 焦点 / 禁用 / 等待 / 错误 |
|---|---|---|---|
| 主题与工作台布局 · D | `packages/web/src/theme.ts`、`components/app-shell.ts` | token；当前模式；1:1 无缝工作区；右侧画布/程序/输出；桌面断点 | 普通暗底；基础控件状态；加载占位保持尺寸；会话错误横幅不挤出提交按钮 |
| 顶栏、视图/运行菜单、模式 · D | `components/top-bar.ts`、`viewmodel/session.ts`、`viewmodel/keymap.ts` | 模式、结果是否存在、操作可用性；菜单开关、Esc、模式切换 | 悬停提亮；焦点返回触发器；无结果禁结果入口；请求中禁执行；模式用文本与 aria-pressed 同时标识 |
| 题面与提示 · D | `components/briefing-panel.ts` | PublicChallenge 的 title/briefing/hints；Projection.failures；折叠、逐条揭示、自动揭示 | 标题/计数常显；按钮 hover/focus；全部揭示后禁下一条；题目加载占位；失败阈值提示单独播报 |
| 两槽位管理器 · D | `components/view-manager.ts`、`viewmodel/views.ts`、`viewmodel/keymap.ts` | visible/order；题目 I/O 声明；隐藏、拖排、上下按钮、Ctrl+↑/↓ | 两个等高槽；拖动柄与按钮可聚焦；首尾排序按钮禁用；全隐藏有恢复入口；各槽内加载/错误不破坏管理器 |
| 栈 · D | `components/stack-view.ts`、`viewmodel/stack.ts`、`reader.ts`、`pointer.ts`、`labels.ts`、`diff.ts` | 公开 VMA/registers/labels、架构位数与角色映射；搜索、地址跳转、偏移 0…W−1、跟随 sp | 字节对齐；链接 hover/focus；变化 Δ 加单次闪亮；隐藏 ?? / 未映射 —；无角色时明确锚点不可用 |
| 指令 · D | `components/disasm-view.ts`、`viewmodel/disasm.ts` | projection.disasm、公开 func 标签、ip；函数选择、target 跳转、跟随 ip | 当前行箭头；目标 hover/focus；缺目标时无链接；加载保留列头；不解码、不设断点、不展示隐藏代码 |
| 寄存器 · D | `components/registers-view.ts`、`viewmodel/registers.ts` | 所有公开寄存器和 ZF/CF/SF；复制、公开指针解释 | 变化符号/单次高亮；值按钮 hover/focus；不可用为 —；复制失败提供手动文本，不能虚报成功 |
| 自由内存 · D | `components/memory-view.ts`、`viewmodel/memory.ts`、`reader.ts` | VMA id/kind/label/start/size/perm/hidden/hex；选择区段、滚动 dump | 选中有边线；区段按钮 hover/focus；隐藏只显示布局；缺字节/未映射空态；加载/错误在槽内 |
| 条件 I/O · D | `components/view-manager.ts` 现有占位；拟拆出 I/O 组件 | public.syscallAbi/syscalls/fds；projection.stdin/stdout；ASCII/hex 切换、速查 | 新输出标 Δ；已读输入灰色+文字；切换按钮 hover/focus；未声明不提供视图；缺单项流显示未声明；不读文件内容 |
| Blockly 画布、工具箱 · H；容器与尺寸 D | `components/payload-panel.ts`、`blocks/catalog.ts`、`toolbox.ts`、`workspace.ts`、`index.ts` | buildToolbox(publicChallenge)；真实 workspace；唯一开始块、分类、参数与 tooltip | 低饱和分类色；选中蓝边；hover/focus tooltip；等待/结果模式字段只读；错误红边+气泡；画布加载/空态 |
| 编译与动作程序区 · H 编译、D 展示 | `compiler/compile.ts`、`compiler/types.ts`、`components/payload-panel.ts` | normalizeWorkspace → compileProgram；动作、游标、错误 blockId；编译、点击定位 | 成功标签/当前动作箭头；行 hover/focus；旧产物过期标签；无产物禁 payload 执行/提交；失败无部分结果；等待锁 |
| 执行/撤销/重置工具栏 · D | `components/payload-panel.ts`、`components/top-bar.ts`、`viewmodel/session.ts`、API client | session、history、status、actions、cursor；语义见下表 | 基础控件状态；请求中串行锁；历史空/窗口耗尽明确说明；failed/exited 禁执行但开放有效回退 |
| 输出与错误定位 · D；定位桥 H | `components/payload-panel.ts`、`components/app-shell.ts` | 编译 errors、投影 error、lastStop、请求错误；定位、修正后重编、恢复 | 文本/符号/色彩并用；定位按钮 hover/focus；等待不提供暂停；message 与 note 分开；无原因时不编造 |
| 判题横幅、回放与返回 · D；积木快照 H | `components/app-shell.ts`、`components/payload-panel.ts`、`viewmodel/session.ts`；现有入口上扩展 | submit verdict/replay、提交动作/工作区快照、保留的 debug 状态；滑块、帧箭头、返回 | 四 verdict 各有文字和符号；range 可键盘操作；首尾禁箭头；执行按钮只读；错误帧可定位；仅 won 显示服务端 flag |
| 题目空态、会话加载/失效/网络错误 · D | `components/app-shell.ts`、API client 的 `ApiClientError` / `isSessionExpired` | 公开题目列表为空、请求阶段与错误；刷新列表、重新开始 | skeleton / 等待文本；保留画布；恢复按钮 hover/focus；创建中禁重复创建；成功后清历史与投影 |

上述组件路径的 `components/`、`viewmodel/`、`blocks/`、`compiler/` 均位于 `packages/web/src/`，不是要求另建同名模块。完整 Blockly 键盘拼接为 P1；P0 应完成外围按钮、菜单、排序、模式、提示、错误定位、回放与焦点恢复。

## 3. 按钮必须保留的语义

| 操作 | 生产行为 | 原型行为 |
|---|---|---|
| 编译 | 本地 normalizeWorkspace + compileProgram；无网络；失败丢弃部分结果；成功可为空动作序列 | 根据 16/24 参数选择预置数组；错误场景固定报错 |
| 试运行 | 有剩余 payload 就按顺序执行剩余动作；全部用完才发送 run | 定时选择反馈；输出说明当前分支，不执行 VM |
| 单步 | 有剩余 payload 就执行下一动作；用完后发送 VM step | 更新动作游标，空程序按 VM step 分支展示预设 |
| 运行 N 步 | step 携带 count；只作用于调试实例，不移动 payload 游标；不要求编译 | 明示“非实际执行 N 条指令” |
| 后退一步 | step_back 回退一条指令；仅最近 64 条；不是上一个 payload 动作；不新增请求历史 | 两个手写指令反馈：2→1→0；动作位置保持 |
| 撤销 | undo 回退上一次请求；undo 本身不入历史；failures 不倒减 | 恢复本地保存的演示请求状态 |
| 重置 | reset 回到初态、游标回开头；reset 本身可撤销；failures 单调递增 | 选择初始样例，支持撤销 reset |
| 提交 | 完整已编译 payload 在独立初始实例判题；不能提交调试快照或“剩余动作” | 固定展示 incomplete；其余 verdict 由标明的演示选择器展示 |
| 回到调试 | 恢复原会话、投影、编译/过期状态、画布和游标，不用录像覆盖它们 | 已用浏览器验证调试满足条件与过期编辑状态都保留 |

工作区编辑只标记产物过期，不把新参数混入上一份成功产物。过期时禁止试运行、payload 单步、提交；仍可操作独立调试功能（N 步和合法历史操作）。等待期间阻止重复执行与编辑，响应/错误到达后解锁；不提供“暂停”。

判题时保存提交版本的工作区、动作和关联信息。四种 verdict 都进入结果模式并可回放；won 才显示响应提供的 flag。调试 `satisfied` 显示“当前状态已满足成功条件，请提交验证”，不显示 flag，仍可继续操作。

## 4. 接真实公开数据

- PublicChallenge：id/title/briefing/archBits/encoding、可选 syscallAbi/syscalls/fds/labels/authorBlocks/hints/errorNotes 和 allowedActions。不能把生产寄存器固定为 RSP/RBP/RIP。
- Projection：status/steps/failures/registers/flags/vmas/disasm 与可选 stdin/stdout/lastStop/error。每次响应是完整投影；使用现有 viewmodel 做展示与差分。架构决定 W；VMA 结束地址由 start+size 得到，运算保持完整地址精度。
- 公开 reader 是内存显示、搜索和指针跟随的唯一输入。hidden 没有 hex；reveal 后按返回的 hidden/hex 更新。链最多 3 跳；可执行地址的说明只取 disasm，前端不推导伪汇编。
- 工具箱直接使用 buildToolbox(challenge)，动作以 allowedActions 为准；author_<id> 取公开 authorBlocks 参数与 tooltip。feed 说明其必须放在触发读取的 step/run 之前。不要从当前 I/O 流是否为空推断题目是否支持 I/O。
- normalizeWorkspace 的树包含 id/type/fields/inputs/next；BLOCK_TYPES / INPUTS / FIELDS 为权威键名。表达式仅编译期求值，无运行时读寄存器/内存块。循环 256、表达式累计 4096 步、动作 4096 等限制从共享常量取值，不能为了排版另定限制。
- 编译结果为 `{ok:true,actions}` 或 `{ok:false,errors:[{blockId,message}]}`。错误定位选择并滚动到对应积木，焦点落在该块。合法空程序应显示 0 动作，并在之后的单步/运行中采用 VM 调试语义。
- API 继续使用现有 createApiClient 的 listChallenges/getChallenge/createSession/sessionState/actions/submit/endSession；历史可用性取返回的 history.undo/stepBack，不从 steps 自行猜测。重连不自动重复发送可能已经成功的动作，未知结果先同步会话；失效则显式重新创建。
- 提示的最大已揭示序号按题目 id 记忆；自动阈值取公开 failures。已揭示不能因回放/撤销倒退，存储不可用可退化到当前页面内存。

## 5. 回放合成与尚需确认的接入点

生产 Replay 是 `initial + frames`，不是本原型的完整手写帧数组。当前服务端 projectReplay 将 init 拆到 initial，余下 frames 的 index 从 0 开始；原型时间线把初态编为 0、动作编为 1…N，两者不能直接共用索引。先取 initial，按帧替换 registers/flags/status/steps/failures，并按 VMA id 合并 changedVmas；可选流与错误/停止字段按实际服务端录像约定还原。随机向后拖动需从初态重建或用缓存，不能把“后来的差分”留在较早帧。不得修改调试实例引用。滑块拖动期间保留输入节点，避免重绘打断鼠标捕获。

以下是已发现或需联调确认的缺口，**本次只记录，没有修改契约**：

1. **公开寄存器角色：方案已定、代码待落地（A + C/D/F）**：docs/08 的 D1 记录已决定在 Projection 增加 roles，由服务端从题目定义填充，不在 public.json 重复声明。目前公开类型和投影实现仍未提供 sp/bp/ip 映射，`web/src/fixtures/sample.ts` 的 SAMPLE_ROLES 是临时样例常量。按既定方向由 A/C 同批实现、D 消费、F 更新白名单守卫；不重新讨论是否从私有包读取的前端方案。前端不能猜测寄存器角色或读取私有定义；实现落地前显示“锚点角色未提供”，仍展示全部公开寄存器/地址。
2. **成功动作的来源映射缺失（A + H/D）**：当前 CompileResult 成功分支只有 actions，没有 actionIndex→blockId。错误分支有 blockId，可直接定位；成功动作定位需要单独的前端 side table，并处理循环展开和出题人积木的多动作关系。其接口应经 A/H 确认。不要把原型 action.blockId 发到严格校验的服务端 action 对象里。
3. **帧与动作关联需确认（A + C/D/H）**：ReplayFrame 的 kind 允许 init/action/instruction，但没有显式 sourceActionIndex。原型恰好有三条动作，不能据此普遍采用 frame.index−1。按服务端实际录像顺序约定建立关联；无法确定时只显示帧 label，不错误定位积木。时间线应标明实际粒度，一个 run 可能含多条指令。
4. **代码变化时的回放反汇编（A + C/D）**：initial 有 disasm，ReplayFrame 只有 changedVmas，没有 disasm 更新字段。如果执行会修改或揭示代码，旧 disasm 可能失效。接入时确认服务端支持范围；不能在前端补解码。未解决的相关帧显示“该帧指令信息不可用”，不能假装旧指令是当前结果。

这些问题不是为了视觉效果要求改 API；是定位、锚点和公开回放正确性所需的信息确认。优先复用已有能力，按项目契约流程处理真正需要的扩展。

## 6. 接入顺序与验收

1. D 迁移主题 token、1:1 外壳、两槽位滚动、右侧三区和模式来源栏；保留现有 Lit/viewmodel 接口。用三种桌面尺寸检查长地址、长错误和控制按钮可见性。
2. H 接入真实 Blockly 和本地编译；D 绑定未编译/成功/过期/错误状态。先完成错误定位，再在来源映射明确后完成成功动作定位。
3. D 用公开题目与会话响应替换样例，接串行请求锁、历史、提示、I/O 声明与恢复；后退、撤销、重置分别验证。
4. D/H 保留调试状态并保存提交版本；接四种 verdict、公开录像合成、错误帧定位和返回调试。通过服务端真实失败/拒绝样例验证，不从 flag 或私有信息推断。
5. 删除演示状态条、修正样例/完成加载按钮、预置结果与定时器。真实浏览器验收外围键盘流程、辅助技术播报、剪贴板降级；补人工视觉审查及目标浏览器矩阵。
6. 按 docs/08 单独执行真实服务端、真实首题、Playwright 八步闭环。这里的设计验收不能替代 G3，未改动该文档的验收勾选。

本次实际检查范围与结果见 [verification.md](verification.md)，截图见 [screenshots/index.html](../../../design/frontend/screenshots/index.html)。尚未接入：真实 API、VM、判题、Blockly 拖拽与编译；尚未验证：Safari/Firefox、真实屏幕阅读器和人工视觉审查。
