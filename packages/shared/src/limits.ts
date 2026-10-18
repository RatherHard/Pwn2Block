/**
 * 全局资源与容量上限（02 §6、04 §3、§6）。
 * 引擎、服务端与测试都必须引用这里，不得各写一份常量。
 */

/** 内存分页大小（02 §7）。 */
export const PAGE_SIZE = 0x1000;

/** 单次运行最多执行指令数（02 §6）。 */
export const MAX_STEPS_PER_RUN = 10_000;

/** 每会话累计最多执行指令数（02 §6）。 */
export const MAX_STEPS_PER_SESSION = 1_000_000;

/** 历史快照上限（02 §6）。 */
export const MAX_SNAPSHOTS = 1_000;

/** 指令层环形缓冲窗口 N（04 §3）。 */
export const STEP_BACK_WINDOW = 64;

/** stdin / stdout 容量上限：4KB（02 §5.3）。 */
export const MAX_IO_BYTES = 4 * 1024;

/** 单次 read / write / copy 的 count 截断值（02 §5.2）。 */
export const MAX_SYSCALL_COUNT = 0x1000;

/** 每题寄存器数量上限（02 §2）。 */
export const MAX_REGISTERS = 32;

/** `mem_contains` / `stdout_contains` 的 needle 上限（03 §2.1）。 */
export const MAX_CONTAINS_BYTES = 64;

/** 判题谓词最大嵌套层数（03 §2.1）。 */
export const MAX_PREDICATE_DEPTH = 3;

/** 一题可见字节总量上限，保证全量投影代价可控（04 §4）。 */
export const MAX_VISIBLE_BYTES = 256 * 1024;

/** 客户端编译：循环展开次数上限（05 §4）。 */
export const LOOP_UNROLL_LIMIT = 256;

/** 客户端编译：表达式求值步数上限（05 §4）。 */
export const EXPR_EVAL_STEP_LIMIT = 4096;

/** 单个 actions 请求的动作数上限（04 §6 请求体限制）。 */
export const MAX_ACTIONS_PER_REQUEST = 512;

/** 单个 submit 请求的动作数上限。 */
export const MAX_SUBMIT_ACTIONS = 4096;

/** `step` 动作的 count 上限（04 §6）。 */
export const MAX_STEP_COUNT = MAX_STEPS_PER_RUN;

/** `run` 动作的 maxSteps 上限（04 §6）。 */
export const MAX_RUN_MAX_STEPS = MAX_STEPS_PER_RUN;

/** HTTP 请求体大小上限（04 §6）。 */
export const MAX_BODY_BYTES = 1 * 1024 * 1024;

/**
 * 单个字节构造（`padding` / `string` / `raw` / `concat`）能产出的最大字节数（05 §4）。
 *
 * 取请求体上限的一半：字节构造的结果还要 hex 编码（长度翻倍）才进请求体，比这更大的字节串
 * **一定发不出去**。编译器据此在分配前就报编译错误，而不是让 `Uint8Array` 去分配几 GB
 * （极端输入还会抛 `RangeError` 逃出 `compileProgram`，破坏「要么给动作、要么给带 blockId 的错误」）。
 */
export const MAX_BYTE_CONSTRUCTION_BYTES = MAX_BODY_BYTES / 2;

/** 会话空闲回收时间：30 分钟（04 §1）。 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/** 单 fd 虚拟文件大小上限，防止题目包塞入超大文件。 */
export const MAX_FILE_BYTES = 64 * 1024;

/** 题目伪代码（`pseudocode.c`）的字符数上限：它随公开包整份下发，不能无限大。 */
export const MAX_PSEUDOCODE_CHARS = 20_000;

/** 默认监听端口。 */
export const DEFAULT_PORT = 8787;
