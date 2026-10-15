/**
 * G 的快照实现目录（G02，D2–D3）：COW 脏页快照与恢复。
 *
 * 分工（08 §2 规则 2）：G 只实现状态存取，历史管理（请求层 undo、指令层环形缓冲
 * step_back、可 undo 的 reset）由 B 的 `src/instance.ts` 编排。
 *
 * 快照必须覆盖 02 §7 列出的全部 VM 状态：内存、寄存器、标志位、已 reveal 的 VMA、
 * stdin 缓冲与读位置、stdout、各文件 fd 读偏移。
 *
 * 内存快照入口是 `MemoryApi.snapshot / restore`（见 `../memory/index.ts`）。
 */
export {};
