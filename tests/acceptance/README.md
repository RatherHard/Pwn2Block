# tests/acceptance — 六组核心安全检查与需求映射

> owner：**F（验收）** · 目标日：**D4**（F02：S01/S03/S04 逐条复核 + API 生命周期/终态）· 基线提交：`e466dc2`（D4 起点）· 对应关卡：**G2 · D4**
> 事实来源：`docs/08-Agent并行开发日程.md` §3 D4 行、§4「F：验收」、§5（S01–S06 与 T01–T06）；
> 原始清单：`docs/07-工程约定.md` §5（下文按出现顺序编号为**第 1–13 条**）；
> D3 定稿的验收口径：`docs/09-契约冻结.md` §7/§8（本文件引用处一律写明第几条）。
> 安全底线：`docs/01-产品与范围.md` §6；投影与 API 契约：`docs/04-会话与API.md` §1/§1.1/§4/§5/§5.1/§6；
> 编译期防线（`reads_state`、编译上限、唯一开始块）：`docs/05-前端交互.md` §3.1/§4。

## 0. 勾选规则：未验收不勾选，核心检查必须打在真实对象上

- 状态三态：`未验收` / `部分` / `通过`。**当前口径（D4 收工）**：**S01「通过」**、
  **S02「通过」**、**S03「通过」**、**S04「通过」**（第 13 条 4 项口径如实保留 `todo`）、
  **S05「部分」**（1 条运维 todo）、**S06「通过」**（D4 提前验收；08 §3 原排期在 D5，G3 关卡仍按 §3 在 D5 复核）。
  逐条对照见 §3.1（D3 记录：S02 / S05）与 §3.2（D4 记录：S01 / S03 / S04 与 API 生命周期）。
- 未验收 / 部分的条件用 `describe.skip` + `it.todo` 承载：**跳过就是跳过**，不写任何会让 CI 假通过的占位断言，
  也不把 mock、样例或 shared 层单测当作真实接口验收（08 §1：「mock 通过不算真实接口验收」）。
- **已知缺陷用 `it.fails` 承载（D4 新增口径）**：断言**原样保留、不放宽**，只把「当前会失败」这件事
  显式标出来 —— vitest 报 `1 expected fail`，套件仍绿；一旦产品代码修好，这条会**变红**，由 A 在集成时
  摘掉 `it.fails` 标记转入正常用例。**不许**反过来删断言、改成模糊断言或降级成 `todo` 来换绿色。
  **当前 0 条**：唯一一条（S04 的多动作积木整块回滚，§8 缺口 7）已由 BG06 修掉、由 A 摘除标记转入
  正常断言。修复的证据就是这条用例从「当前会失败」翻成「通过」——摘标记**之前**实测报
  `Error: Expect test to fail`，摘掉后 104 条全通过。
- 勾选规则（08 §1）：`[ ]` 未验收，`[x]` 已验收。进行中/阻塞/待集成写交接记录。
  **未验收的条目一律不勾选，不允许因为「看起来没问题」或「后续会做」而预先勾选。**
  已发现反例的条件（即使反例本身登记为「已知缺陷」）**一律不勾选**。
- 核心检查必须在**真实对象**上跑：真实 `@pwn2block/engine`、真实 `@pwn2block/server`（Fastify 实例）
  与真实首题 `challenges/ret2win`。临时题目包用真实 `PublicChallengeSchema` / `PrivateChallengeSchema`
  构造后写进临时目录——不落进仓库 `challenges/`（那是 E 的地盘，也会被 `challenge:check --all` 扫到）。
- 每次勾选/改状态都要附命令与输出（§3.1 是 D3 的记录，§3.2 是 D4 的记录）。

## 1. 命令

| 命令 | 作用 |
|---|---|
| `pnpm exec vitest run tests/acceptance` | 跑本目录（D4 收工实测：**104 条真实执行 + 5 条 `todo`**，0 失败、0 expected fail；逐文件：S01 30、S02 13、S03 15、S04 10+4`todo`、S05 8+1`todo`、S06 8、`api-lifecycle` 20） |
| `pnpm typecheck` / `pnpm lint` | 类型检查 / lint（D4 实测均退出码 0） |
| `pnpm exec eslint tests` | 本目录 lint |
| `pnpm e2e` | Playwright 八步闭环，默认整组跳过，见 §4 |

## 2. 需求映射表

「07 §5 原始条目」列用的是 `docs/07-工程约定.md` §5 十三条的**出现顺序编号**；
「08 §5 条件」列的完整原文照抄在对应测试文件的头注释里，逐条不得删减。

