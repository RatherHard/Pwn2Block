# 前端 TUI 化与交互简化设计

日期：2026-10-17
来源：[docs/archive/frontend-2026-10-18/前端优化需求.md](../../archive/frontend-2026-10-18/前端优化需求.md)
范围：只改 `packages/web` 与相关文档；不改 `shared`、`engine`、`server`，不改 API 形状。

## 0. 已确认的决策

| 议题 | 决策 |
|---|---|
| 风格 | 严格 TUI（§1 全部条目） |
| 视图切换 | 单面板 + 固定标签；题目声明 I/O 时才有 I/O 标签，带伪代码时才有伪代码标签 |
| 视图状态 | 五个视图常驻挂载，切换时只隐藏；当前标签存 localStorage |
| 视图排版 | pwndbg 风格；栈视图保留逐字节显示 + 指针链 |
| payload 区 | 只放 Blockly 画布 +「运行」「终止」 |
| 其余操作 | 暂放顶栏「运行」菜单 |
| Markdown | 扩展自研解析器，输出 Lit 模板；不用 innerHTML，不加依赖 |

## 1. 主题（重写 `theme.ts`）

- **纯色**：只用一个背景色 `--p2b-bg`。不用渐变、网格底纹、径向光晕、阴影和半透明。面板之间靠边框分隔，不靠底色深浅区分。
- **单一等宽字体、单一字号**：层级用颜色、粗体和反显区分，不调字号。
- **直角实线边框**：`border-radius: 0`。面板标题嵌在上边框里，视觉上是 `┌─ 标题 ──┐`：标题绝对定位，用背景色盖住下面那段边框。
- **调色板**：每种颜色只表示一种语义。

  | Token | 语义 |
  |---|---|
  | `--p2b-fg` / `--p2b-dim` | 正文 / 次要文字 |
  | `--p2b-line` | 边框 |
  | `--p2b-addr` | 地址 |
  | `--p2b-changed` | 本次变化（黄） |
  | `--p2b-error` | 错误、判负（红） |
  | `--p2b-hidden` | 隐藏 VMA（紫） |
  | `--p2b-ip` | 当前指令、成功（绿） |
  | `--p2b-code` / `--p2b-stack` / `--p2b-data` | 值指向的区域 |
  | `--p2b-focus` | 焦点框 |

- **交互态**：hover、选中、按下都用反显（前景色与背景色互换），不用位移动效。按钮文字写成 `[ 运行 ]`。焦点框保留，为 2px 实线。
- **删除装饰**：红黄绿三点、`/proc/pwn2block/*` 窗口标题、`root@pwn2block:~$` 提示符、`◈` / `>` 图标、`h2::before` 圆点。
- **Blockly**：画布背景、工具箱、flyout、滚动条和网格都改用调色板里的纯色。积木改成低饱和纯色并去掉阴影。积木形状保持不变（受 SVG 渲染限制）。
- **外观**：只做深色一套，设 `color-scheme: dark`。

## 2. 页面骨架（`app-shell.ts`）

自上而下：

```
顶栏：品牌 · 返回题目列表 · 运行菜单 · 模式切换
通知条（有通知时）
题面面板（可折叠）
判题横幅（判题结果模式）
工作区：左 视图面板 | 右 payload 面板      高度 = 100dvh - 顶栏高度，最小 28rem
输出区（通栏）
状态栏（整行反显）
```

- `:host` 去掉 `height: 100dvh; overflow: hidden`，改由浏览器滚动条滚动整页。
- 工作区高度固定为 `calc(100dvh - var(--p2b-topbar-h))`，下限 `28rem`。题面和输出的长短不会挤压视图和画布。
- 宽度 ≤980px 时，工作区改为上下两块，每块 `min-height: 32rem`。
- 状态栏移到页面最底部，单行反显，格式为 `DEBUG │ <状态文案> │ ip=0x… │ 动作 n/m`。保留 `role="status"` 和 `aria-live="polite"`。

## 3. 视图面板

### 3.1 状态与交互

