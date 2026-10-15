# tests/acceptance — 六组核心安全检查与需求映射

> owner：**F（验收）** · 目标日：**D3**（F01 的 D3 部分）· 基线提交：`64b7508`（D2 日终）· 对应关卡：**G1**
> 事实来源：`docs/08-Agent并行开发日程.md` §3 D3 行、§4「F：验收」、§5（S01–S06 与 T01–T06）；
> 原始清单：`docs/07-工程约定.md` §5（下文按出现顺序编号为**第 1–13 条**）。
> 安全底线：`docs/01-产品与范围.md` §6；投影与 API 契约：`docs/04-会话与API.md` §4/§5/§6。

## 0. 勾选规则：未验收不勾选，核心检查必须打在真实对象上

- 状态三态：`未验收` / `部分` / `通过`。**当前口径（D3 / F01-b）**：S01「部分」、**S02「通过」**、
  S03「部分」、**S04「部分」**、S05/S06「未验收」。S01/S03 的逐条复核归 F02（D4）。
- 未验收 / 部分的条件用 `describe.skip` + `it.todo` 承载：**跳过就是跳过**，不写任何会让 CI 假通过的占位断言，
  也不把 mock、样例或 shared 层单测当作真实接口验收（08 §1：「mock 通过不算真实接口验收」）。
- 勾选规则（08 §1）：`[ ]` 未验收，`[x]` 已验收。进行中/阻塞/待集成写交接记录。
  **未验收的条目一律不勾选，不允许因为「看起来没问题」或「后续会做」而预先勾选。**
- 核心检查必须在**真实对象**上跑：真实 `@pwn2block/engine`、真实 `@pwn2block/server`（Fastify 实例）
  与真实首题 `challenges/ret2win`。临时题目包用真实 `PublicChallengeSchema` / `PrivateChallengeSchema`
  构造后写进临时目录——不落进仓库 `challenges/`（那是 E 的地盘，也会被 `challenge:check --all` 扫到）。
- 每次勾选/改状态都要附命令与输出（§3.1 是 D3 的记录）。

## 1. 命令

| 命令 | 作用 |
|---|---|
| `pnpm exec vitest run tests/acceptance` | 跑本目录（D3：S01 28 条、S02 12 条、S03 14 条、S04 7 条真实执行；S04 剩 4 条、S05 9 条、S06 8 条仍为 todo） |
| `pnpm exec eslint tests` | 本目录 lint |
| `pnpm e2e` | Playwright 八步闭环，默认整组跳过，见 §4 |

## 2. 需求映射表

「07 §5 原始条目」列用的是 `docs/07-工程约定.md` §5 十三条的**出现顺序编号**；
「08 §5 条件」列的完整原文照抄在对应测试文件的头注释里，逐条不得删减。