| 检查 | 08 §5 条件（摘要） | 07 §5 原始条目 | owner（含配合） | 当前状态（D3） | 实际验证手段：真实对象 / 测试文件 / 关卡 |
|---|---|---|---|---|---|
| **S01** 隐藏内容边界 | 隐藏 VMA 的 `write_bytes`、隐藏栈槽的 `pop`/`ret` 被拒绝且状态不变；投影/错误/录像不含未经程序公开的隐藏字节或虚拟文件内容；隐藏区无 hex/disasm；响应不含私有 win/fail 谓词 | 第 1、2 条 | F（B/G/C 配合） | **通过（D4 / F02）**：08 §5 的每条条件都有真实引擎 + 真实 HTTP 用例，D4 另加**多形态泄露扫描**（4 个秘密 × 4 种编码，含正/负对照）；逐条对照见 §3.2.1 | 真实对象：真实 `@pwn2block/engine` 的 `createRuntime` + 真实 `buildApp` + `inject` 与真实首题 `challenges/ret2win`；文件：`s01-hidden-boundary.test.ts`；**G2 · D4** |
| **S02** 判题边界 | 调试 `satisfied` 不发 flag、不记录通过；`submit` 从初态回放，不能借用手工调试状态，且不修改调试实例 | 第 8、9 条 + 提交隔离 | F（B/C 配合） | **通过**（D3）：§5 的 11 条条件逐条真实用例，另加真实首题一节，逐条对照见 §3.1 | 真实对象：真实 `buildApp` + `inject`、真实引擎 `replaySubmit`（B03 纯回放）、临时 `verdict-lab`/`fail-first-lab` + 真实首题 `challenges/ret2win`；文件：`s02-verdict-boundary.test.ts`；**G2 · D4** |
| **S03** 请求边界 | 伪造快照/成功标记、未知动作、未允许的动作被拒绝；拒绝不修改状态；回退动作按契约仍可用 | 第 11、12 条 | F（C 配合） | **通过（D4 / F02 + BG06）**：15 条真实用例覆盖全部条件，D4 新增**逐字段比对**的拒绝用例；唯一那条反例（多动作积木中途被拒时内存留半截写入，§8 缺口 7）已由 BG06 修掉，A 用真实 HTTP 复验该用例翻绿，按 §0 勾选；逐条对照见 §3.2.2 | 真实对象：真实 Fastify 实例（`buildApp` + `inject`）与请求 Schema + 真实引擎；文件：`s03-request-boundary.test.ts`；**G2 · D4** |
| **S04** payload 边界 | `block` 由服务端展开，不相信客户端提供的展开结果；读状态 payload 被 `rejected`，而不是变成零 | 第 10、13 条 | F（C/H 配合） | **通过（D4 / F02 + BG06）**：第 10 条全部条件（含多动作积木整块展开与原子性）共 **10 条真实用例通过**——原来那条 `it.fails`（调试实例整块回滚）已随 BG06 修复由 A 摘掉标记、转入正常断言；第 13 条 `reads_state`（3 条）与「编译上限服务端复核」（1 条）按 09 §8 第 4–5 条口径**如实保留 `todo`**（是口径项，不是未实现）；逐条对照见 §3.2.3 | 真实对象：真实服务端 + 引擎的 `expandBlock` 路径（真实内存变化观测 + 真实判胜/判负）；文件：`s04-payload-boundary.test.ts`；**G2 · D4** |
| **S05** flag 边界 | 缺失环境变量，或虚拟文件/隐藏 VMA 内容包含注入的 flag 真值时拒绝加载；只用测试哨兵值 | 第 7 条 | F（C/E 配合） | **部分**（D3）：08 §5 的两类拒绝（缺 env / 内容含注入真值，含大小写变体）共 8 条真实用例通过；「加载失败的服务端告警/日志」1 条保留 `todo`（无日志出口，见 §8 缺口 4） | 真实对象：真实 `buildApp` + `inject` + 真实首题 `challenges/ret2win` + 真实首题副本注入哨兵 + shared 的 `checkChallengePair` 原因核对；文件：`s05-flag-boundary.test.ts`；**G2 · D4** |
| **S06** 发布边界 | 检查构建产物和实际静态 HTTP 路径，不能取得 `private.json`、`solution.md`、环境文件或注入的 flag 哨兵值 | 补充条目（08 §5 明说） | F（A/C 配合） | **通过（D4 提前验收，F03 + C04）**：8 条条件全部是真实断言，对象是**真实构建产物**与**真实静态 HTTP 路径**（`pnpm build` 后 `pnpm vitest run tests/acceptance/s06-publish-boundary.test.ts` → `8 passed`，executed 8 / skipped 0）。**原阻塞理由「服务端根本没有静态托管」已消失**（C04：`packages/server/src/static.ts` + `buildApp` 的 `staticRoot`/`serveStatic`） | 真实对象：真实 `packages/web/dist`（`pnpm build` 产出）+ 真实 `buildApp` + `inject`，含消融对照（把静态根指向仓库根即取到仓库文件）与「从 `index.html` 解析真实 `assets/*` 再取」的防假阳性对照；文件：`s06-publish-boundary.test.ts`；**G3 · D5（D4 提前做完）** |
| **API 生命周期/终态**（08 §3 D4 行，**不属 S01–S06**） | 会话创建/过期/回收；`reset`/`undo`/`step_back` 三层回退按契约工作；四种 verdict 的终态；`exited` vs `failed` 边界（`status==='satisfied'` 但 `lastStop.reason==='exit'` 时执行类动作被拒、回退类可用）；`submit` 不修改调试实例 | 08 §3 D4 行「F：API 生命周期/终态」 | F（B/C 配合） | **通过（D4 / F02）**：20 条真实 HTTP 用例（真实假时钟会话回收、真实三层回退、真实四种终态），逐条对照见 §3.2.4 | 真实对象：真实 `buildApp` + `inject` + 真实引擎 + 4 个临时实验台；文件：`api-lifecycle.test.ts`；**G2 · D4** |

`docs/08` §5 明确的映射关系（照抄）：S01 覆盖第 1–2 条；S02 覆盖第 8–9 条并验证提交隔离；S03 覆盖第 11–12 条；
S04 覆盖第 10、13 条；S05 覆盖第 7 条；S06 补充静态发布检查。

## 3. 当前状态一览（D4 / F02 收工口径）

- [x] **S01 隐藏内容边界** — **通过（D4 / F02）**：30 条真实用例，08 §5 的每条条件逐个复核完毕
  （含 D4 新增的多形态泄露扫描：4 个秘密 × 4 种编码，正对照可达、10 个真实响应零命中），
  逐条对照见 §3.2.1。**没有发现反例**，因此按 §0 勾选。
- [x] **S02 判题边界** — **通过（D3）**：08 §5 的 11 条条件逐条真实用例 + 真实首题两节
  （含「判胜 payload 接尾随执行动作」的回归用例），命令与结果见 §3.1；
  差异项只有「不记录通过」的可观察口径（见 §8 缺口 3）。D4 未改动该文件。
