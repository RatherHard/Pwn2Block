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
  - StackMaster 规定终态禁止一切动作，MVP 为教学放宽了这一点。
- 空闲 30 分钟的会话会被回收。

StackMaster 的 revision、baseRevision、幂等键和 clientSeq 在 MVP 中舍弃。前端串行发送请求即可，“刷新页面”通过 `GET` 当前状态恢复。

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
  - 断点本身不泄露秘密，所以 MVP 不需要 StackMaster 的“调试克隆通道”。
- 写原语在执行前做校验：
  - 地址必须完全落在可见、可写的 VMA 内。
  - 不满足时**拒绝**（`rejected`），状态不变，不压快照。
  - 拒绝时，隐藏地址与未映射地址返回同一个错误码 `inaccessible_address`。
- 已执行的动作若触发指令异常，会话进入 `failed`。

## 3. undo / reset

- 每个**已执行**的写原语、`block`、`step`、`run` 和 `reset`，都会在执行前压入一份 COW 快照。
  - 一次 `run` 只压一份快照，无论它执行了多少条指令。
  - 一次 `block` 也只压一份快照。
- `undo` 弹出栈顶快照并恢复。它自身不压栈，所以连续 undo 会沿历史持续后退。MVP 不做 redo。
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
- 一批动作中的每个动作各自压快照，undo 一次只回退一个动作。

不设单独的“提交”接口：`won` 由服务端在每个动作后判定。**P1**：进入 `won` 时返回 flag 或签名令牌，用于接入 CTF 平台。

## 6. 安全说明

- `sessionId` 为 128 位随机值，作为持有即可用的凭证（bearer capability），不可枚举。
- **MVP 不做用户认证**。部署到公网前需评估：任何人都能创建会话，进度不归属到人。
- 必须的防护：
  - 请求体大小上限、单批动作数上限、`run` 的 `maxSteps` 上限。
  - 按 IP 限流；全局与每 IP 的并发会话数上限。
  - 错误响应不包含内部堆栈、文件路径或私有包字段。
- 私有题目包只在服务端读取，不放进静态资源目录，也不进入 git（`private-bundles/`）。

## 7. 技术栈建议

- 后端：单一服务，同时承担 VM 引擎、API 和前端静态托管。二选一：
  - Rust（axum），引擎与服务同进程。
  - TypeScript（Fastify），引擎以进程内模块实现。
- 前端：Vite + Lit + Blockly，沿用 StackMaster 的选型。
- 编码表与题目 `public.json` 类型放在前后端共享的公开包中。