| 检查 | 08 §5 条件（摘要） | 07 §5 原始条目 | owner（含配合） | 当前状态（D3） | 实际验证手段：真实对象 / 测试文件 / 关卡 |
|---|---|---|---|---|---|
| **S01** 隐藏内容边界 | 隐藏 VMA 的 `write_bytes`、隐藏栈槽的 `pop`/`ret` 被拒绝且状态不变；投影/错误/录像不含未经程序公开的隐藏字节或虚拟文件内容；隐藏区无 hex/disasm；响应不含私有 win/fail 谓词 | 第 1、2 条 | F（B/G/C 配合） | **部分**：28 条用例已在 D2 换成真实引擎 + 真实 HTTP，F02（D4）尚未逐条复核 §5 全部条件 | 真实对象：`@pwn2block/engine` 的 `createRuntime(ret2winPublic, ret2winPrivate)` + 真实 `/api/sessions/:id/actions` 响应与录像；文件：`s01-hidden-boundary.test.ts`；**G2 · D4** |
| **S02** 判题边界 | 调试 `satisfied` 不发 flag、不记录通过；`submit` 从初态回放，不能借用手工调试状态，且不修改调试实例 | 第 8、9 条 + 提交隔离 | F（B/C 配合） | **通过**（D3）：§5 的 11 条条件逐条真实用例，另加真实首题一节，逐条对照见 §3.1 | 真实对象：真实 `buildApp` + `inject`、真实引擎 `replaySubmit`（B03 纯回放）、临时 `verdict-lab`/`fail-first-lab` + 真实首题 `challenges/ret2win`；文件：`s02-verdict-boundary.test.ts`；**G2 · D4** |
| **S03** 请求边界 | 伪造快照/成功标记、未知动作、未允许的动作被拒绝；拒绝不修改状态；回退动作按契约仍可用 | 第 11、12 条 | F（C 配合） | **部分**：14 条用例已在 D2 换成真实 HTTP + 真实引擎，F02（D4）尚未逐条复核 §5 全部条件 | 真实对象：真实 Fastify 实例（`buildApp` + `inject`）与请求 Schema；文件：`s03-request-boundary.test.ts`；**G2 · D4** |
| **S04** payload 边界 | `block` 由服务端展开，不相信客户端提供的展开结果；读状态 payload 被 `rejected`，而不是变成零 | 第 10、13 条 | F（C/H 配合） | **部分**（D3）：第 10 条 + `submit` 动作 Schema/上限共 6 条按原文通过；第 13 条 `reads_state`（3 条）与「编译上限服务端复核」（1 条）无法按原文验证，如实保留 `todo`，见 §8 | 真实对象：真实服务端 + 引擎的 `expandBlock` 路径（真实内存变化观测 + 真实判胜）；文件：`s04-payload-boundary.test.ts`；**G2 · D4** |
| **S05** flag 边界 | 缺失环境变量，或虚拟文件/隐藏 VMA 内容包含注入的 flag 真值时拒绝加载；只用测试哨兵值 | 第 7 条 | F（C/E 配合） | 未验收 | 真实对象：真实服务端题目加载（`challenges/ret2win` + 环境变量注入/缺失）+ 哨兵值；文件：`s05-flag-boundary.test.ts`；**G2 · D4** |
| **S06** 发布边界 | 检查构建产物和实际静态 HTTP 路径，不能取得 `private.json`、`solution.md`、环境文件或注入的 flag 哨兵值 | 补充条目（08 §5 明说） | F（A/C 配合） | 未验收 | 真实对象：真实构建产物（`dist/`）与真实静态托管的 HTTP 路径（含目录穿越变体）；文件：`s06-publish-boundary.test.ts`；**G3 · D5** |

`docs/08` §5 明确的映射关系（照抄）：S01 覆盖第 1–2 条；S02 覆盖第 8–9 条并验证提交隔离；S03 覆盖第 11–12 条；
S04 覆盖第 10、13 条；S05 覆盖第 7 条；S06 补充静态发布检查。

## 3. 当前状态一览（D3 / F01-b 收工口径）

- [~] **S01 隐藏内容边界** — 部分：28 条用例已在 D2 换成**真实引擎 + 真实 HTTP**（投影 / 录像 / 错误正文
  与真实隐藏 VMA）；F02（D4）尚未逐条复核 §5 全部条件，所以不勾选。
- [x] **S02 判题边界** — **通过（D3）**：08 §5 的 11 条条件逐条真实用例 + 真实首题一节，
  命令与结果见 §3.1；差异项只有「不记录通过」的可观察口径（见 §8 缺口 3）。
- [~] **S03 请求边界** — 部分：14 条用例已在 D2 换成真实 HTTP + 真实引擎；F02（D4）尚未逐条复核。
- [~] **S04 payload 边界** — **部分（D3）**：6 条按原文真实通过（第 10 条全部条件 + `submit` 动作
  Schema 与 `MAX_SUBMIT_ACTIONS`），另加 1 条「线上格式无法表达读状态」的附加口径用例；
  **4 条如实保留 `todo`**（`reads_state` ×3、编译上限服务端复核 ×1，见 §8 缺口 1、2）。
- [ ] **S05 flag 边界** — 未验收（骨架，全部条件 `todo`）。
- [ ] **S06 发布边界** — 未验收（骨架，全部条件 `todo`）。

D3 的可交付结论：**S02 全部条件在真实对象上通过；S04 部分通过，差的 4 条是契约缺口（不是实现缺陷，
也不改产品代码凑绿）；S01/S03 已接真实对象、逐条复核归 F02；S05/S06 仍未验收。**

### 3.1 S02 / S04 逐条对照与命令（D3 记录）

命令：`pnpm exec vitest run tests/acceptance` → `4 passed | 2 skipped`，`61 passed | 21 todo`；
`pnpm exec tsc -p tsconfig.json`（含 `tests/acceptance/**`）→ 退出码 0。