- [x] **S03 请求边界** — **通过（D4 / F02 + BG06）**：15 条真实用例，四类拒绝、未知/未允许动作、回退仍可用
  都已逐条复核，并新增「被拒绝的请求逐字段比对状态」；那条唯一的反例（多动作积木中途被拒时，前一条
  已生效的原语留在内存里，§8 缺口 7）已由 **BG06 修掉**，A 在集成时用真实 HTTP 复验该用例从
  「当前会失败」翻成「通过」，因此按 §0 勾选。逐条对照见 §3.2.2。
- [x] **S04 payload 边界** — **通过（D4 / F02 + BG06）**：**10 条真实通过**（`block` 只接受 `{id,args}`、
  客户端展开被忽略、题目包模板地址/字节说了算、`unknown_action`、`invalid_arguments`、
  多动作积木整块展开 + `executed` 按 1 个动作计、判题实例的整块回滚、**调试实例的整块回滚（原 `it.fails`，
  已随 BG06 转正常断言）**、`submit` 动作 Schema 与 `MAX_SUBMIT_ACTIONS` 边界）；
  **4 条如实保留 `todo`**（`reads_state` ×3、编译上限服务端复核 ×1，按 09 §8 第 4–5 条口径，
  见 §3.2.3 与 §8 缺口 1、2）。
- [~] **S05 flag 边界** — **部分（D3）**：**8 条真实**（缺 `FLAG_RET2WIN` 时真实首题不加载 + 503、
  注入哨兵后的正对照、真实首题副本未注入的消融对照、虚拟文件含注入真值、隐藏 VMA 含注入真值、
  大小写变体同样被拒、`challenges/**` 与 `.env.example` 里没有真值、503 正文不泄露细节）；
  **1 条如实保留 `todo`**（加载失败的服务端告警/日志没有出口，见 §8 缺口 4）。
- [x] **API 生命周期/终态**（08 §3 D4 行，不属 S01–S06）— **通过（D4 / F02）**：20 条真实 HTTP 用例，
  含假时钟下的空闲回收与配额释放、三层回退、四种 verdict 终态、`exited` vs `failed` 边界，
  逐条对照见 §3.2.4。
- [x] **S06 发布边界** — **通过（D4 提前验收，F03 + C04）**：8 条 `it.todo` 全部转成真实断言（真实构建产物
  + 真实静态 HTTP，`8 passed`，executed 8 / skipped 0）。C04 已把静态托管合进基线，本节原来的阻塞理由
  「服务端根本没有静态托管」不再成立。**提前做完不等于 G3 关卡在 D4 勾选**：G3 仍按 08 §3 在 D5 复核。

D4 的可交付结论：**S01、S03、S04、S06 与「API 生命周期/终态」都在真实对象上通过；S05 维持「部分」
（唯一 todo 是 D6 的加载失败日志出口）；S02 维持 D3 结论。**
`todo` 总数 13 → **5**（S06 的 8 条 todo 全部转成真实断言；S04 4 条 + S05 1 条口径/运维项保留），
真实执行数 70 → **104**（**0 条 `it.fails`**：唯一一条已随 BG06 修复转入正常断言）。

### 3.1 D3 记录（保留）：S02 / S04 / S05 逐条对照与命令

命令：`pnpm exec vitest run tests/acceptance` → `5 passed | 1 skipped`，`70 passed | 13 todo`；
`pnpm exec tsc -p tsconfig.json`（含 `tests/acceptance/**`）→ 退出码 0。
（D4 之后的实跑数字见 §3.2；本节保留 D3 当时的记录，S02 的勾选证据在这里。）

**S02 · 08 §5 条件 → 用例 → 结果**（文件 `s02-verdict-boundary.test.ts`，13 条全绿）

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
| 04 §5.1：程序退出后判题实例不能交互 | 判胜 payload 末尾接执行类动作仍判 `won` | 通过（`[gets, step3]`、`+step1`、`+2×step1` 都判 `won` 且发 flag；尾随动作未执行：`executed=2`、`results` 长度 2；返回地址指向退出路径的对照判 `failed` 且无 flag） |

**S04 · 08 §5 条件 → 用例 → 结果**（文件 `s04-payload-boundary.test.ts`，**D3 当时**是 7 条真实 + 4 条 `todo`；
D4 之后为 9 条真实 + 1 条 `it.fails` + 4 条 `todo`，最新对照见 §3.2.3）

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

**S05 · 08 §5 条件 → 用例 → 结果**（文件 `s05-flag-boundary.test.ts`，8 条真实 + 1 条 `todo`）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 缺失环境变量 → 拒绝加载该题 | 缺失 `FLAG_RET2WIN`：真实首题不加载、不出现在列表里，请求它回 503 `challenge_unavailable` | 通过（服务照常启动；列表为空；详情与会话都 503；磁盘上没有的 id 仍 404 作反向对照） |
| 同上（正对照，**必须成对**） | 注入哨兵后同一真实首题正常加载：列表含 `ret2win`、建会话 200 | 通过（公开包不含 `flag`/私有字段/哨兵；建会话 `projection.status='ready'`） |
| 第 7 条：虚拟文件内容含 flag 真值 | 虚拟文件内容包含注入的哨兵真值：拒绝加载该题 | 通过（原因精确为 `files.3 虚拟文件内容包含 flag 真值，拒绝加载`；列表为空 + 503） |
| 第 7 条：隐藏 VMA 内容含 flag 真值 | 隐藏 VMA 内容包含注入的哨兵真值：拒绝加载该题 | 通过（原因为 `vmas.secret 隐藏 VMA 的内容包含 flag 真值，拒绝加载`；列表为空 + 503） |
| 大小写变体 | 哨兵真值的大小写变体同样被拒绝 | 通过（先证明逐字节精确匹配不到、忽略大小写能匹配，再断言拒绝原因与 503） |
| 哨兵值只用 `TEST_FLAG_SENTINEL`（不把真值写进仓库） | `challenges/**` 的 flag 字段只写 `env:FLAG_<ID 大写>`，仓库里没有 flag 真值 | 通过（逐题断言 flag 字段形态 + 题目内容不含哨兵/`flag{`；`.env.example` 的取值只能是文档化哨兵） |
| 拒绝加载不下发细节（04 §6） | 拒绝加载时不下发细节：503 正文是固定文案，不含命中位置、文件路径或私有包内容 | 通过（缺 env 与内容泄漏两条路径都逐字断言固定 message 与两个字段，且无路径/文件名/issue 文案/堆栈） |
| **加载失败的服务端告警/日志** | **保留 `todo`（1 条）** | **黑盒不可观察**：实现里没有加载失败日志出口，`issuesFor()` 不在包导出面（见 §8 缺口 4） |

