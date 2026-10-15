/**
 * G 的 I/O 实现目录（G02，D2–D3）：stdin / stdout / 虚拟文件 fd 与读偏移。
 *
 * D1 只建立目录与接口位置。实现要点（02 §5.2–§5.3）：
 * - stdin 缓冲上限 4KB，`read` 取 `min(count, 剩余)`，读完返回 0（EOF）。
 * - stdout 只可追加，累计超过 4KB 报 `resource_limit`。
 * - 虚拟文件只读，按 fd 记录读偏移；内容是私有包的秘密，不得进入投影。
 *
 * 本目录的任何导出都只在引擎内部使用；B 通过 `VmState` 的
 * `stdin / stdout / fileOffsets` 字段读取结果。
 */
export {};