- `viewmodel/views.ts` 的 `ViewManagerState` 收敛为 `{ readonly active: ViewKind }`。
  - 保留：`VIEW_KINDS`、`VIEW_TITLES`、`availableViews`。
  - 新增：
    - `selectView(state, kind, available)`
    - `cycleView(state, delta, available)`：首尾循环，跳过不可用的标签
    - `normalizeActive(state, available)`：当前标签不可用时回到 `stack`
  - 删除：`order`、`shown`、`offset`、`activeSlot`、`SLOT_COUNT`、`setViewShown`、`toggleView`、`moveView`、`scrollViews`、`setViewOffset`、`focusSlot`、`hasMoreAbove`、`hasMoreBelow`、`slotKinds`、`activeView`、`isShown`、`VIEW_DESCRIPTIONS`。
- **控制器**：去掉 `setViewShown`、`moveView`、`scrollViews`、`setViewOffset`，换成 `selectView(kind)` 和 `cycleView(delta)`。
- **持久化**：键 `p2b:view-tab`，所有题目共用一个值。读失败或读到非法值时回退到 `stack`。写失败不提示，因为这只是便利功能。
- **键盘**：
  - 标签栏按 WAI-ARIA tablist 实现：`role="tablist"` / `tab` / `tabpanel`，用 `aria-selected` 和 roving tabindex。焦点在标签栏上时，`←` `→` `Home` `End` 切换标签。
  - `Ctrl+↑` / `Ctrl+↓` 切到上一个 / 下一个标签。沿用 `keymap.ts` 的现有判定：焦点在输入框里时不触发。返回值的语义从「滚动增量」改为「标签增量」。
- **删除**：顶栏的「视图」菜单，包括勾选、上下移动和拖动排序。

### 3.2 组件（重写 `view-manager.ts`）

- 标签栏：`[栈] 指令 寄存器 内存 I/O 伪代码`，当前标签反显，不带序号。
- 可用的视图组件常驻 DOM，不是当前标签的用 `hidden` 隐藏。题目不声明 I/O 时，I/O 视图和它的标签都不渲染；公开包没有 `pseudocode` 时，伪代码视图和它的标签也不渲染。
- 视图主体区可以纵向滚动。`view-scroll.ts` 的 `scrollRowInSlot` 改为在主体区内滚动；处于隐藏状态的视图不触发滚动。

### 3.3 pwndbg 风格排版

五个视图都不再用 `<table>`，改成逐行的等宽排版，每行用 grid 对齐列。数据仍然来自现有的 `viewmodel/*` 纯函数，只改渲染层。确实缺字段时，在 viewmodel 里补，并补上测试。

公共规则：

- 视图顶部可以有一行**命令栏**，放跳转、搜索、对齐等输入框。功能不变，只是压成一行。
- **本次变化**：寄存器行首加 `*`；变化的值统一用 `--p2b-changed`。这样颜色之外还有一个标记，颜色不是唯一的信息载体。
- **指针链**：用 `—▸` 连接各跳。终点是指令时写成 `◂— <伪汇编>`；落在函数标注上时，后面加 `(win)`。
- **值着色**：值指向代码、栈、数据、隐藏 VMA 时分别用 `--p2b-code`、`--p2b-stack`、`--p2b-data`、`--p2b-hidden`，未映射用默认色。视图面板底部固定一行图例说明这些颜色。

各视图：

- **栈**：每行格式为 `NN:OOOO│ <锚点> <地址>  <W 个字节>  <链/附注>  <标注名>`。`NN` 是两位十六进制行号，`OOOO` 是相对窗口起点的字节偏移。保留以下行为：隐藏 VMA 显示 `??`，未映射显示空白，变化的字节逐个高亮；跳转、跟随 sp、对齐偏移和字节搜索照旧可用。
- **指令**：每行格式为 `► 0x400000 <vuln+0>  <机器码>  <伪汇编>`。当前指令行首是 `►`，整行用 `--p2b-ip`。跳转目标渲染成可点击的 `<win>`。函数列表放进命令栏。录像帧没有反汇编时的提示保留。
- **寄存器**：每行格式为 `*RAX  0x1337  (4919)  —▸ …`。最后加一行 `FLAGS [ ZF cf sf ]`，大写表示置位。点击值复制的功能保留。
- **内存**：VMA 列表每行是 `起始 结束 权限 大小 名称`。隐藏 VMA 整行用 `--p2b-hidden`，并标注「隐藏」。选中一个 VMA 后，下方显示 hexdump，格式为 `地址  16 字节  |ASCII|`。
- **I/O**：`stdin` 和 `stdout` 两段按原文显示，「已读」和「新写」的高亮规则不变。下面是 syscall 速查。
- **伪代码**：出题人 `pseudocode.c` 的原文，等宽、只读、不着色，放在 `<pre>` 里按纯文本渲染。