### 3.2 D4 记录（F02）：S01 / S03 / S04 与 API 生命周期逐条对照

命令与结果（D4 实跑，2026 年 D4 当日）：

```
pnpm exec vitest run tests/acceptance
 Test Files  7 passed (7)
      Tests  104 passed | 5 todo (109)                        ← 退出码 0（D4 收工）
pnpm typecheck                                                  ← 退出码 0
pnpm lint                                                       ← 退出码 0
```

（摘掉 `it.fails` 标记**之前**的中间态是 `95 passed | 1 expected fail | 13 todo`；BG06 修好后那条
变成"预期要失败却通过了"，vitest 报 `Error: Expect test to fail`——这正是修复生效的证据，随后由 A
在集成时摘掉标记。）

**计数口径（D4 收工）**：真实执行 **104** 条，**全部通过**，**0 条 `it.fails`**；`todo` **5** 条
= S04 的 4 条口径项 + S05 的 1 条运维项（S06 的 8 条已全部转成真实断言）。
逐文件：`s01` 30、`s02` 13、`s03` 15、`s04` 14（10 + 4 todo）、
`s05` 9（8 + 1 todo）、`s06` 8、`api-lifecycle` 20。

#### 3.2.1 S01 · 08 §5 条件 → 用例 → 结果（30 条，全部通过 → 勾选）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 第 1 条：隐藏 VMA 的 `write_bytes` 被拒 | 隐藏代码 VMA 的 `write_bytes` → `hidden_address`、VM 状态逐字段不变且不压快照（引擎级）；跨隐藏栈 VMA 的区间同样被拒；HTTP 版：回 `hidden_address`、状态逐字段不变、错误文案不含隐藏字节 | 通过（三处都是真实引擎 / 真实 HTTP，状态比对是逐字段 + `stateFingerprint`） |
| 第 1 条：积木不能绕过隐藏检查 | 出题人积木展开写入隐藏区同样回 `hidden_address`（引擎级 + HTTP 版）；写非隐藏栈的积木照常生效 | 通过（正反对照成对出现） |
| 第 2 条：隐藏栈槽的 `pop`/`ret` 被拒且状态不变 | 栈槽落在隐藏 VMA 时 `pop` 回 `hidden_address`（`RSP` 一个字节不动）、`ret` 回 `hidden_address`（`ip` 不动）；HTTP 版两条都断言逐字段不变；对照：`RSP` 落在非隐藏栈时 `pop`/`ret` 正常生效 | 通过（对照用例证明前两条不是空断言） |
| 第 2 条：投影 / 错误 / 录像不含未经程序公开的隐藏字节与虚拟文件内容 | 投影正文不含隐藏 VMA 内容、虚拟文件内容、哨兵真值与 `win`/`fail` 谓词字段；提交录像只含公开投影；投影样例 JSON 里不出现上述任何一项；**D4 新增**：多形态泄露扫描的正对照（4 个秘密 × 4 种编码，每个都能被命中）与**全流程 10 个真实响应零命中**（列表 / 公开包 / 建会话 / 投影 / 隐藏区写错误 / 隐藏栈 `pop` 错误 / 积木越权错误 / 判胜录像 / 未知会话 404 / 未知题目 404） | 通过（零命中断言非空转：正对照可达 + 每个形态的命中数逐个断言；另有 `expectNoInternalLeak` 与 `aa...` / `0x600000` / `4142` 等非空性抽样） |
| 第 2 条：隐藏区没有 `hex` / `disasm` | 隐藏 VMA 在投影里只有布局（`hidden: true`、不带 `hex`）；创建会话响应同样；`disasm` 不覆盖隐藏区域（对照：把同一 VMA 设为非隐藏后确实会被反汇编）；HTTP 投影里的 `disasm` 只覆盖非隐藏可执行区；非隐藏 VMA 带 `hex`（非空断言） | 通过（每条都配了反面对照，避免「全都不带 hex」的假阳性） |
| 第 1 条：响应不含私有 `win` / `fail` 谓词 | 投影 / 录像 / 公开包契约**任何层级**都不存在禁止字段（递归扫描 Schema 声明）；解析前的形状样例在任何层级都没有禁止字段；`ProjectionSchema` / `VmaViewSchema` / `ReplayFrameSchema` 字段集合固定；投影 `roles` 只含 `sp`/`bp`/`ip`；公开包 Schema 拒收 `flag`/`win`/`fail`/`files`/`roles`；下发给浏览器的公开包样例不带私有 VMA 内容；样例私有包的 `flag` 只写 `env:` 引用 | 通过（递归扫描 + 逐响应键集扫描两层） |

结论：**每条条件都有真实对象上的用例、每条关键断言都配了正/反面对照，未发现反例 → S01 勾选。**

