# 前端 TUI 化与交互简化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `packages/web` 改成严格 TUI 风格：单面板标签式视图、pwndbg 排版、payload 区只剩画布与「运行 / 终止」、通栏输出区、整行状态栏、自研 Markdown 渲染。

**Architecture:** 逻辑全部落在 `src/viewmodel/*` 纯函数里先测后写（views、toolbar、controller、markdown、region），组件只做排版与事件转发。控制器新增 `run-all` / `abort` / `running`，复用现有 `applyActions`、`stopped()` 与串行队列。主题一次性换成新调色板，并用一条源码扫描测试守住「无渐变、无阴影、无圆角、无 innerHTML」。

**Tech Stack:** TypeScript、Lit 3、Blockly 13、Vite、vitest（组件测试首行 `// @vitest-environment jsdom`）、Playwright（e2e，可选）。

**Spec:** `docs/superpowers/specs/2026-10-17-frontend-tui-design.md`

## Global Constraints

- 只改 `packages/web`、`tests/e2e` 与文档；不改 `shared`、`engine`、`server`，不改 API 形状。
- 不新增任何依赖；Markdown 不用 `innerHTML` / `unsafeHTML`。
- 中文界面、中文注释；提交信息 `<type>: <中文描述>`，不加 AI 署名；暂存具体文件，不用 `git add .`；提交前 `git diff --cached --check`。
- 每个任务的提交都必须通过 `pnpm typecheck`、`pnpm lint`、`pnpm test`（CI 环境变量：`FLAG_RET2WIN` `FLAG_ENDIAN` `FLAG_PUSHPOP` `FLAG_CALLRET` `FLAG_STACKFRAME` `FLAG_LOCALVAR` 均设为 `pwn2block-ci-sentinel`）。
- 文件 ≤800 行，函数 <50 行；不可变数据；不留 `console.log`。
- 单一背景色 `--p2b-bg`；单一等宽字体、单一字号；`border-radius: 0`；只做深色，`color-scheme: dark`。
- 持久化键 `p2b:view-tab`，所有题目共用；读失败或非法值回退 `stack`，写失败不提示。
- 「运行」禁用原因顺序：会话不可用 → 判题结果模式 → 产物不可用 → 空程序且不允许 `run` → 正在运行；终止态不禁用「运行」。「终止」不可用时原因为「没有正在进行的运行」。
- `run-all` 先 `[reset]`，再按 `MAX_ACTIONS_PER_REQUEST`（512）分片发**完整**序列，末尾不补 `run`；空程序发 `[reset]` + `[run]`。
- 终止后状态栏文案「已终止：执行到动作 n/m」；状态栏格式 `DEBUG │ <状态文案> │ ip=0x… │ 动作 n/m`，保留 `role="status"` `aria-live="polite"`。
- `MESSAGE_NEED_COMPILE` = 「画布还没有可运行的程序：先拼积木」；其余文案不得再出现「点『编译』」「点「编译」」「程序区」。

## Review Focus

1. 连点两次「运行」，或在单步排队时点「运行」：只应发一次 `[reset]`，不会出现两轮 run-all 叠加。→ Task 5 测试「连点运行只跑一轮」。
2. run-all 中途网络失败或会话过期：`running` 必须复位、「终止」变灰、后续分片不再发；上一轮的终止标志不能泄漏到下一轮运行。→ Task 5 测试「中途失败复位 running」「终止标志不跨轮」。
3. 在「栈」标签下单步若干次再切到「指令」：当前 ip 行应滚入视野（隐藏时跳过的跟随滚动要在显示时补上）。→ Task 7 测试「切回标签时补做跟随滚动」。
4. localStorage 里存着 `io`、垃圾值，或 `getItem` 直接抛错，而当前题目没有 I/O：显示「栈」，没有 I/O 标签，不报错。→ Task 7 测试「存了 io 但本题无 I/O」「存储抛错」。
5. 出题人在 Windows 上写的题面（`\r\n` 换行）、`[x](javascript:alert(1))` 链接、4 层以上嵌套列表：渲染结果与 `\n` 版本一致，链接只剩文字，嵌套截到 3 层。→ Task 1 测试「CRLF 与 LF 等价」「链接只留文字」「嵌套截到 3 层」。

---

### Task 1: Markdown 解析器与题面 / 提示渲染

**Files:**
- Modify: `packages/web/src/viewmodel/briefing.ts`（整体重写）
- Create: `packages/web/src/components/markdown.ts`
- Modify: `packages/web/src/components/briefing-panel.ts:12,166-168,203`
- Test: `packages/web/test/briefing.test.ts`（重写）、`packages/web/test/briefing-panel.test.ts`（补一条）

**Interfaces:**
- Consumes: 无。
- Produces:
  ```ts
  export type MdInline =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: 'strong' | 'em' | 'link'; readonly children: readonly MdInline[] }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'break' };
  export interface MdListItem { readonly inline: readonly MdInline[]; readonly children?: MdBlock }
  export type MdBlock =
    | { readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly inline: readonly MdInline[] }
    | { readonly kind: 'paragraph'; readonly inline: readonly MdInline[] }
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'quote'; readonly blocks: readonly MdBlock[] }
    | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly MdListItem[] }
    | { readonly kind: 'rule' };
  export function parseMarkdown(text: string): readonly MdBlock[];
  export function parseInline(text: string): readonly MdInline[];
  // components/markdown.ts
  export function renderMarkdown(blocks: readonly MdBlock[]): TemplateResult;
  export function renderInline(nodes: readonly MdInline[]): TemplateResult;
  export const markdownStyles: CSSResult;
  ```
  删除 `BriefingBlock`、`briefingBlocks`、`inlineCode`。