## 4. payload 面板与运行 / 终止

### 4.1 布局（`payload-panel.ts`）

- 面板里只留 Blockly 画布，占满整个面板。标题栏左侧写 `payload`，右侧放 `[ 运行 ]` 和 `[ 终止 ]`。
- 删除程序区：`program-view.ts`，以及 `viewmodel/program.ts` 里只给程序区用的 `programRows` 等函数。工具栏还要用的文案常量（`MESSAGE_STALE`、`MESSAGE_COMPILE_FAILED`、`MESSAGE_NEED_COMPILE`、`MESSAGE_EMPTY_PROGRAM`）和 `parseStepCount` 留在 `program.ts`。没有「编译」按钮之后，常量文案里的「点『编译』」「程序区」要改写，例如 `MESSAGE_NEED_COMPILE` 改为「画布还没有可运行的程序：先拼积木」。
- 输出区移到 `app-shell`，见 §5。画布挂载、存档还原和积木高亮的逻辑不变。

### 4.2 工具栏模型（`viewmodel/toolbar.ts`）

`runMenuModel` 拆成两份，共用同一组禁用判据（`sessionBlocked`、`debugBlocked`、`terminalBlocked`、`artifactBlocked`）。

- `payloadControls(input)`：只有「运行」「终止」两个按钮。
  - **运行**：以下任一成立就禁用，并按这个顺序给出禁用原因：
    1. 会话不可用；
    2. 处于判题结果模式；
    3. 产物不可用（编译失败、产物过期、尚未编译）；
    4. 程序为空，且本题不允许 `run`；
    5. 正在运行。

    终止态不会禁用「运行」，因为运行会先 `reset`。
  - **终止**：只在「运行」进行中时可用。其他时候禁用，原因写「没有正在进行的运行」。
  - 两个按钮不可用时用 `aria-disabled="true"`，不用 `disabled`：按钮保持可聚焦，点击什么也不做；禁用原因经 `aria-describedby` 关联到标题栏里的一行文字，平时视觉隐藏，按钮获得键盘焦点时显示，鼠标悬停仍看 `title`。运行结束或点了「终止」后焦点不会掉回页面。
- `runMenuModel(input)`：顶栏菜单里的其余操作，即单步、运行 N 步、后退一步、撤销、重置、提交判题。删除其中的「编译」和「试运行」，其余判据不变。
- `RunCommand` 去掉 `trial-run`，加上 `run-all` 和 `abort`。`RunMenuCommand` 不再包含 `compile`。

### 4.3 控制器语义（`viewmodel/controller.ts`）

- **运行（`run-all`）**：先发 `[reset]`，再按 `MAX_ACTIONS_PER_REQUEST` 分片发送**完整**动作序列。每片返回后调用 `applyActions`，并沿用 `stopped()` 判断是否停止。程序为空时，`reset` 之后只发 `[run]`，和原来的试运行退化行为一样。
  - 运行**不在序列末尾补 `run`**。这样调试实例的结果和判题实例回放的是同一份序列，「运行」看到的就是「提交」会被判定的样子。如果末尾补 `run`，可能在终止态上撞到 `not_executable`，白白累加 `failures`。
  - 游标：`reset` 后归 0，之后每发一片就前移，和原来的试运行一致。单步仍从游标位置继续。
- **终止（`abort`）**：把正在运行的那次 `run-all` 的取消标志置位。分片循环在每次 `await` 之后检查这个标志，置位就退出，不再发后面的分片。已经发出的请求不撤回，它的响应照常 `applyActions`，实例停在那一片的末尾。终止后状态栏显示「已终止：执行到动作 n/m」。
- **运行途中改动积木**：产物过期或自动重编译换了产物后，不再发旧产物的后续分片，也不记「已终止」；提示区给一条警告「积木已修改，运行在动作 n/m 处停止」，n/m 与「已终止」同口径（m 是这一轮开始时那份产物的动作数）。
- 状态里新增 `running: boolean`，表示 `run-all` 正在进行，供「终止」按钮判断可用性。`busy` 和 `queued` 的语义不变。