#### 3.2.2 S03 · 08 §5 条件 → 用例 → 结果（15 条；条件与反例的差别见末行）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 第 11 条：伪造判胜结果 / 成功标记被拒 | 伪造判胜结果 / 成功标记的请求体被 `strictObject` 拒绝，且状态不变 | 通过（`invalid_request`；`failures` / `history` / 内存全不变） |
| 第 11 条：伪造快照 / 客户端状态被拒 | 伪造快照 / 客户端状态的请求体被拒绝（`snapshot`/`state`/`verdict` 等字段） | 通过（服务端不接受任何客户端状态） |
| 第 11 条：`submit` 与建会话同样拒绝 | 提交接口与创建会话同样拒绝伪造的判胜结果与快照 | 通过（三条路径同一口径） |
| 第 11 条：未知动作被拒 | 未知动作名在请求 Schema 层被拒；未声明的积木 id 才回 `unknown_action` | 通过（两条路径的错误码不同且都正确） |
| 第 12 条：未允许的动作被拒 | 不在 `allowedActions` 里的动作被拒（`action_not_allowed`），状态不变且不压快照；对照：允许集内动作照常生效、`block` 始终可用 | 通过 |
| 第 12 条：**拒绝不修改状态** | **D4 新增**：被拒绝的请求逐字段比对——投影每个字段（含每个 VMA 的 `hex`）单独断言不变；引擎级四类拒绝（`write_bytes` 未允许 / 未声明积木 / 空历史 `step_back` / 空历史 `undo`）也逐个逐字段比对，`failures` 累计 +1、`history` 不变；Schema 级三类伪造字段同样逐字段比对；另有 `stateFingerprint` 级用例与「拒绝响应错误体不含内部堆栈 / 文件路径 / 私有字段」 | **通过（收工）**：以上路径全部通过；曾经那条反例——多动作积木在中途被拒时，前一条已生效的 `write_bytes` 留在**调试实例**内存里（`s04-payload-boundary.test.ts` 的原 `it.fails` 复现，§8 缺口 7）——已由 **BG06 修掉**，A 集成时该用例从「预期失败」翻成正常通过。因此这条条件**勾选** |
| 第 12 条：回退动作按契约仍可用 | 回退动作不受 `allowedActions` 约束（`undo`/`step_back`/`reset` 始终可用）；历史为空时回退回 `empty_history` 而不是静默成功；`failed` 状态下执行类被拒、回退类仍可用；`exited`（含 `satisfied`+`exit`）状态下同样；`failures` 单调递增（拒绝 +1、回退不减少） | 通过 |

结论：**S03 =「通过」（D4 收工）**——全部条件通过；原先那条反例（§8 缺口 7）已由 BG06 修复，
A 用真实 HTTP 复验该用例翻绿，故按 §0 勾选。

#### 3.2.3 S04 · 08 §5 条件 → 用例 → 结果（10 条真实 + 4 条 `todo`）

| 08 §5 / 07 §5 条件 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 第 10 条：`block` 只接受 `{id,args}` | 带 `expand`/`actions`/`resolved` 等字段的请求被 `strictObject` 拒；附了客户端展开结果的多动作请求同样被拒 | 通过（`invalid_request`；`failures`/`history`/内存全不变） |
| 第 10 条：展开以题目包为准 | 客户端提供的展开结果被忽略：展开以题目包 `authorBlocks` 为准 | 通过（用 `shared` 的 `expandBlock` 复算定义，并与真实内存变化逐字节对齐；换参数只换字节） |
| 第 10 条：不信客户端给的地址/字节 | 客户端给出的地址/字节与题目包不一致时，实际执行的是题目包展开的动作 | 通过（伪造请求被拒 + 判胜地址来自模板 + 另一块积木判 `incomplete` 的反面对照） |
| 第 10 条：多动作积木整块展开 | **D4 新增**：多动作积木由服务端整块展开——两条 `write_bytes` 都生效、`executed` 仍按 **1 个 block** 计（09 §7 第 4 条）、展开定义逐条可复算，客户端附上的「只写第一条」展开被拒且内存保持完整结果 | 通过（真实内存逐字节断言） |
| 第 10 条：中途越权的整块回滚 | **D4 新增**：多动作积木中途越权——判题实例整块回滚（`verdict=rejected`、`executed=0`、末帧 `changedVmas` 为空、`replay.initial` 栈全零）；调试实例按契约拒绝并计一次 `failures`、不压历史 | 通过（判题实例与调试实例两侧都在下一条里断言） |
| 第 10 条：被拒动作不修改状态（调试实例） | **原 `it.fails` → 已转正常断言**：被拒的多动作积木必须整块回滚，调试实例内存不留半截写入（04 §2） | **通过**（`results[0].error.code='inaccessible_address'`、`executed=0`，栈 `hex` 逐字段不变、`failures+1`，投影逐字段等于动作前）。修复前这条实测报 `expected '41424344' to be '00000000'`，BG06 修 `instance.ts` 的 `applyOne` 后转绿，见 §8 缺口 7 |
| 03 §3：未声明的积木 id | 未声明的积木 id 回 `unknown_action`，状态不变 | 通过（`executed=0`、错误对象逐字段、`failures+1`） |
| 03 §3：参数校验 | 缺参 / 多参 / 类型不符都回 `invalid_arguments`，状态不变 | 通过（6 个反例 + 2 个合法对照，内存无半截写入） |
| 04 §6：`submit` 动作 Schema 与上限 | `submit` 动作超 `MAX_SUBMIT_ACTIONS` 被拒、动作是 `strictObject` | 通过（4 个多字段动作被拒；4097 被拒、4096 被接受；两种结果都不动调试实例） |
| **第 13 条：读状态 payload 被 `rejected`（`reads_state`）** | **保留 `todo`（3 条）** | **仍为口径项**：按 09 §8 第 4 条的**分层口径**——编译期拒绝归 H 的编译器（`forbidden-state.test.ts`），线上不可表达且不静默当零归本文件的「附加」一节（真实 HTTP 已通过）。原文要求的 `reads_state` 响应码在服务端仍不可触发，所以**不写成通过** |
| **05 §4：编译上限在服务端复核** | **保留 `todo`（1 条）** | **不成立（口径）**：09 §8 第 5 条——到服务端只剩扁平动作，看不到循环 / 表达式结构；服务端能守的 `MAX_SUBMIT_ACTIONS` 已真实执行。H 的 `limits.test.ts` 是编译期证据，不替代服务端验收 |

