# 04 会话与 API

## 1. 会话模型

- 一次会话 = 一个学习者在一道题上的一份 VM 实例，状态保存在服务端内存中。MVP 不做持久化，服务重启后会话丢失。
- 会话内的动作**串行执行**：同一会话同一时刻只处理一个请求，用每会话锁实现。
- 会话有四种状态：

  | 状态 | 含义 |
  |---|---|
  | `ready` | 可继续执行 |
  | `won` | 成功条件已满足；**通过记录不可撤销** |
  | `failed` | 运行时异常，或命中失败条件 |
  | `exited` | 程序已结束但未判胜。若题目声明了 `fail`，会落到 `failed` |

- 处于 `won`、`failed` 或 `exited` 时，执行类动作会被拒绝，只有 `undo` 和 `reset` 可用。这样学习者可以回退后继续探索。
- 空闲 30 分钟的会话会被回收。

MVP 不做 revision、baseRevision、幂等键和 clientSeq。前端串行发送请求即可，“刷新页面”通过 `GET` 当前状态恢复。

## 2. 动作

| 动作 | 参数 | 类别 |
|---|---|---|
| `write_bytes` | `addr`, `hex` | 写原语 |
| `push` / `pop` | `value` / — | 写原语 |
| `call` / `ret` | `addr` / — | 写原语：直接操纵栈与 ip，**不执行指令** |
| `block` | `id`, `args` | 出题人积木，服务端展开为上面几类原子动作 |
| `step` | — | 执行一条指令 |
| `run` | `breakpoints?: addr[]`, `maxSteps?` | 连续执行，直到断点、程序退出、异常或达到步数上限 |
| `undo` | — | 回到上一个执行类动作之前 |
| `reset` | — | 回到初始状态（可被 undo） |

- 题目通过 `allowedActions` 限定可用动作。`undo` 和 `reset` 始终可用。
- **断点由权威会话原生支持**：作为 `run` 的参数传入，由服务端在每条指令取指前检查。
  - 断点本身不泄露秘密，所以不需要单独的调试通道。
- 写原语在执行前做校验：
  - 地址必须完全落在可见、可写的 VMA 内。
  - 不满足时**拒绝**（`rejected`），状态不变，不压快照。
  - 拒绝时，隐藏地址与未映射地址返回同一个错误码 `inaccessible_address`。
- 已执行的动作若触发指令异常，会话进入 `failed`。

## 3. undo / reset

- 快照以**请求**为粒度：每个 `actions` 请求在执行第一个动作前压入一份 COW 快照。
  - 一次提交整个 payload（N 个动作）只压一份快照，`undo` 一次就回到 payload 之前。
  - 这与学习者的心智模型一致：一份 payload 是一次尝试，撤销就是撤销这次尝试。
  - 需要更细的粒度时用单步提交：一个请求一个动作，于是一次 undo 回退一个动作。
- `undo` 弹出栈顶快照并恢复。它自身不压栈，否则无法连续后退。`reset` 压栈，因此可被撤销。MVP 不做 redo。
- 历史为空时 undo 被拒绝。超出快照上限时丢弃最旧的快照。
- **P1**：`checkpoint` 命名快照和时间线拖动。

## 4. 公开投影

每次响应都返回**完整投影**，不做增量。前端对相邻两次投影做差分，用于高亮变化。

| 字段 | 内容 |
|---|---|
| `status` | 会话状态 |
| `steps` | 已执行指令数 |
| `failures` | 被拒绝 + 失败的动作计数，用于解锁提示 |
| `registers` | 非秘密寄存器，值为 hex 字符串；另含 `flags: {ZF, CF, SF}` |
| `vmas[]` | 仅可见 VMA：`{id, kind, label, start, size, perm, hex}` |
| `disasm[]` | 服务端对可见 `x` 区域线性反汇编：`{addr, bytes, text, target?}` |
| `lastStop` | `{reason: breakpoint\|exit\|exception\|limit\|step, addr?}` |
| `error?` | `{code, message, note}`，message 来自模板，note 来自题目 `errorNotes` |
| `flag?` | 仅在 `status = won` 时出现，取自私有包的 `flag` |

- 题目加载时校验可见字节总量上限（建议 256KB），保证全量投影代价可控。
- 寄存器值可以指向隐藏区域。这只泄露地址、不泄露内容，可以接受。
- 隐藏 VMA、秘密寄存器、`interfaces`、`win`/`fail` 永不出现在任何响应中。

## 5. REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/challenges` | 题目列表：`[{id, title}]` |
| `GET` | `/api/challenges/:id` | 题目公开部分（`public.json`） |
| `POST` | `/api/sessions` | `{challengeId}` → `{sessionId, projection}` |
| `GET` | `/api/sessions/:id` | 当前投影，用于刷新恢复 |
| `POST` | `/api/sessions/:id/actions` | `{actions: [...]}`，见下 |
| `DELETE` | `/api/sessions/:id` | 主动结束会话 |

`actions` 批量接口：

- 按顺序执行，遇到第一个被拒绝的动作、进入终态或命中断点即停止，后续动作不执行。
- 返回 `{results: [{ok, error?}], executed, projection}`，`executed` 为实际执行的动作数。
- 整批只压一份快照，见 §3。

不设单独的“提交”接口：`won` 由服务端在每个动作后判定。进入 `won` 时，响应中附带本题 flag（私有包的 `flag` 字段），学习者拿它到 CTF 平台提交。

- flag 是每题固定值，不按会话生成。这意味着一旦有人公开 flag，其他人可以不做题直接提交。MVP 接受这个代价：新生赛的目标是学会，不是防串题。
- **P1**：按会话签名的一次性 token，用于真正需要防串题的场合。

## 6. 安全说明

- `sessionId` 为 128 位随机值，作为持有即可用的凭证（bearer capability），不可枚举。
- **MVP 不做用户认证**。部署到公网前需评估：任何人都能创建会话，进度不归属到人。
- 必须的防护：
  - 请求体大小上限、单批动作数上限、`run` 的 `maxSteps` 上限。
  - 按 IP 限流；全局与每 IP 的并发会话数上限。
  - 错误响应不包含内部堆栈、文件路径或私有包字段。
- `private.json` 只在服务端读取，不放进静态资源目录。它本身进 git，但 flag 真值不进：`flag` 字段写 `"env:FLAG_<ID>"`，部署时由环境变量注入，见 [07](07-工程约定.md) §7。

## 7. 技术栈建议

全栈 TypeScript，单一服务同时承担 VM 引擎、API 和前端静态托管。详见 [07](07-工程约定.md)。

- 选择全 TS 而非 Rust 引擎的理由：指令集是小的封闭集，步数上限只有一万，Rust 的性能优势在这里用不上；而单一工具链和前后端共享类型能明显降低协作成本。
- 前端：Vite + Lit + Blockly。
- 编码表、`public.json` 与投影的类型定义放在前后端共享的包里，是单一事实来源。