## 5. 输出区与题面 Markdown

### 5.1 输出区

- 输出区挂在 `app-shell` 里，位于工作区下方，横跨整行。组件复用 `output-view.ts`，数据仍来自 `outputEntries`。
- 内容包括编译错误、执行结果和判题信息。点击条目可以定位到对应积木：`p2b-block-select` → `panel.highlight`。
- 判题结果模式下，原来程序区上方的说明文字改放在输出区顶部。

### 5.2 Markdown（重写 `viewmodel/briefing.ts`）

- 输出一棵**块与行内节点树**（纯数据），再由组件把树转成 Lit 模板。所有文本都交给 Lit 转义，**不用 `innerHTML` 或 `unsafeHTML`**，题面里的原始 HTML 按文本原样显示。
- 支持的语法：
  - **块级**：`#`–`######` 标题、段落、` ``` ` 代码块、`>` 引用、有序和无序列表（缩进 ≥2 个空格算嵌套，最多 3 层）、`---` 分隔线。
  - **行内**：`**粗体**`、`*斜体*` / `_斜体_`、`` `代码` ``、`[文字](url)`。链接只渲染「文字」，不生成 `<a>`，不放出外链。
  - 强调的边界：`*` / `**` 的开标记后面、闭标记前面不能是空白（`char *buf`、`a * b * c` 保持原文）；`_` 另外要求开标记前、闭标记后不是单词字符（`read_flag`、`FLAG_X_Y` 保持原文）。词内的 `*` 仍可强调，`foo*bar*` 是 `foo` + 斜体 `bar`。
- 段落内的单个换行显示为换行，保持现在的 `pre-line` 行为。
- 无法识别或没有闭合的标记，按原文显示。
- 提示（`hints[].text`）也用这套渲染器。

## 6. 测试与文档

- **TDD**，以下纯函数先写测试：
  - Markdown 解析器：每种语法一条用例；嵌套列表；未闭合标记；`<script>`、`<img onerror>` 只作为文本节点出现；链接只保留文字。
  - `views.ts`：`selectView`、`cycleView`（循环、跳过不可用的 I/O 和伪代码）、`normalizeActive`，以及持久化的读写和回退。
  - `toolbar.ts`：`payloadControls` 的每条禁用原因和顺序；`runMenuModel` 里已不再出现「编译」和「试运行」。
  - `controller.ts`：
    - 「运行」依次发 `reset` 和完整分片；
    - 序列末尾不补 `run`；
    - 空程序时发 `[reset]` + `[run]`；
    - 终止后不再发下一片，最后一片的响应仍会应用；
    - `running` 状态先置位，结束后复位。
- **删除或改写的测试**：`program.test.ts`（只保留常量和 `parseStepCount` 的部分）、`view-state.test.ts`、`view-interactions.test.ts`，以及 `toolbar.test.ts`、`app-shell.test.ts`、`payload-panel.test.ts`、`output.test.ts`、`controller.test.ts` 里涉及已删除功能的用例。
- **验证**：
  - `pnpm typecheck`、`pnpm test`，以及全部题目的 `pnpm challenge:solve`（虽然不改引擎，也要确认没有回归）。
  - 在浏览器里检查 320、768、1024、1440、1920 五种宽度。确认页面没有横向溢出，标签可以只用键盘操作，题面 Markdown 的各种语法都正确渲染，「运行」和「终止」按预期工作。
- **文档**：同步更新 `docs/01-基本架构.md` 和 `docs/02-已实现需求.md` 里的前端交互描述，并在 `docs/前端优化需求.md` 末尾链到本 spec。

## 7. 不在本次范围

- 底部除输出区以外的其他栏目（需求中写明「后续会安排」）。
- 浅色主题。
- 积木形状的字符化。
- 服务端的取消接口（终止只在客户端生效）。