结论：**S04 =「通过」（D4 收工）**——第 10 条全部条件通过（「调试实例整块回滚」已随 BG06 从
`it.fails` 转入正常断言）；第 13 条与编译上限 4 条按 09 §8 第 4–5 条口径**如实保留 `todo`**，
它们是**口径项**（线上不可表达 / 属编译期防线），不是未实现。

#### 3.2.4 API 生命周期 / 终态 · 用例对照（`api-lifecycle.test.ts`，20 条全通过）

本组对应 08 §3 的 D4 行（F 的「API 生命周期/终态」），**不属于 S01–S06 六组核心检查**，因此单独成文件、
单独登记。依据：04 §1/§1.1/§3/§5/§5.1/§6、09 §7 第 4–5 条、09 §8 第 1/2/9/10 条。

| 验收点 | 用例（`it` 名摘要） | 实测结果 |
|---|---|---|
| 会话创建 | `sessionId` 是 128 位随机十六进制（`^[0-9a-f]{32}$`）、两次创建不同；投影 = 题目初态（`ready`/`steps=0`/`failures=0`/`register`/`roles`/栈 `hex`）；未知题目 404 `not_found` | 通过 |
| 未知 / 伪造会话 id | `GET` / `actions` / `submit` / `DELETE` 与客户端自选 id 一律 404 `not_found` | 通过 |
| 主动结束会话 | `DELETE` 首次 200 `{ok:true}`，重复删除与后续三种请求一律 404 `not_found`（与「空闲回收」的 `session_expired` 明确区分） | 通过 |
| 空闲回收 | 假时钟（`sessions.now` + `idleMs:30s` + 清理周期 1 小时）：活动刷新活跃时间 → 空转超时后惰性回收 → `GET`/`actions`/`submit`/`DELETE` 全回 404 `session_expired`；刚建的会话照常可用 | 通过（不使用真实 `setTimeout`） |
| 存活会话上限 | 每 IP 与全局各挡一次 429 `rate_limited`，两句文案互不相同；会话容量型 429 **不带** `Retry-After`（09 §8 第 2 条口径）；回收后配额释放 | 通过 |
| `reset` | 回到题目初态：投影逐字段等于全新会话初态（含非隐藏栈 `hex`）、不计 `failures`、自身压栈（`history.undo` +1、指令层缓冲作废） | 通过 |
| `undo` | 可撤销 `reset`（回到 reset 前逐字段）；一次退回整批请求（两个动作一起退）；自身不压栈 | 通过 |
| `step_back` | 逐条回退指令（`RIP`/`steps` 逐步断言）、窗口内连续后退、跨请求仍可退、退空后回 `empty_history` | 通过 |
| verdict `won` | 下发 flag 哨兵；末帧 `status='satisfied'` 且 `lastStop.reason='exit'`；调试实例逐字段不变（含 `failures`/`history`） | 通过 |
| verdict `failed`（命中 fail 谓词） | 不下发 flag；末帧 `lastStop.reason='exception'` 且**不带** `error`（09 §7 第 3 条）；调试实例不变 | 通过 |
| verdict `failed`（运行期异常） | `ret` 到未映射地址后取指 → `invalid_ip` 判负、无 flag、末帧带 `error`、`executed=2` | 通过 |
| verdict `rejected` | 判题实例没有回退（提交 `undo` → `action_not_allowed`）、未知积木 → `unknown_action`；被拒动作占一帧、后续动作不执行；两次都不动调试实例 | 通过 |
| verdict `incomplete` | 回放跑完未满足成功条件、末帧 `ready`、无 flag、不动调试实例 | 通过 |
| **`exited` vs `failed` 边界** | `satisfied` + `lastStop.reason='exit'` 时 `step`/`run`/`write_bytes` 都被拒 `not_executable`、状态**逐字段**不变（含 `status` 仍是 `satisfied`、`lastStop` 仍是 `exit`）、每次拒绝对 `failures` +1（09 §8 第 10 条）；`undo`/`step_back`/`reset` 三个出口都能退回 `ready` 并恢复可执行 | 通过（若判据误用 `status !== 'exited'`，这三条会因动作真的执行而立刻变红） |
| 反面对照：`satisfied` 但未退出 | 置 `FLAG` 但不退出时执行类动作照常可用、`status` 仍 `satisfied`、不计 `failures`（04 §1.1 原语义） | 通过 |
| `failed` 终止态 | 执行类动作被拒、`failures` 只增（进入 `failed` 计 1、其后拒绝再 +1）；`reset`/`undo` 可用且恢复出 `failed` 不重复计（09 §8 第 1 条） | 通过 |

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
| `packages/shared/test/challenge.test.ts` 的「flag 真值泄露检查（S05 语义）」 | shared 层语义；S05 的**服务端加载路径**（真实首题 + 注入哨兵的副本）已由 `s05-flag-boundary.test.ts` 覆盖，剩下的只有「加载失败的服务端告警」（§8 缺口 4） |
| `packages/shared/test/challenge.test.ts` / `actions.test.ts` 的私有包与积木展开反例 | S03/S04 的 shared 层基础；S04 的 **REST 端到端**已由 `s04-payload-boundary.test.ts` 覆盖 |
| `packages/web/src/compiler/forbidden-state.test.ts`（H 的单测） | 读状态积木的**编译期**拒绝（`MESSAGE_READS_STATE`，`docs/05-前端交互.md` §4）；它是 09 §8 第 4 条分层口径里的**编译期那一半**，不等于 S04 第 13 条的**服务端** `reads_state`（见 §8 缺口 1） |
| `packages/engine/test/instance.test.ts` 的「积木内部被拒绝时整块回滚」 | 引擎层的单动作积木回滚；它的 `leak` 积木只有**一条**展开动作，因此覆盖不到「第一条已生效、第二条被拒」的路径 —— 这正是 §8 缺口 7 漏网的原因。现在这条路径有两层证据：S04 转入正常断言的真实 HTTP 用例，以及 BG06 新增的 `packages/engine/test/instance-rollback.test.ts`（3 条积木回滚 + 4 条同类拒绝分支排查） |
| `s01-hidden-boundary.test.ts` 的字段白名单 | S01 的一部分；S01 的其余条件已在同一文件里用真实引擎 + 真实 HTTP 执行 |