**S02 · 08 §5 条件 → 用例 → 结果**（文件 `s02-verdict-boundary.test.ts`，12 条全绿）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 第 8 条：调试投影里永远没有 `flag` | 调试实例命中成功条件后 status 只变 `satisfied`，投影里没有 `flag` 字段 | 通过（原始响应正文断言，不靠 Schema 剥离） |
| 第 9 条：不发 flag、不新增「已通过」字段 | `satisfied` 前后的投影字段集合完全一致 | 通过（整份投影只有 `status`/`steps`/`registers` 变化） |
| 第 9 条：不记录通过 | `satisfied` 不记录通过：后续 `GET` 与再次提交都查不到通过标记 | 通过（字段集合与全新会话相同；`satisfied` 后提交赢不了的 payload 仍判 `incomplete`） |
| 04 §1.1：调试没有 `won` | 调试实例不存在 `won` 状态 | 通过（枚举 + `ready → satisfied → satisfied → failed → ready` 实测） |
| 提交隔离：不能借用手工调试状态 | 手工调试（写字节 / 单步 / 回退）后再提交同一 payload，与全新会话逐字段一致 | 通过（整份 `SubmitResponse` JSON 相等） |
| B03：判题实例从初态回放 | 录像首帧等于题目初态而不是调试态 | 通过（与全新会话初态投影逐字段相等 + 反面对照） |
| 提交隔离：不修改调试实例 | `submit` 前后调试实例投影逐字段相等（含 `failures`），`history` 不变 | 通过（`failures=1` 的会话做对照，判胜与判负各一次） |
| 提交隔离：不压调试实例快照 | `submit` 后 `undo` 仍回退到提交前的手工请求 | 通过（两次 `undo` 的逐步断言 + 历史清空后 `empty_history`） |
| 04 §5.1：四态完整、仅 `won` 带 flag | `verdict` 四态完整 | 通过（`won`/`incomplete`/`rejected`/`failed` 各一条真实路径） |
| 03 §2.1 / 04 §5.1：`fail` 优先 | 命中 `fail` 时即使 `win` 也成立仍判 `failed` | 通过（两个只差 `fail` 谓词的实验台 + 末帧 `FLAG=0x1` 的证据） |
| 04 §5.1：提交次数不限 | 连续多次 `submit` 结果互相独立 | 通过（三次判胜/判负交错后整份响应仍相等） |
| 真实首题（README §2 的对象要求） | 真实 `challenges/ret2win` + 真实 `presets/x86ish.json` 一节 | 通过（同一会话：调试 `satisfied` 不发 flag → 提交判胜发哨兵 flag，调试实例逐字段不变） |

**S04 · 08 §5 条件 → 用例 → 结果**（文件 `s04-payload-boundary.test.ts`，7 条真实 + 4 条 `todo`）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 第 10 条：`block` 只接受 `{id,args}` | 带 `expand`/`actions`/`resolved`/`template`/`bytes`/`originIndex` 的请求被 `strictObject` 拒 | 通过（`invalid_request`；`failures`/`history`/内存全不变） |
| 第 10 条：展开以题目包为准 | 客户端提供的展开结果被忽略 | 通过（真实内存变化与题目包模板逐字节一致；换参数只换字节） |
| 第 10 条：不信客户端给的地址/字节 | 客户端给出的地址/字节与题目包不一致时执行的是题目包模板动作 | 通过（伪造请求被拒 + 判胜地址来自模板 + 另一块积木判 `incomplete` 的反面对照） |
| 03 §3：未声明的积木 id | 未声明的积木 id 回 `unknown_action`，状态不变 | 通过（`executed=0`、错误对象逐字段、`failures+1`） |
| 03 §3：参数校验 | 缺参 / 多参 / 类型不符都回 `invalid_arguments`，状态不变 | 通过（6 个反例 + 2 个合法对照，内存无半截写入） |
| 04 §6：submit 动作 Schema 与上限 | 动作超 `MAX_SUBMIT_ACTIONS` 被拒、动作是 `strictObject` | 通过（4 个多字段动作被拒；4097 被拒、4096 被接受） |
| **第 13 条：读状态 payload 被 `rejected`（`reads_state`）** | **保留 `todo`（3 条）** | **无法按原文验证**：服务端没有该拒绝路径，线上格式也无法表达读状态（见 §8 缺口 1） |
| **05 §4：编译上限在服务端复核** | **保留 `todo`（1 条）** | **无法验证**：请求体只有扁平动作，服务端看不到循环/表达式结构（见 §8 缺口 2） |

## 4. E2E 骨架（`tests/e2e/**`）