- [ ] **Step 1: 写失败测试 `test/briefing.test.ts`**

  每种语法一条，断言精确节点树：
  ```ts
  it('标题 1–6 级', () => expect(parseMarkdown('### 栈帧')).toEqual([{ kind: 'heading', level: 3, inline: [{ kind: 'text', text: '栈帧' }] }]));
  it('段落内单个换行变 break，空行分段', () => expect(parseMarkdown('a\nb\n\nc')).toEqual([
    { kind: 'paragraph', inline: [{ kind: 'text', text: 'a' }, { kind: 'break' }, { kind: 'text', text: 'b' }] },
    { kind: 'paragraph', inline: [{ kind: 'text', text: 'c' }] },
  ]));
  it('围栏代码块原样保留，内部不解析行内', () => expect(parseMarkdown('```\n**x** <b>\n```')).toEqual([{ kind: 'code', text: '**x** <b>' }]));
  it('未闭合的围栏按段落原文显示', () => expect(parseMarkdown('```\nx')).toEqual([{ kind: 'paragraph', inline: [{ kind: 'text', text: '```' }, { kind: 'break' }, { kind: 'text', text: 'x' }] }]));
  it('> 引用内可再含块', ...);            // '> a\n> - b' → quote[paragraph a, list[b]]
  it('有序 / 无序列表', ...);             // '1. a\n2. b' ordered:true；'- a' ordered:false
  it('缩进 ≥2 空格嵌套', ...);            // '- a\n  - b' → items[0].children 是 list[b]
  it('嵌套截到 3 层', ...);               // 5 层缩进，第 4、5 层并入第 3 层的同一个 list
  it('--- 分隔线', () => expect(parseMarkdown('---')).toEqual([{ kind: 'rule' }]));
  it('行内：粗体、两种斜体、代码', () => expect(parseInline('**a** *b* _c_ `d`')).toEqual([
    { kind: 'strong', children: [{ kind: 'text', text: 'a' }] }, { kind: 'text', text: ' ' },
    { kind: 'em', children: [{ kind: 'text', text: 'b' }] }, { kind: 'text', text: ' ' },
    { kind: 'em', children: [{ kind: 'text', text: 'c' }] }, { kind: 'text', text: ' ' },
    { kind: 'code', text: 'd' },
  ]));
  it('链接只留文字', () => expect(parseInline('[x](javascript:alert(1))')).toEqual([{ kind: 'link', children: [{ kind: 'text', text: 'x' }] }]));
  it('未闭合标记按原文', () => expect(parseInline('**a `b [c](')).toEqual([{ kind: 'text', text: '**a `b [c](' }]));
  it('<script> 与 <img onerror> 只是文本', () => expect(parseInline('<script>x</script><img src=x onerror=y>')).toEqual([{ kind: 'text', text: '<script>x</script><img src=x onerror=y>' }]));
  it('CRLF 与 LF 等价', () => expect(parseMarkdown('# a\r\n\r\n- b\r\n  - c')).toEqual(parseMarkdown('# a\n\n- b\n  - c')));
  it('空串返回空数组', () => expect(parseMarkdown('')).toEqual([]));
  ```
  相邻 `text` 节点必须合并（上面断言依赖这一点）。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/briefing.test.ts`
  Expected: FAIL，`parseMarkdown is not a function`。

- [ ] **Step 3: 实现 `parseMarkdown` / `parseInline`（`viewmodel/briefing.ts`）**

  先把 `\r\n` 规范成 `\n`；按行扫描的块级状态机，引用块剥掉 `> ` 后递归 `parseMarkdown`；列表层级 = `min(3, floor(缩进/2)+1)`。行内用单遍扫描：遇到开标记就向后找同种闭标记，找不到就把开标记当文本吞下继续。

- [ ] **Step 4: 运行，确认通过**

  Run: `pnpm vitest run packages/web/test/briefing.test.ts`
  Expected: PASS。

- [ ] **Step 5: 写失败测试 `test/briefing-panel.test.ts`「题面与提示走同一渲染器，HTML 不被解析」**

  ```ts
  // 题面 '## 目标\n\n<img src=x onerror=alert(1)> **win**'，提示 text '用 `ret`'
  expect(root.querySelector('h2, h3, h4')?.textContent).toBe('目标');   // 标题按级别映射，见 Step 7
  expect(root.querySelector('img')).toBeNull();
  expect(root.querySelector('strong')?.textContent).toBe('win');
  expect(hintItem.querySelector('code')?.textContent).toBe('ret');
  ```

- [ ] **Step 6: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/briefing-panel.test.ts`
  Expected: FAIL（提示目前是纯文本，没有 `<code>`）。

- [ ] **Step 7: 实现 `components/markdown.ts` 并接入 `briefing-panel.ts`**

  标题级别映射为 `h${level + 1}`，上限 `h6`（面板自身占 `h2`）；`break` → `<br>`；`link` → `<span class="md-link">`；`rule` → `<hr>`。所有文本只经 Lit 插值。`briefing-panel` 题面与 `hints[].text` 都调用 `renderMarkdown(parseMarkdown(...))`，样式数组加入 `markdownStyles`。

- [ ] **Step 8: 运行全部 web 测试**

  Run: `pnpm typecheck && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 9: 提交**

  ```bash
  git add packages/web/src/viewmodel/briefing.ts packages/web/src/components/markdown.ts packages/web/src/components/briefing-panel.ts packages/web/test/briefing.test.ts packages/web/test/briefing-panel.test.ts
  git commit -m "feat: 题面与提示改用自研 Markdown 渲染器"
  ```

---

### Task 2: TUI 主题与全局样式清扫

**Files:**
- Modify: `packages/web/src/theme.ts`（重写 token 与 `sharedStyles`）
- Modify: `packages/web/src/components/*.ts` 的 `static styles` 与装饰性模板片段
- Modify: `packages/web/src/blocks/mount.ts:107-132`、`packages/web/src/blocks/catalog.ts:64-70`
- Create: `packages/web/test/tui-style.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces: CSS 自定义属性（后续任务只用这些）：
  `--p2b-bg #0c0c0c`、`--p2b-fg #c8c8c8`、`--p2b-dim #7a7a7a`、`--p2b-line #3a3a3a`、`--p2b-addr #8fa1b3`、`--p2b-changed #e5c07b`、`--p2b-error #e06c75`、`--p2b-hidden #c678dd`、`--p2b-ip #98c379`、`--p2b-code #d19a66`、`--p2b-stack #56b6c2`、`--p2b-data #61afef`、`--p2b-focus #e8e8e8`、`--p2b-font: ui-monospace, "Cascadia Mono", Consolas, "Noto Sans Mono CJK SC", monospace`、`--p2b-size: 14px`、`--p2b-topbar-h: 2.5rem`。
  `sharedStyles` 提供：`.box`（实线边框容器）+ `.box > .box-title`（绝对定位于上边框、`background: var(--p2b-bg)`、内容形如 `─ 标题 ─`）；按钮 `[ … ]` 外观（`::before '[ '`、`::after ' ]'`）；`:hover`/`[aria-selected=true]`/`[aria-pressed=true]`/`:active` 反显；`:focus-visible { outline: 2px solid var(--p2b-focus) }`。

- [ ] **Step 1: 写失败测试 `test/tui-style.test.ts`**

  Node 环境，用 `fs` 读 `packages/web/src/theme.ts`、`packages/web/src/blocks/mount.ts` 与 `packages/web/src/components/*.ts` 源码，逐文件断言：
  ```ts
  const banned = [/gradient\(/, /box-shadow:\s*(?!none)/, /border-radius:\s*(?!0[;\s])/, /rgba?\([^)]*\/\s*\d/, /rgba\(/, /backdrop-filter/,
    /--p2b-(accent|warn|panel|bg-alt|line-soft|shadow|terminal)/, /\/proc\/pwn2block/, /root@pwn2block/, /window-lights/, /◈/,
    /innerHTML/, /unsafeHTML/, /font-size:\s*(?!inherit|var\(--p2b-size\))/];
  for (const [file, source] of sources) for (const pattern of banned) expect(source, `${file} 命中 ${pattern}`).not.toMatch(pattern);
  expect(themeSource).toContain('color-scheme: dark');
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/tui-style.test.ts`
  Expected: FAIL，列出大量命中。

- [ ] **Step 3: 重写 `theme.ts`，并清扫所有组件样式**

  机械替换：`--p2b-accent` → `--p2b-ip`（成功 / 当前）或 `--p2b-fg`（普通强调），`--p2b-warn` → `--p2b-changed`，`--p2b-line-soft` → `--p2b-line`，所有面板底色 → `var(--p2b-bg)`；删除红黄绿三点、`/proc/pwn2block/*` 标题、`root@pwn2block:~$` 提示符、`◈` / `>` 图标、`h2::before` 圆点与 `.brand::before`。按钮文字不改，`[ ]` 由 `sharedStyles` 加。

- [ ] **Step 4: Blockly 纯色主题**

  `mount.ts` 的 `TERMINAL_THEME.componentStyles`：`workspaceBackgroundColour`/`toolboxBackgroundColour`/`flyoutBackgroundColour` = `#0c0c0c`，`toolboxForegroundColour`/`flyoutForegroundColour` = `#c8c8c8`，`scrollbarColour` = `#3a3a3a`，`scrollbarOpacity: 1`，`insertionMarkerColour` = `#e8e8e8`；`fontStyle.family` 用 `--p2b-font` 的同一串字体，`size: 14`；网格颜色 `#1a1a1a`。`catalog.ts` 五个类别色改为低饱和：start `#5f7f66`、generic `#5f6f8f`、bytes `#8f7f5f`、action `#8f5f5f`、author `#7a6a8f`。payload 面板 CSS 加 `.blocklyPath, .blocklySelected > .blocklyPath { filter: none }`。

- [ ] **Step 5: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS（含 `src/blocks/toolbox.test.ts` 的 `#rrggbb` 断言）。

- [ ] **Step 6: 提交**

  ```bash
  git add packages/web/src/theme.ts packages/web/src/components packages/web/src/blocks/mount.ts packages/web/src/blocks/catalog.ts packages/web/test/tui-style.test.ts
  git commit -m "feat: 换成严格 TUI 主题并清除装饰样式"
  ```

---

### Task 3: 指针链箭头、值区域与 pwndbg 行字段（viewmodel）

**Files:**
- Modify: `packages/web/src/viewmodel/pointer.ts:110-140`
- Create: `packages/web/src/viewmodel/region.ts`；在 `viewmodel/index.ts` 导出
- Modify: `packages/web/src/viewmodel/registers.ts`、`stack.ts`、`disasm.ts`、`memory.ts`
- Test: `packages/web/test/pointer.test.ts:66,92-93`、`stack.test.ts:84-113`、`registers.test.ts`、`disasm.test.ts`、`memory.test.ts`，新建 `packages/web/test/region.test.ts`

**Interfaces:**
- Consumes: `ProjectionReader.locate(addr)`（`reader.ts`）、`labelAt`（`labels.ts`）。
- Produces:
  ```ts
  export type ValueRegion = 'code' | 'stack' | 'data' | 'hidden' | 'unmapped';
  export function valueRegion(reader: ProjectionReader, value: bigint): ValueRegion;
  // RegisterRowModel 新增 readonly region: ValueRegion
  export function flagsLine(flags: readonly FlagRowModel[]): string;     // registers.ts
  // StackRowModel 新增 readonly prefix: string（'00:0000'）、readonly region: ValueRegion（该行字值指向的区域）
  export function stackRowPrefix(index: number, wordBytes: number): string;   // stack.ts
  // DisasmRowModel 新增 readonly symbol?: string（'vuln+0'）
  export function symbolAt(labels: readonly Label[] | undefined, addr: bigint): string | undefined;  // disasm.ts
  // VmaListRow 新增 readonly startText: string、readonly endText: string
  ```
  `PointerDescription.arrows` 改为 `—▸ a —▸ b`；`annotation` 规则见 Step 1。

- [ ] **Step 1: 改写 / 新增失败测试**

  - `pointer.test.ts:66`：`'—▸ 0x100000 —▸ 0x600000'`；`:92-93`：`'—▸ 0x100000 —▸ 0x300000'` 与 `'◂— ret (win)'`。
  - `stack.test.ts:84-113`：`'—▸ 0x7fffff00'`、`'buf'`、`'—▸ 0x400003'`、`'◂— syscall exit'`、`'—▸ 0x7fffff40'`、`'buf · "AAAAAAAA"'`。
  - annotation 规则：有伪汇编时为 `◂— ${text}`，再有标注名时追加 ` (${label})`；只有标注名时为 `label`；ASCII 为 `"…"`；隐藏说明在最前；各段以 ` · ` 连接。
  - `region.test.ts`：code VMA 内地址 → `'code'`；stack → `'stack'`；global / heap / custom → `'data'`；`hidden: true` 的 VMA → `'hidden'`；`0x10` → `'unmapped'`。
  - `registers.test.ts`：`flagsLine` 在 ZF 置位、CF/SF 清零时返回 `'FLAGS [ ZF cf sf ]'`；寄存器行 `region` 与 `valueRegion` 一致。
  - `stack.test.ts`：`stackRowPrefix(0, 8) === '00:0000'`，`stackRowPrefix(3, 8) === '03:0018'`，`stackRowPrefix(17, 4) === '11:0044'`。
  - `disasm.test.ts`：func 标注 `vuln` 起于 `0x400000`、size 16 时，`symbolAt(labels, 0x400004n) === 'vuln+4'`，`0x400010n` → `undefined`；行模型 `symbol` 取自它。
  - `memory.test.ts`：`startText` / `endText` 等于 `formatAddr(start)` / `formatAddr(start + size)`。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/pointer.test.ts packages/web/test/stack.test.ts packages/web/test/region.test.ts packages/web/test/registers.test.ts packages/web/test/disasm.test.ts packages/web/test/memory.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现**

  `valueRegion` 映射：`vma.hidden` → hidden；`kind` code → code、stack → stack、其余 → data；`locate` 返回 `undefined` → unmapped。`symbolAt` 只认 `kind === 'func'` 的标注，偏移用十进制。同步更新 `pointer.ts` 文件头注释里的 `→` 示例。

- [ ] **Step 4: 运行，确认通过**

  Run: 同 Step 2 命令，再跑 `pnpm typecheck`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/web/src/viewmodel/pointer.ts packages/web/src/viewmodel/region.ts packages/web/src/viewmodel/index.ts packages/web/src/viewmodel/registers.ts packages/web/src/viewmodel/stack.ts packages/web/src/viewmodel/disasm.ts packages/web/src/viewmodel/memory.ts packages/web/test/pointer.test.ts packages/web/test/stack.test.ts packages/web/test/region.test.ts packages/web/test/registers.test.ts packages/web/test/disasm.test.ts packages/web/test/memory.test.ts
  git commit -m "feat: 视图模型补充 pwndbg 排版所需字段与区域着色"
  ```

---

### Task 4: 删除程序区，改写编译相关文案

**Files:**
- Modify: `packages/web/src/viewmodel/program.ts`（删 `ProgramRow` 及只给程序区用的函数，保留 `MESSAGE_*`、`parseStepCount`、`stepAction`、`runAction`）
- Delete: `packages/web/src/components/program-view.ts`
- Modify: `packages/web/src/components/payload-panel.ts`（删 `.program` 段、`rejectedRowOf`、`emptyProgramMessage`、`onProgramSelect`）
- Modify: `packages/web/src/viewmodel/output.ts:53,153,170`、`packages/web/src/viewmodel/toolbar.ts`（`fallbackBlocked` 文案）
- Test: `packages/web/test/program.test.ts`、`output.test.ts`、`payload-panel.test.ts:89-128`、`app-shell.test.ts:207,411,621`

**Interfaces:**
- Consumes: 无。
- Produces: 文案常量
  - `MESSAGE_STALE = '积木已改动，正在重新编译'`
  - `MESSAGE_NEED_COMPILE = '画布还没有可运行的程序：先拼积木'`
  - `MESSAGE_COMPILE_FAILED = '编译失败：先按输出区的错误修正积木'`
  - `MESSAGE_EMPTY_PROGRAM = '画布上没有动作：未连到「开始」积木的积木不参与编译'`
  - `output.ts` 失败汇总：`编译失败：共 ${n} 条错误。`；过期：`积木已改动，下面仍是上一次的结果；编译完成前不能运行或提交。`；空闲：`还没有结果：拼好积木后点「运行」，或在顶栏「运行」菜单里单步。`
  - `fallbackBlocked`：`没有剩余动作，会退化成 ${name}，但本题不允许 ${name} 动作`

- [ ] **Step 1: 改写测试**

  `program.test.ts` 只保留常量与 `parseStepCount` 用例，并加：`for (const m of [MESSAGE_STALE, MESSAGE_NEED_COMPILE, MESSAGE_COMPILE_FAILED, MESSAGE_EMPTY_PROGRAM]) expect(m).not.toMatch(/编译」|程序区/)`。`output.test.ts` 对三处文案改为上面的精确值。`payload-panel.test.ts` 删「程序区与高亮」整组，加一条 `expect(root.querySelector('pwn2block-program-view')).toBeNull()`。`app-shell.test.ts:207,411,621` 中断言程序区的部分改为断言输出区条目与画布高亮（这三条的「编译」按钮点击改为调用 `panel.recompile()`，Task 5 删掉按钮后仍成立）。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/program.test.ts packages/web/test/output.test.ts packages/web/test/payload-panel.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现删除与文案改写**

  删除后用 `Grep "program-view|programRows|ProgramRow"` 确认没有残留引用。

- [ ] **Step 4: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/web/src/viewmodel/program.ts packages/web/src/viewmodel/output.ts packages/web/src/viewmodel/toolbar.ts packages/web/src/components/payload-panel.ts packages/web/test/program.test.ts packages/web/test/output.test.ts packages/web/test/payload-panel.test.ts packages/web/test/app-shell.test.ts
  git rm packages/web/src/components/program-view.ts
  git commit -m "refactor: 删除程序区并改写编译相关文案"
  ```

---

### Task 5: 工具栏模型与控制器的运行 / 终止

**Files:**
- Modify: `packages/web/src/viewmodel/toolbar.ts`
- Modify: `packages/web/src/viewmodel/controller.ts`（删 `trialRun`，新增 run-all / abort；`trial-run` 分支全部替换）
- Modify: `packages/web/src/components/run-menu.ts`、`packages/web/src/components/app-shell.ts:598-606`（删 compile 分支）
- Test: `packages/web/test/toolbar.test.ts`、`packages/web/test/controller.test.ts`（`trial-run` 用例 151/275/282/292/314/331/344/364/440 改为 `run-all` 语义；删 337「序列没用完时只提交剩下的动作」）

**Interfaces:**
- Consumes: `MESSAGE_*`（Task 4）。
- Produces:
  ```ts
  export type RunCommand =
    | { readonly kind: 'run-all' } | { readonly kind: 'abort' }
    | { readonly kind: 'step' } | { readonly kind: 'run-n'; readonly count: number }
    | { readonly kind: 'step-back' } | { readonly kind: 'undo' } | { readonly kind: 'reset' } | { readonly kind: 'submit' };
  export type RunButtonId = RunCommand['kind'];
  export interface PayloadControlsInput extends RunMenuInput { readonly running: boolean }
  export interface PayloadControlsModel { readonly run: RunButtonModel; readonly abort: RunButtonModel }
  export function payloadControls(input: PayloadControlsInput): PayloadControlsModel;
  export const MESSAGE_NOT_RUNNING = '没有正在进行的运行';
  export const MESSAGE_RUNNING = '正在运行：可以点「终止」';
  // run-menu.ts
  export type RunMenuCommand = RunCommand;
  // ControllerState 新增
  readonly running: boolean;
  readonly aborted?: { readonly executed: number; readonly total: number };
  ```
  `runMenuModel` 只含 step、run-n、step-back、undo、reset、submit。

- [ ] **Step 1: 写失败测试 `toolbar.test.ts`**

  ```ts
  it('payloadControls：运行的禁用原因按顺序取第一条', () => {
    const base = { ...readyInput(), running: false };          // readyInput：已有的就绪输入构造
    expect(payloadControls({ ...base, hasSession: false }).run.disabledReason).toBe('会话还没准备好：先在上面选一道题');
    expect(payloadControls({ ...base, mode: 'verdict', artifact: undefined }).run.disabledReason).toMatch(/判题结果模式/);
    expect(payloadControls({ ...base, artifact: undefined, running: true }).run.disabledReason).toBe(MESSAGE_NEED_COMPILE);
    expect(payloadControls({ ...base, artifact: emptyArtifact, allowedActions: ['step'], running: true }).run.disabledReason).toMatch(/本题不允许 run/);
    expect(payloadControls({ ...base, running: true }).run.disabledReason).toBe(MESSAGE_RUNNING);
  });
  it('终止态不禁用运行', () => expect(payloadControls({ ...readyInput(), terminal: 'failed', running: false }).run.enabled).toBe(true));
  it('终止只在运行中可用', () => {
    expect(payloadControls({ ...readyInput(), running: false }).abort).toMatchObject({ enabled: false, disabledReason: MESSAGE_NOT_RUNNING });
    expect(payloadControls({ ...readyInput(), running: true }).abort.enabled).toBe(true);
  });
  it('顶栏菜单不再有编译与试运行', () => expect(runMenuModel(readyInput()).map((b) => b.id)).toEqual(['step', 'run-n', 'step-back', 'undo', 'reset', 'submit']));
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/toolbar.test.ts`
  Expected: FAIL，`payloadControls is not a function`。

- [ ] **Step 3: 实现 `payloadControls` 并裁剪 `SPECS`**

  按钮文案 `运行` / `终止`；hint 分别为 `重置调试实例后从头执行整个程序` / `停止发送后续分片`。

- [ ] **Step 4: 运行，确认通过**

  Run: `pnpm vitest run packages/web/test/toolbar.test.ts`
  Expected: PASS。

- [ ] **Step 5: 写失败测试 `controller.test.ts`「会话控制器：运行与终止」**

  沿用 `open()`、`compileInto()`、`actionsCalls()`、`until()`、`repeatedActions()`、`api.gate()`、`api.failNext()`：
  ```ts
  it('先发 [reset]，再按 512 分片发完整序列，末尾不补 run', async () => {
    // compileInto 600 个 step；先单步 1 次让游标=1，再 run-all
    expect(calls.slice(-3).map((c) => c.length)).toEqual([1, 512, 88]);
    expect(calls.at(-3)).toEqual([{ type: 'reset' }]);
    expect(calls.slice(-2).flat()).toEqual(repeatedActions(600));   // 完整序列，不是从游标 1 开始
    expect(controller.state.cursor).toBe(600);
  });
  it('空程序发 [reset] + [run]', ...);                 // calls.slice(-2) toEqual [[{type:'reset'}],[{type:'run'}]]
  it('running 先置位，结束后复位', ...);               // run() 返回前 state.running === true；结束后 false
  it('终止后不再发下一片，已发那片的响应照常应用', ...); // gate 住第一片响应 → run({kind:'abort'}) → 放行：
                                                        // 无第三次请求；cursor === 512；state.aborted toEqual {executed:512,total:600}；running false
  it('连点运行只跑一轮', ...);                          // 同步调用两次 run({kind:'run-all'})：reset 请求只有 1 次
  it('单步在途时点两次运行：排在单步之后，只跑一轮', ...); // gate 住一次 step → 连调两次 run-all → 放行：
                                                        // 请求顺序为 [step] [reset] [分片…]，reset 只出现 1 次
  it('中途失败复位 running', ...);                      // failNext 让第二个分片失败：running false、abort 按钮禁用、无后续请求
  it('终止标志不跨轮', ...);                            // 终止一轮后再 run-all：两个分片都发出
  it('abort 不进串行队列、不发请求', ...);              // run({kind:'abort'}) 前后 api 调用数不变
  ```
  `busy` / `queued` 不是门禁，所以 run-all 可以排在 step 后面；`running` 在 `run()` 里同步置位，第二次「运行」因此被拒。

- [ ] **Step 6: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/controller.test.ts`
  Expected: FAIL。

- [ ] **Step 7: 实现控制器**

  - `blockedReason(command, options?: { readonly ignoreRunning?: boolean })`：`run-all` / `abort` 读 `payloadControls({ ...menuInput(), running: options?.ignoreRunning ? false : state.running })`，其余读 `runMenuModel`。`execute()` 复查时传 `ignoreRunning: true`。
  - `run(command)`：`abort` 在入队前处理——可用则置本轮取消标志并返回；`run-all` 通过门禁后**同步** `patch({ running: true, aborted: undefined })` 再入队。
  - `runAll()`：每轮新建一个 `{ cancelled: boolean }` 令牌（不复用全局标志）；`pushCursor()` 一次；发 `[reset]` 并 `applyActions({ kind: 'reset' }, …)`（游标归 0），`stopped()` 则返回；空程序发 `[runAction()]`；否则按 512 分片，每片 `applyActions({ kind: 'run-all' }, …)`，`nextCursor` 对 `run-all` 取 `min(total, clampedCursor() + results.length)`；每次 `await` 后检查令牌，置位时 `patch({ aborted: { executed: state.cursor, total } })` 并退出。`finally` 里 `patch({ running: false })`。
  - 任何其他命令开始执行时清掉 `aborted`。

- [ ] **Step 8: 适配 run-menu 与 app-shell**

  `run-menu.ts` 去掉 `compile` 分支；`app-shell.ts` `onRun` 直接 `this.controller?.run(command)`。`app-shell.test.ts` 里点「编译」「试运行」的用例改为 `panel.recompile()` + `controller.run({ kind: 'run-all' })`（按钮在 Task 6 出现）。

- [ ] **Step 9: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 10: 提交**

  ```bash
  git add packages/web/src/viewmodel/toolbar.ts packages/web/src/viewmodel/controller.ts packages/web/src/components/run-menu.ts packages/web/src/components/app-shell.ts packages/web/test/toolbar.test.ts packages/web/test/controller.test.ts packages/web/test/app-shell.test.ts
  git commit -m "feat: 用「运行 / 终止」取代编译与试运行"
  ```

---

### Task 6: payload 面板瘦身，输出区移到页面壳

**Files:**
- Modify: `packages/web/src/components/payload-panel.ts`
- Modify: `packages/web/src/components/app-shell.ts`（`renderLayout` 下方加输出区；新增 `payloadModel(state)`）
- Test: `packages/web/test/payload-panel.test.ts`（「输出区」组移走）、`packages/web/test/app-shell.test.ts`

**Interfaces:**
- Consumes: `payloadControls`、`PayloadControlsModel`（Task 5）；`outputEntries`（`output.ts`）。
- Produces: `Pwn2BlockPayloadPanel` 属性 `controls: PayloadControlsModel | undefined`（替代 `runModel`）；按钮点击派发 `p2b-run`，detail 为 `{ kind: 'run-all' }` / `{ kind: 'abort' }`。保留 `recompile()`、`highlight()`、`workspace`、`restoreArchive()`、`saveArchive()` 与 `p2b-compile` / `p2b-edit` 事件。

- [ ] **Step 1: 写失败测试**

  `payload-panel.test.ts`：
  ```ts
  it('标题栏只有 payload 与运行 / 终止', async () => {
    expect(bar.querySelector('.box-title')?.textContent?.trim()).toBe('payload');
    expect([...bar.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['运行', '终止']);
    expect(root.querySelector('pwn2block-output-view, pwn2block-run-menu')).toBeNull();
  });
  it('禁用按钮带原因，点击可用按钮派发 p2b-run', ...); // run 禁用时 title === disabledReason；点终止 detail toEqual {kind:'abort'}
  ```
  `app-shell.test.ts`：输出区在 `main` 之后、横跨整行（`section.output` 存在且不在 `section.right` 内）；判题结果模式下输出区顶部有「下面是调试实例的历史结果；这一轮判题的结论见上方横幅。」；点输出区条目后 `panel.workspace` 上对应积木被高亮（沿用 411 的断言方式）。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/payload-panel.test.ts packages/web/test/app-shell.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现**

  面板用 `.box` + `.box-title`，右上角两个按钮；画布 `.canvas-wrap` 填满剩余高度（`flex: 1; min-height: 0`），去掉 `clamp(18rem, 38vh, 29rem)`。输出区：`<section class="output box">` 内 `<pwn2block-output-view @p2b-block-select=${this.onBlockSelect}>`，数据与原来 payload 面板里那份 `outputEntries({...})` 一致。

- [ ] **Step 4: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/web/src/components/payload-panel.ts packages/web/src/components/app-shell.ts packages/web/test/payload-panel.test.ts packages/web/test/app-shell.test.ts
  git commit -m "feat: payload 面板只留画布与运行 / 终止，输出区改为通栏"
  ```

---

### Task 7: 标签式视图面板与持久化

**Files:**
- Modify: `packages/web/src/viewmodel/views.ts`、`keymap.ts`、`storage.ts`、`session.ts:32`、`controller.ts`（视图方法 877-891、页面创建 678、快照 926）
- Modify: `packages/web/src/components/view-manager.ts`（重写）、`view-scroll.ts`、`stack-view.ts:264-272`、`disasm-view.ts:204-209`、`top-bar.ts`（删「视图」菜单）、`app-shell.ts`
- Test: 重写 `packages/web/test/view-state.test.ts`；删 `packages/web/test/view-interactions.test.ts` 中的排序 / 槽位用例（保留「跟随 sp 时调整对齐偏移」并移入 `stack-interactions.test.ts`）；`view-follow.test.ts`、`controller.test.ts:1069`、`app-shell.test.ts:226`、新建 `packages/web/test/view-manager.test.ts`

**Interfaces:**
- Consumes: `KeyValueStore`（`storage.ts`）。
- Produces:
  ```ts
  export interface ViewManagerState { readonly active: ViewKind }
  export const VIEW_TAB_LABELS: Readonly<Record<ViewKind, string>>;   // 栈 指令 寄存器 内存 I/O
  export function createViewManagerState(active?: ViewKind): ViewManagerState;   // 缺省 'stack'
  export function selectView(state: ViewManagerState, kind: ViewKind, available: readonly ViewKind[]): ViewManagerState;
  export function cycleView(state: ViewManagerState, delta: -1 | 1, available: readonly ViewKind[]): ViewManagerState;
  export function normalizeActive(state: ViewManagerState, available: readonly ViewKind[]): ViewManagerState;
  // storage.ts
  export const VIEW_TAB_KEY = 'p2b:view-tab';
  export function readViewTab(store: KeyValueStore): ViewKind;
  export function writeViewTab(store: KeyValueStore, kind: ViewKind): void;
  // keymap.ts：viewScrollDelta 更名为 viewTabDelta，判定不变
  export function viewTabDelta(event: KeyLikeEvent): -1 | 0 | 1;
  // SessionController：删 setViewShown / moveView / scrollViews / setViewOffset，新增
  selectView(kind: ViewKind): void;
  cycleView(delta: -1 | 1): void;
  // view-manager 事件：p2b-view-select，detail { kind: ViewKind }
  // stack-view / disasm-view 新增属性 active: boolean（缺省 true）
  export function scrollRowInBody(view: HTMLElement, row: Element | null): void;   // 取代 scrollRowInSlot
  ```
  `selectView` / `cycleView` / `normalizeActive` 在结果与原状态相同时返回原对象。

- [ ] **Step 1: 写失败测试 `view-state.test.ts`**

  ```ts
  const all = VIEW_KINDS, noIo = ['stack', 'disasm', 'registers', 'memory'] as const;
  it('selectView 只接受可用标签', () => {
    expect(selectView({ active: 'stack' }, 'memory', all)).toEqual({ active: 'memory' });
    const s = { active: 'stack' } as const; expect(selectView(s, 'io', noIo)).toBe(s);
  });
  it('cycleView 首尾循环并跳过 I/O', () => {
    expect(cycleView({ active: 'memory' }, 1, noIo)).toEqual({ active: 'stack' });
    expect(cycleView({ active: 'stack' }, -1, noIo)).toEqual({ active: 'memory' });
    expect(cycleView({ active: 'memory' }, 1, all)).toEqual({ active: 'io' });
  });
  it('normalizeActive 不可用时回到栈', () => expect(normalizeActive({ active: 'io' }, noIo)).toEqual({ active: 'stack' }));
  it('持久化读写与回退', () => {
    const store = memoryStore();
    writeViewTab(store, 'registers'); expect(store.getItem('p2b:view-tab')).toBe('registers'); expect(readViewTab(store)).toBe('registers');
    store.setItem('p2b:view-tab', 'garbage'); expect(readViewTab(store)).toBe('stack');
    const throwing = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(readViewTab(throwing)).toBe('stack'); expect(() => writeViewTab(throwing, 'memory')).not.toThrow();
  });
  it('viewTabDelta：Ctrl+↑/↓ 返回 -1/1，可编辑目标里返回 0', ...);   // 沿用原 112-130 的用例改名
  ```
  `session` 相关用例（原 132 行以后）移到新文件 `packages/web/test/session.test.ts`，内容不变。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/view-state.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现 `views.ts` / `storage.ts` / `keymap.ts`**

  删除 spec §3.1 列出的全部旧导出。

- [ ] **Step 4: 运行，确认通过**

  Run: `pnpm vitest run packages/web/test/view-state.test.ts packages/web/test/session.test.ts`
  Expected: PASS。

- [ ] **Step 5: 写失败测试 `view-manager.test.ts` 与控制器 / 页面壳用例**

  ```ts
  it('标签栏是 tablist，当前标签反显且带方括号', ...);  // role=tablist；tab 文本依次 '[1 栈]' '2 指令' '3 寄存器' '4 内存' '5 I/O'；
                                                        // active 的 aria-selected=true、tabindex=0，其余 tabindex=-1
  it('五个视图常驻，非当前用 hidden', ...);             // 切到 registers 前后，stack-view 是同一个元素实例；其 tabpanel.hidden === true
  it('无 I/O 题目不渲染 I/O 视图与标签', ...);
  it('← → Home End 在标签栏上切换并移动焦点', ...);     // 每次按键派发 p2b-view-select，detail.kind 依次为期望值
  it('存了 io 但本题无 I/O：显示栈', ...);              // views={active:'io'}、available=noIo → 栈的 tabpanel 可见，无 I/O 标签
  it('底部图例一行', ...);                              // .legend 文本包含 '代码' '栈' '数据' '隐藏' '未映射'
  ```
  `controller.test.ts:1069` 改为：`controller.selectView('memory')` 后 `state.page?.views` 为 `{active:'memory'}`，且 `store.getItem('p2b:view-tab') === 'memory'`；`cycleView(1)` 从 memory 到 stack（测试题目无 I/O 时）；新会话的 `page.views.active` 来自 `readViewTab(store)`。另加「存储抛错时开局仍为栈」。
  `app-shell.test.ts:226` 改为：Ctrl+↓ 切到下一个标签；焦点在影子根内输入框时不切。
  `view-follow.test.ts`：把挂载容器从「槽位 div」改为「主体区 div」；新增两条：
  - 「隐藏的视图不滚动」：父元素 `hidden` 时 `scrollTo` 未被调用；
  - 「切回标签时补做跟随滚动」：`active=false` 时推送新投影（ip 变化）不滚动，随后 `active=true` 时 `scrollTo` 被调用一次，目标是 ip 行。

- [ ] **Step 6: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/view-manager.test.ts packages/web/test/view-follow.test.ts packages/web/test/controller.test.ts packages/web/test/app-shell.test.ts`
  Expected: FAIL。

- [ ] **Step 7: 实现组件**

  - `view-manager.ts`：`.box` 容器；标签栏 `role="tablist"` + `button role="tab"` + `aria-controls`；每个视图包在 `<div role="tabpanel" class="body" ?hidden=${kind !== active}>` 里，主体区 `overflow: auto`；渲染时用 `normalizeActive(this.views, this.available).active`；底部 `.legend` 一行，各词用对应 token 着色：`代码 栈 数据 隐藏 未映射`。
  - `view-scroll.ts`：`scrollRowInBody` 在 `view.parentElement` 内滚动；父元素或 `view` 自身 `hidden` 时直接返回。
  - `stack-view` / `disasm-view`：`updated()` 中 `active` 从 false 变 true 时也执行跟随滚动；`active` 为 false 时跳过。
  - `top-bar.ts`：删除「视图」菜单、拖动、`p2b-view-toggle` / `p2b-view-move`、`views` / `available` 属性。
  - `app-shell.ts`：`onKeyDown` 用 `viewTabDelta` → `controller.cycleView`；`@p2b-view-select` → `controller.selectView`；删 `fallbackViews` 的旧构造参数。

- [ ] **Step 8: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 9: 提交**

  ```bash
  git add packages/web/src/viewmodel/views.ts packages/web/src/viewmodel/keymap.ts packages/web/src/viewmodel/storage.ts packages/web/src/viewmodel/session.ts packages/web/src/viewmodel/controller.ts packages/web/src/components/view-manager.ts packages/web/src/components/view-scroll.ts packages/web/src/components/stack-view.ts packages/web/src/components/disasm-view.ts packages/web/src/components/top-bar.ts packages/web/src/components/app-shell.ts packages/web/test/view-state.test.ts packages/web/test/session.test.ts packages/web/test/view-manager.test.ts packages/web/test/view-follow.test.ts packages/web/test/view-interactions.test.ts packages/web/test/stack-interactions.test.ts packages/web/test/controller.test.ts packages/web/test/app-shell.test.ts
  git commit -m "feat: 视图改为单面板标签切换并记住当前标签"
  ```
  若 `view-interactions.test.ts` 已清空，用 `git rm` 删除它而不是 `git add`。

---

### Task 8: 五个视图的 pwndbg 排版

**Files:**
- Modify: `packages/web/src/components/stack-view.ts`、`disasm-view.ts`、`registers-view.ts`、`memory-view.ts`、`io-view.ts`
- Create: `packages/web/test/view-render.test.ts`
- Modify: `packages/web/test/stack-interactions.test.ts`、`view-follow.test.ts`（选择器从 `tr` 改为行元素）

**Interfaces:**
- Consumes: Task 3 的 `region`、`prefix`、`symbol`、`flagsLine`、`startText` / `endText`、`describePointerChain`；Task 7 的 `active` 与 `scrollRowInBody`。
- Produces: 每个视图的行元素为 `<div class="row">`（grid 列），当前 / 聚焦行分别带 `.ip` / `.focused` 类；值区域着色类 `.r-code` `.r-stack` `.r-data` `.r-hidden`（unmapped 不加类）；变化值带 `.changed`。命令栏为 `<div class="cmd">`。

- [ ] **Step 1: 写失败测试 `view-render.test.ts`**

  用 `test/helpers.ts` 的 `makeChallenge` / `makeProjection` 与 `createViewContext` 构造上下文，断言 `textContent` 规整空白后的结果：
  ```ts
  it('不再使用 table', () => { for (const view of allViews) expect(view.shadowRoot!.querySelector('table')).toBeNull(); });
  it('栈行：NN:OOOO│ 前缀、锚点、地址、链', ...);       // 第 0 行以 '00:0000│' 开头并含 'sp'；指向栈的行含 '—▸ 0x7fffff00'，值元素带 .r-stack
  it('栈行：隐藏字节 ??、变化字节逐个高亮', ...);      // 隐藏 VMA 的字节格文本为 '??'；diff 改了 1 字节 → 恰 1 个 .byte.changed
  it('指令行：► 当前行、<符号>、可点 <win>', ...);     // ip 行以 '►' 开头、带 .ip；含 '<vuln+0>'；目标按钮文本 '<win>'
  it('指令视图录像帧无反汇编时保留提示', ...);          // disasmNotice 文本仍出现
  it('寄存器行：*RAX 0x… (十进制) —▸ …，FLAGS 行', ...); // 变化的寄存器行以 '*RAX' 开头且值带 .changed；最后一行 'FLAGS [ ZF cf sf ]'
  it('寄存器点击值仍复制', ...);                        // 沿用现有复制断言
  it('内存：VMA 行 起始 结束 权限 大小 名称，隐藏行标注', ...); // 隐藏行带 .r-hidden 且含 '隐藏'
  it('内存：hexdump 行 地址  16 字节  |ASCII|', ...);  // 选中 code VMA 后第一行匹配 /^0x[0-9a-f]+ {2}([0-9a-f]{2} ){15}[0-9a-f]{2} {2}\|.{16}\|$/
  it('I/O：stdin / stdout 原文与已读、新写高亮不变', ...);
  ```

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/view-render.test.ts`
  Expected: FAIL（视图仍是 table）。

- [ ] **Step 3: 逐个视图改写渲染层**

  不改交互逻辑：栈的跳转、跟随 sp、对齐偏移、字节搜索，指令的点击目标与函数列表（放进 `.cmd`），寄存器复制，内存选中 VMA，全部沿用。`disasm-view` 的滚动选择器改为 `.row.ip` / `.row.focused`。

- [ ] **Step 4: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS（`tui-style.test.ts` 仍通过）。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/web/src/components/stack-view.ts packages/web/src/components/disasm-view.ts packages/web/src/components/registers-view.ts packages/web/src/components/memory-view.ts packages/web/src/components/io-view.ts packages/web/test/view-render.test.ts packages/web/test/stack-interactions.test.ts packages/web/test/view-follow.test.ts
  git commit -m "feat: 五个视图改为 pwndbg 风格逐行排版"
  ```

---

### Task 9: 页面骨架与状态栏

**Files:**
- Modify: `packages/web/src/viewmodel/session.ts`（新增 `statusBar`，删 `statusLine`）
- Modify: `packages/web/src/components/app-shell.ts`（`:host`、区块顺序、工作区高度、状态栏）
- Test: `packages/web/test/session.test.ts`、`packages/web/test/app-shell.test.ts`

**Interfaces:**
- Consumes: `ControllerState.aborted`（Task 5）、`roleValue`（`roles.ts`）、`formatAddrShort`。
- Produces:
  ```ts
  export interface StatusBarInput {
    readonly mode: PageMode; readonly projection: Projection; readonly ip?: bigint;
    readonly cursor: number; readonly total: number;
    readonly aborted?: { readonly executed: number; readonly total: number };
  }
  export const STATUS_MODE_TAGS: Readonly<Record<PageMode, string>>;   // { debug: 'DEBUG', verdict: 'VERDICT' }
  export function statusBar(input: StatusBarInput): string;
  ```

- [ ] **Step 1: 写失败测试**

  `session.test.ts`：
  ```ts
  expect(statusBar({ mode: 'debug', projection: running, ip: 0x400000n, cursor: 3, total: 10 }))
    .toBe(`DEBUG │ ${statusTextOf(running, 'debug').text} │ ip=0x400000 │ 动作 3/10`);
  expect(statusBar({ mode: 'debug', projection: running, cursor: 512, total: 600, aborted: { executed: 512, total: 600 } }))
    .toBe('DEBUG │ 已终止：执行到动作 512/600 │ ip=— │ 动作 512/600');
  expect(statusBar({ mode: 'verdict', projection: running, cursor: 0, total: 0 })).toMatch(/^VERDICT │/);
  ```
  `app-shell.test.ts`：区块顺序为 top-bar → notice? → briefing → verdict? → `main` → `section.output` → `p.status`（按 `renderRoot.children` 的顺序断言）；状态栏 `role=status`、`aria-live=polite`、文本以 `DEBUG │` 开头；无产物时以 `动作 0/0` 结尾。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm vitest run packages/web/test/session.test.ts packages/web/test/app-shell.test.ts`
  Expected: FAIL。

- [ ] **Step 3: 实现**

  `:host` 去掉 `height: 100dvh; overflow: hidden`；`main { height: max(28rem, calc(100dvh - var(--p2b-topbar-h))) }`；`@media (max-width: 980px)` 改为单列、每块 `min-height: 32rem`、`main` 高度 `auto`。状态栏整行反显（`color: var(--p2b-bg); background: var(--p2b-fg)`）。`ip` 用 `roleValue(view.projection, context.roles, 'ip')`，`total` 取 `state.artifact.artifact?.actions.length ?? 0`。

- [ ] **Step 4: 运行**

  Run: `pnpm typecheck && pnpm lint && pnpm vitest run packages/web`
  Expected: PASS。

- [ ] **Step 5: 提交**

  ```bash
  git add packages/web/src/viewmodel/session.ts packages/web/src/components/app-shell.ts packages/web/test/session.test.ts packages/web/test/app-shell.test.ts
  git commit -m "feat: 页面改为整页滚动并加入底部状态栏"
  ```

---

### Task 10: 文档、e2e 与整体验证

**Files:**
- Modify: `docs/01-基本架构.md`、`docs/02-已实现需求.md`（第 7 行题面 Markdown、第 14 行试运行等前端交互描述）、`docs/前端优化需求.md`（末尾链接 spec）
- Modify: `tests/e2e/closed-loop.spec.ts:382-712`、`desktop-smoke.spec.ts`、`frontend-details.spec.ts`、`gestures.ts`

**Interfaces:**
- Consumes: 前面所有任务的界面：payload 标题栏的「运行」「终止」、顶栏「运行」菜单（不含编译 / 试运行）、`role="tab"` 标签、通栏输出区、底部状态栏。
- Produces: 无。

- [ ] **Step 1: 更新 e2e**

  「编译」点击删除（编辑积木会自动编译）；「试运行」改为点 payload 标题栏的「运行」；程序区断言改为输出区或状态栏 `动作 n/m` 断言；视图菜单操作改为点标签或 Ctrl+↓。`desktop-smoke` 保留 `scrollWidth <= innerWidth` 断言。

- [ ] **Step 2: 更新文档**

  `docs/01`、`docs/02` 只改前端交互描述：标签式视图与 `p2b:view-tab`、运行 / 终止语义（先 reset、完整序列、不补 run、终止只在客户端生效）、Markdown 支持范围、程序区已删除。`docs/前端优化需求.md` 末尾加一行指向 `superpowers/specs/2026-10-17-frontend-tui-design.md`。

- [ ] **Step 3: 全量验证**

  Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm challenge:check --all && pnpm challenge:solve --all`（带 Global Constraints 里的 6 个 FLAG 环境变量）
  Expected: 全部通过，`challenge:solve` 每题判胜。

- [ ] **Step 4: e2e 与浏览器宽度检查**

  Run: 另开终端 `pnpm start`，再 `PWN2BLOCK_E2E=1 pnpm e2e`
  Expected: PASS。起不来服务时如实记录原因。
  再用 Playwright 或浏览器分别在 320、768、1024、1440、1920 宽度检查：无横向溢出；只用键盘能切换全部标签；题面里标题、列表、代码块、引用、分隔线、粗体、斜体、行内代码、链接都正确；「运行」跑完、「终止」在长程序中途生效且状态栏显示「已终止：执行到动作 n/m」。

- [ ] **Step 5: 提交**

  ```bash
  git add docs/01-基本架构.md docs/02-已实现需求.md docs/前端优化需求.md tests/e2e/closed-loop.spec.ts tests/e2e/desktop-smoke.spec.ts tests/e2e/frontend-details.spec.ts tests/e2e/gestures.ts
  git commit -m "docs: 同步前端 TUI 化后的交互说明与 e2e"
  ```