## 7. 写入边界与更新规则

- F 的写入范围只有 `tests/acceptance/**` 与 `tests/e2e/**`；不改 `packages/**`、`challenges/**`、`docs/**`，
  也不改根 `package.json`、`pnpm-lock.yaml`、根配置、`vitest.config.ts` 与 CI。
- 每个 owner 负责自己模块的单测（08 §2 规则 6），F **不兜底**其它 owner 的测试；F 只做验收与黑盒集成。
- 改契约（`packages/shared` 的 Schema）必须同步更新本表与白名单常量，并在同一个提交里完成；
  「谁改契约谁更新映射」是硬要求。
- 勾选动作只由 F 在**真实对象**验收通过后执行，且附命令与输出（F04 · D7 交给 A 复核）。
  **S02 的 `[x]` 是 D3 / F01-b 完成的（证据 §3.1）；S01 与「API 生命周期/终态」的 `[x]` 是 D4 / F02
  完成的（证据 §3.2）；S03/S04 原为「部分」，BG06 修掉 §8 缺口 7 后由 A 在集成时复验并勾选；
  S06 由 F03 在 D4 提前做完（证据见 §2 表里 S06 行）。**
- 已知缺陷用 `it.fails` 承载（§0）：**改成正常断言的条件只有一个 —— 缺陷修复并合并进 main**；
  由 A 在集成时摘掉标记（缺口 7 的处置已写明）。F 不许自行把 `it.fails` 升级成通过。
  **D4 收工状态：0 条 `it.fails`**（唯一一条已按上述流程摘除）。

## 8. 契约缺口（报 A，F 不自行改根配置）

1. **S04 第 13 条（`reads_state`）缺服务端口径**：错误码只在 `shared/src/errors.ts` 定义，
   `packages/server/src/**` 与 `packages/engine/src/**` 里没有任何地方会产出它；而按 04 §2 的线上动作集，
   请求体**根本无法表达「读当前状态」**（地址与值都是客户端给的十六进制字面量），所以服务端没有可触发的输入。
   真正做到编译期拒绝的是 H 的编译器（`FORBIDDEN_STATE_BLOCK_TYPES` + `MESSAGE_READS_STATE`，
   `docs/05-前端交互.md` §4），那是前端编译错误而不是 REST 响应；而 `packages/web/**` 被根
   `tsconfig.json` 的 `exclude` 排除，`tests/acceptance/**` 一旦 import 编译器就会破坏 `pnpm typecheck`
   （F 的写入范围只有 `tests/acceptance/**`）。
   **A 已在 `docs/09` §8 第 4 条定稿口径**：按「编译期拒绝（H 的编译期单测）＋ 线上不可表达且不静默当零
   （F 的真实 HTTP 用例）」分层验收。按此口径，本文件 S04 的「附加」一节（把状态引用塞进 payload 的
   每种写法都被拒、且没有任何「当成零」的写入）就是**可验证的那一半**的真实证据。
   **但那三条 `todo` 继续保留**：原文要求的 `reads_state` 响应码在服务端仍不可触发，若要与原文逐字对齐，
   还需 A 决定给验收测试开一条能 import 编译器的通道（独立 tsconfig / 额外 paths），或由 C 定义一种能
   表达读状态的请求形状。**在那之前不写成通过。**
2. **「客户端编译上限在服务端复核」不成立（口径，非待办）**：循环展开 256、表达式求值 4096 步是编译器
   内部的预算（`limits.LOOP_UNROLL_LIMIT` / `EXPR_EVAL_STEP_LIMIT`），到服务端时请求体只剩**已经展开的
   扁平动作**，服务端看不到循环/表达式结构，无从复核（`docs/09` §8 第 5 条已定稿）。服务端能守住的量是
   「动作数 ≤ `MAX_SUBMIT_ACTIONS`」，已在 `s04-payload-boundary.test.ts` 真实执行（4097 被拒、4096 被接受）。
   H 的 `packages/web/src/compiler/limits.test.ts` 覆盖编译期限流，属**编译期**证据，不替代服务端验收。
   若要把它升级为服务端条件，需要 A 先改契约（例如请求体带编译摘要）；本轮不做，该条继续 `todo`。
3. **「调试实例不记录通过」缺可观察接口**：`packages/server/src/sessions.ts` 只在 `submit` 路径上
   `recordSubmit`，而 `GET /api/sessions/:id` 不返回提交次数或通过记录，所以这条只能按
   「响应字段集合与全新会话一致 + `satisfied` 后提交赢不了的 payload 仍判 `incomplete`」来验证
   （S02 用例内已写明）。若 A 认为口径不够强（例如要求响应里出现可断言的提交记录），需要 C 提供观察点。