- 内容：`docs/01-产品与范围.md` §3 的八步闭环（打开题目 → 创建会话 → 观察三视图 → 手工试 → 拼 payload →
  试运行 → 提交判题 → 判胜/回放），外加 08 §3 G3 行「调试不发 flag，正式提交成功才发」的附加断言。
- 默认**整组跳过**：只有 `PWN2BLOCK_E2E=1` **且真实后端在跑**时才执行。Playwright 浏览器本轮不下载。
- **D5 才做真实验收**（F03 · G3 · D5），需要真实服务端与真实首题 `ret2win`；现在每个用例体都会显式失败，
  不会在未实现时假通过——缺断言就补断言，不要改成空体。
- 运行：`$env:PWN2BLOCK_E2E='1'; pnpm e2e`（`playwright test --config tests/e2e/playwright.config.ts`）。

## 5. 延期债务归属（08 §5「延期」）

延期的只有**验证范围**，不是安全实现：`docs/07` §5.1 的不删除、不跳过、引擎覆盖率 ≥80% 继续有效。
T01–T06 不计入七天完成率，也**不得隐藏或预先勾选**（08 §7 末段）。

| 债务 | owner | 对应 07 §5 原条目 | 为什么延期 | 补测关卡 / 时间 | 前置条件 |
|---|---|---|---|---|---|
| **T01** `reveal` → `undo`/`step_back` 的跨层组合验证：重新隐藏、stdin 位置、stdout、文件偏移同时恢复 | G（B/F 配合） | 第 3 条 | 七天冲刺保留六组核心检查，专项组合验证证据不足（07 §5.1） | G4 之后 / D7 登记，正式验收前补齐 | G 的 COW 快照与 I/O 状态进快照（G02） |
| **T02** `read`/`write`/`copy` 跨 VMA、尾字节越权、无副作用完整黑盒矩阵，以及 `count > 0x1000` 截断专项 | G（F 配合） | 第 4 条 | 同上；本轮不新增模糊/矩阵设施 | 同上 | G 的权限检查与 syscall 落地（G01–G02） |
| **T03** stdin/stdout 4KB 边界及多请求累积专项黑盒验证 | G（C/F 配合） | 第 5 条 | 同上 | 同上 | G 的 I/O 与 C 的请求限制（C03） |
| **T04** 未声明 syscall 调用号的专项黑盒验证 | B（G/F 配合） | 第 6 条 | 同上 | 同上 | B 的解码与 syscall 表（B01） |
| **T05** 核心场景之外的更多位宽/权限/请求交错/错误路径组合、长时间资源压力与额外浏览器复测 | F + 各 owner | 组合与压力（08 §5 自述） | 本轮不新增模糊测试或负载测试设施 | 正式验收前 | 六题与真实 API 稳定（G2/G3） |
| **T06** 正式验收前恢复 07 的完整清单和 CI 门槛，全部复测通过后才可标记完整 MVP 验收完成 | A（F 配合） | 全部第 1–13 条 | 候选版是内部试用定位，不等同完整 MVP 验收（08 §1、§6） | D7 登记，正式比赛/非隔离使用前 | G4 交付记录 + T01–T05 完成 |

风险记录（08 §5 照抄要点）：本轮对「回退后隐藏内容是否正确恢复」「越权 I/O 是否完整回滚」「连续请求能否突破资源限制」
等场景证据不足；候选版只使用测试 flag 与非敏感题目数据，**降低暴露面不等于风险消失**。

## 6. 关联已有覆盖（**不构成** S01–S06 验收）

这些是 shared 层的契约单测，保留并继续跑；它们不能替代真实引擎 / 真实服务端的黑盒验收：

| 已有覆盖 | 与本目录的关系 |
|---|---|
| `packages/shared/test/challenge.test.ts` 的「flag 真值泄露检查（S05 语义）」 | S05 的 shared 层语义已覆盖；S05 的**服务端加载路径**仍未验收 |
| `packages/shared/test/challenge.test.ts` / `actions.test.ts` 的私有包与积木展开反例 | S03/S04 的 shared 层基础；S04 的 **REST 端到端**已由 `s04-payload-boundary.test.ts` 覆盖 |
| `packages/web/src/compiler/forbidden-state.test.ts`（H 的单测） | 读状态积木的**编译期**拒绝（`MESSAGE_READS_STATE`）；它不等于 S04 第 13 条的**服务端** `reads_state`（见 §8 缺口 1） |
| `s01-hidden-boundary.test.ts` 的字段白名单 | S01 的一部分；S01 的其余条件已在同一文件里用真实引擎 + 真实 HTTP 执行 |

