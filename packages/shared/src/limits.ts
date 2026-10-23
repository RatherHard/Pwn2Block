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

// ---------------------------------------------------------------------------
// 新版画布（数据值、吸附组合、转换包络）
//
// 新画布把「值」本身变成编辑器的一等公民：一个字节串、一个列表、一个字典都要能整体计算与
// 存档。因此这里补一组**值域容量**上限，约束构造结果的大小；旧画布那套「节点/连线数量」
// 的图规模上限已随 `workflow/` 一起删除，新画布的图规模口径见下面阶段二的流程上限。
// ---------------------------------------------------------------------------

/** 一张新版画布的节点数上限。数据节点比旧节点碎，上限相应放宽。 */
export const CANVAS_MAX_NODES = 512;

/** 一个吸附组合的行数上限。 */
export const CANVAS_MAX_GROUP_ROWS = 32;

/** 吸附组合每一行的成员数上限。 */
export const CANVAS_MAX_ROW_MEMBERS = 64;

/** 单个集合（列表元素、字典条目）的元素数上限。 */
export const CANVAS_MAX_COLLECTION_ITEMS = 1024;

/** 值嵌套深度上限：列表套列表、字典套列表都算一层。 */
export const CANVAS_MAX_VALUE_DEPTH = 16;

/** 整数的位数上限。超过就按「不可信输入」拒绝，而不是让 bigint 吃满内存。 */
export const CANVAS_MAX_INT_BITS = 1024;

/** 字节串长度上限：与请求体上限同一量级，hex 编码后还要翻倍。 */
export const CANVAS_MAX_BYTES = MAX_BYTE_CONSTRUCTION_BYTES;

/** 文本长度上限（按 Unicode 码点计）：结果还要进存档与预览。 */
export const CANVAS_MAX_TEXT_CHARS = 256 * 1024;

/** 字典键（整数或文本）的文本长度上限。 */
export const CANVAS_MAX_KEY_CHARS = 128;

/** 一次求值最多计算的表达式节点数：与旧的节点求值预算同量级。 */
export const CANVAS_MAX_EVAL_STEPS = 4096;

/** 一次求值里表达式嵌套深度上限：防脏存档把递归拖死。 */
export const CANVAS_MAX_EXPR_DEPTH = 64;

// ---------------------------------------------------------------------------
// 新版画布：变量与流程（阶段二）
// ---------------------------------------------------------------------------

/** 一张画布里的全局变量声明数上限。变量是执行状态，不做无界存档。 */
export const CANVAS_MAX_VARIABLES = 64;

/** 变量名字符数上限（保存与显示都要有界）。 */
export const CANVAS_MAX_VAR_NAME_CHARS = 32;

/** 流程节点（开始/分支/循环/方法/赋值）总数上限。 */
export const CANVAS_MAX_FLOW_NODES = 256;

/** 分支与循环的嵌套深度上限。 */
export const CANVAS_MAX_FLOW_DEPTH = 8;

/** 单个循环最多执行的轮数。超过就报错定位到循环，不悄悄截断（需求 §5.3）。 */
export const CANVAS_MAX_LOOP_ITERATIONS = 256;

/** 一次生成里所有循环累计的轮数上限：嵌套循环共享同一份预算。 */
export const CANVAS_MAX_TOTAL_ITERATIONS = 4096;

/** 一次生成最多产出的动作数（含循环展开）。超过就整体失败，不发布部分动作（需求 §7）。 */
export const CANVAS_MAX_ACTIONS = 2048;

/** 一条动作序列里保留的步骤快照数上限：超出的部分不再记录变量快照，但动作照常生成。 */
export const CANVAS_MAX_STEP_SNAPSHOTS = 2048;

/** 方法节点的参数个数上限：与题目声明的上限一致。 */
export const CANVAS_MAX_METHOD_ARGS = 8;