4. **加载失败没有服务端告警/日志出口**（S05 保留的那条 `todo`）：`loadChallengeDir` 只把失败原因放进
   内部的 `ChallengeStore.issuesFor()`，`buildApp()` 不为加载失败打印任何日志（`app.ts` 里唯一的
   `log.warn` 是「引擎装配失败」那条）；`packages/server/src/index.ts` 只导出 `buildApp`，
   `issuesFor()` 不在包导出面里（深路径导入过不了根 `tsconfig.json` 的 `paths`），
   `BuildAppOptions.logger` 只收布尔值、没有注入 `stream`/自定义 logger 的口子，
   所以黑盒验收**无法观察**这条。契约口径也不唯一：06 §6「缺失时拒绝加载这道题并报错」目前由
   HTTP 503 + `challenge:check` CLI 的诊断文案承担（CLI 侧有真实证据）。
   需要 C 决定并实现「加载失败 → 一条可诊断的服务端告警（且不含私有字段、文件路径、内部堆栈）」，
   或由 A 明确「503 + CLI 诊断」就是 06 §6 的完整口径、把该条从 S05 移除。
5. ~~根 `.gitignore` 未包含 `test-results/` 与 `playwright-report/`~~ —— **已解决（D3 复核）**：
   根 `.gitignore` 现在含 `test-results/`、`playwright-report/`、`blob-report/`、`playwright/.cache/`。
6. ~~根 `tsconfig.json` 没有 `@pwn2block/*` 的 `paths` 映射~~ —— **已解决（D3 复核）**：
   根 `tsconfig.json` 现在有 `shared`/`engine`/`server`/`authoring` 四条 `paths`，
   `tests/acceptance/**` 可以按包名导入，`pnpm exec tsc -p tsconfig.json` 退出码 0。
7. **【已修复 · BG06 · 已闭环】被拒绝的多动作积木在「调试实例」上没有整块回滚**（D4 / F02 发现，
   A 已独立复现并派活）。**违反 04 §2「被拒绝的动作不修改状态」与 `packages/engine/src/actions.ts` 里
   `applyBlock` 自己的注释「块内任一步被拒绝时整体回滚到块执行前」。**
   - **最小复现（引擎层，无 HTTP）**：题目包 `authorBlocks` 里一个积木展开两条 `write_bytes`
     （第一条写合法可见栈、第二条写未映射地址 `0x600000`）：
     ```ts
     const runtime = createRuntime(pub, priv);
     const instance = runtime.createDebugInstance();
     const outcome = instance.applyRequest([{ type: 'block', id: 'pair', args: { data: '41' } }]);
     outcome.results[0]?.error?.code;  // 'inaccessible_address'（动作报告为被拒）
     outcome.executed;                 // 0；historyDepth() = {undo:0, stepBack:0}
     bytesToHex(runtime.memory.readVma(instance.state().memory, 'stack')).slice(0, 2);
     //   实际 '41' ← 应为 '00'：第一条写入没被回滚
     runtime.replaySubmit([{ type: 'block', id: 'pair', args: { data: '41' } }]).finalState;
     //   同一字节是 '00'（判题实例的回滚是正确的）
     ```
     HTTP 层同样可观测：`POST /api/sessions/:id/actions` 回 `executed:0` + `results[0].ok=false` +
     `inaccessible_address`，但响应投影里 `vmas[stack].hex` 已含第一条写入。
   - **根因**（A 已核对）：`packages/engine/src/instance.ts` 的 `applyOne` 在被拒分支**不把
     `outcome.state` 写回 `current`**（注释假设「写原语先校验后落笔，积木内部自带整块回滚」）；
     但 `MemoryApi` 是**可变句柄**、`write` 原地换页表（`memory/index.ts:163-170`），`applyBlock` 的
     回滚结果放在 `outcome.state.memory`（`restore(guard)` 派生**新**句柄），丢弃后活句柄仍带着前几条
     原子动作的写入。`replay.ts` 的 `replaySubmit` 无条件 `current = outcome.state`，所以判题实例没这个问题。
     写原语本身是安全的（整段先校验再落笔）。
   - **为什么此前漏网**：引擎单测 `packages/engine/test/instance.test.ts` 的「积木内部被拒绝时整块回滚」
     用的 `leak` 积木只有**一条**展开动作（`test/helpers/challenge.ts`），单动作时「先校验后落笔」永远成立，
     走不到「前一条已生效」的路径。
   - **修复归属与验收**：**已修复** —— BG06（B，D4，分支 `fix/engine-d4-defects`）改
     `instance.ts` 的 `applyOne`：被拒分支把 `applyBlock` 派生的新内存句柄写回 `current`，并把
     **指令层环形缓冲**还原到动作前（块内若有 `step`/`run`，被回滚的那段时间线不能再被 `step_back`
     退到；缓冲满了会 `shift()`，所以要留副本而不是截长度）。新增
     `packages/engine/test/instance-rollback.test.ts`（3 条积木回滚 + 4 条同类拒绝分支排查）。
   - **收工处置（A 完成）**：修复合并进 main 后，A 摘掉 `s04-payload-boundary.test.ts` 的 `it.fails`
     标记、转入正常断言。**证据链**：摘标记前，这条用例从「预期失败」变成「预期失败却通过了」，
     vitest 报 `Error: Expect test to fail`；摘掉后 acceptance 套件 `104 passed | 5 todo`、退出码 0。
     同时按 §0 把 S03 与 S04 的对应条件**重新勾选**（§2 表、§3 一览、§3.2.2、§3.2.3 均已更新）。
   - **教训（值得记住）**：本缺口能穿过 398 条引擎单测，是因为夹具里的 `leak` 积木只有**一条**展开动作
     ——「先校验后落笔」在单动作下永远成立。**回归用例必须覆盖「前一条已生效」这条路径**，
     否则同一个不变式会再次静默破裂。