## 7. 写入边界与更新规则

- F 的写入范围只有 `tests/acceptance/**` 与 `tests/e2e/**`；不改 `packages/**`、`challenges/**`、`docs/**`，
  也不改根 `package.json`、`pnpm-lock.yaml`、根配置、`vitest.config.ts` 与 CI。
- 每个 owner 负责自己模块的单测（08 §2 规则 6），F **不兜底**其它 owner 的测试；F 只做验收与黑盒集成。
- 改契约（`packages/shared` 的 Schema）必须同步更新本表与白名单常量，并在同一个提交里完成；
  「谁改契约谁更新映射」是硬要求。
- 勾选动作只由 F 在**真实对象**验收通过后执行，且附命令与输出（F04 · D7 交给 A 复核）。
  **S02 的 `[x]` 是 D3 / F01-b 完成的，证据在 §3.1；S04 只到「部分」，不勾选。**

## 8. 契约缺口（报 A，F 不自行改根配置）

1. **S04 第 13 条（`reads_state`）缺服务端口径**：错误码只在 `shared/src/errors.ts` 定义，
   `packages/server/src/**` 与 `packages/engine/src/**` 里没有任何地方会产出它；而按 04 §2 的线上动作集，
   请求体**根本无法表达「读当前状态」**（地址与值都是客户端给的十六进制字面量），所以服务端没有可触发的输入。
   真正做到编译期拒绝的是 H 的编译器（`FORBIDDEN_STATE_BLOCK_TYPES` + `MESSAGE_READS_STATE`，05 §4），
   那是前端编译错误而不是 REST 响应；而 `packages/web/**` 被根 `tsconfig.json` 的 `exclude` 排除，
   `tests/acceptance/**` 一旦 import 编译器就会破坏 `pnpm typecheck`（F 的写入范围只有 `tests/acceptance/**`）。
   需要 A 决定：在 04 §5.1 / 08 §5 写明候选版的验证口径（例如「以编译器编译期拒绝 + 线上格式不可表达为准」），
   或给验收测试开一条能 import 编译器的通道（独立 tsconfig / 额外 paths）；C 若要保留服务端兜底拒绝，
   先要定义一种能表达读状态的请求形状。**在此之前，S04 的那三条继续 `todo`。**
2. **「客户端编译上限在服务端复核」不可行**：循环展开 256、表达式求值 4096 步是编译器内部的预算
   （`limits.LOOP_UNROLL_LIMIT` / `EXPR_EVAL_STEP_LIMIT`），到服务端时请求体只剩**已经展开的扁平动作**，
   服务端看不到循环/表达式结构，无从复核。服务端能守住的量是「动作数 ≤ `MAX_SUBMIT_ACTIONS`」，
   已在 `s04-payload-boundary.test.ts` 真实执行。若要升级为服务端条件，需要 A 先改契约（例如请求体带编译摘要）。
   H 的 `packages/web/src/compiler/limits.test.ts` 覆盖编译期限流，属**编译期**证据，不替代服务端验收。
3. **「调试实例不记录通过」缺可观察接口**：`packages/server/src/sessions.ts` 只在 `submit` 路径上
   `recordSubmit`，而 `GET /api/sessions/:id` 不返回提交次数或通过记录，所以这条只能按
   「响应字段集合与全新会话一致 + `satisfied` 后提交赢不了的 payload 仍判 `incomplete`」来验证
   （S02 用例内已写明）。若 A 认为口径不够强（例如要求响应里出现可断言的提交记录），需要 C 提供观察点。
4. **根 `.gitignore` 未包含 `test-results/` 与 `playwright-report/`**（`eslint.config.js` 已经忽略它们）。
   D1 的 Playwright 配置把产物写到 `.tmp/playwright`（`.tmp/` 已在 `.gitignore` 内），避免污染集成提交；
   如果 D5 想改用默认目录，需要 A 一并补 `.gitignore`。
5. ~~根 `tsconfig.json` 没有 `@pwn2block/*` 的 `paths` 映射~~ —— **已解决（D3 复核）**：
   根 `tsconfig.json` 现在有 `shared`/`engine`/`server`/`authoring` 四条 `paths`，
   `tests/acceptance/**` 可以按包名导入，`pnpm exec tsc -p tsconfig.json` 退出码 0。
