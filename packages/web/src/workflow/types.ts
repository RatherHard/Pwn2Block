import type {
  ArchBits,
  AuthorBlock,
  BlockAction,
  EncodedValue,
  GraphConnection,
  GraphDocument,
  GraphNode,
  NodeKindSpec,
  ParamValues,
  PortType,
  PrimitiveAction,
  PythonEvalError,
  PythonEvalRequest,
  WorkflowIssue,
} from '@pwn2block/shared';

/**
 * 图编译与求值的内部类型（07 §3「核心接口」）。
 *
 * 这一层与画布库、DOM 无关：图文档进，动作出。所以它能脱离浏览器单测——
 * 「分支只生成选中路径的动作」「零次循环仍有结果」这类语义断言不需要点鼠标（07 §6）。
 */

/** 编译产物里的动作：与现有动作协议完全一致，服务端仍做权限校验与权威判题。 */
export type CompiledAction = PrimitiveAction | BlockAction;

/** 编译期的值。整数用 `bigint`（64 位地址不丢精度），字节用 `Uint8Array`。 */
export type WorkflowValue =
  | { readonly kind: 'int'; readonly value: bigint }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'text'; readonly text: string };

/** 编译所需的题目上下文：只取公开包的字段，不需要私有包或 VM。 */
export interface WorkflowContext {
  readonly archBits: ArchBits;
  readonly allowedActions: readonly string[];
  readonly authorBlocks?: readonly AuthorBlock[];
  /** Python 求值入口。不提供时 Python 节点报「不可用」，而不是静默出错。 */
  readonly python?: PythonEvaluator;
}

/** 浏览器侧的 Python 求值接口：可替换，测试用假实现，生产走服务端。 */
export interface PythonEvaluator {
  evaluate(request: PythonEvalRequest): Promise<PythonEvalResult>;
}

export type PythonEvalResult =
  | { readonly ok: true; readonly value: EncodedValue }
  | { readonly ok: false; readonly error: PythonEvalError };

/** 节点在某个执行区域里的位置。`path` 由外向内，顶层是 `['main']`。 */
export interface NodePlacement {
  readonly nodeId: string;
  /** 例如 `['main', 'if-1/then']`。 */
  readonly path: readonly string[];
  /** 所属容器节点 id（顶层为 `undefined`）。 */
  readonly container?: string;
  /** 在所属区域里的序号（从 0 开始）。 */
  readonly index: number;
}

/**
 * 预览条目的类型标签。
 *
 * 旧编译按端口类型标注；新版画布（`canvas/compile.ts`）产出的预览不属于任何端口，
 * 统一标成 `canvas`。界面目前只读 `summary`，所以这里是**加宽**而不是换一套类型：
 * 阶段三删掉旧 `workflow/` 时，这个联合一起收敛成 `'canvas'`。
 */
export type PreviewType = PortType | 'canvas';

/** 节点预览：每个数据节点自带的结果摘要（06 §8）。 */
export interface NodePreview {
  readonly nodeId: string;
  readonly type: PreviewType;
  /** 一行摘要：整数给十进制与十六进制，字节给长度与开头。 */
  readonly summary: string;
  readonly length?: number;
  readonly hex?: string;
  readonly text?: string;
  /** 拼接 / 组装的分段：来源端口、偏移、长度（06 §8 要求展示）。 */
  readonly segments?: readonly PreviewSegment[];
}

export interface PreviewSegment {
  readonly port: string;
  readonly offset: number;
  readonly length: number;
}

/** 动作来源：动作 → 节点，再带容器路径与循环轮次（07 §P8 的定位依据）。 */
export interface WorkflowOrigin {
  readonly index: number;
  readonly nodeId: string;
  readonly path: readonly string[];
  /** 生成这条动作时各循环的轮次（循环节点 id → 从 0 开始的轮次）。 */
  readonly rounds?: Readonly<Record<string, number>>;
  /** 生成这条动作时所在的模块调用链（`id@版本`，由内到外由外层到内层）。 */
  readonly modules?: readonly string[];
}

/** 来源表格式版本：与产物不一致时按「来源未知」处理，不猜。 */
export const WORKFLOW_ORIGIN_VERSION = 1;

/** 编译轨迹：给「编译演示」用，与 VM 执行状态分开呈现（06 §8）。 */
export interface CompileTraceEntry {
  readonly nodeId: string;
  readonly path: readonly string[];
  readonly message: string;
  /** 当时的循环轮次，便于解释「第几轮做了什么」。 */
  readonly rounds?: Readonly<Record<string, number>>;
}

/** 一次成功编译的完整产物。只有 `actions` 进网络请求。 */
export interface WorkflowArtifact {
  readonly actions: readonly CompiledAction[];
  readonly origins: readonly WorkflowOrigin[];
  readonly originsVersion: number;
  readonly previews: readonly NodePreview[];
  readonly trace: readonly CompileTraceEntry[];
  /** 产物对应的文档语义修订号：与当前修订不一致即视为过期（07 §P1）。 */
  readonly documentRevision: number;
}

export type CompileOutcome =
  | {
      readonly ok: true;
      readonly artifact: WorkflowArtifact;
      readonly warnings: readonly WorkflowIssue[];
    }
  | { readonly ok: false; readonly issues: readonly WorkflowIssue[] };

/** 一次编译的输入。 */
export interface CompileGraphInput {
  readonly document: GraphDocument;
  readonly context: WorkflowContext;
  /** 文档语义修订号，由产物状态机维护；编译本身不读它，只抄进产物。 */
  readonly documentRevision: number;
  /** 取消信号：取消失败时返回 `cancelled`，不发布部分产物（07 §P1）。 */
  readonly signal?: AbortSignal;
}

/** 节点在目录里的定义 + 当前参数，供端口推导用。 */
export interface ResolvedNode {
  readonly node: GraphNode;
  readonly spec: NodeKindSpec;
  readonly params: ParamValues;
}

/** 输入端口到连线的索引键。 */
export function edgeKey(nodeId: string, port: string): string {
  return `${nodeId}\u0000${port}`;
}

/** 供索引使用的节点表。 */
export type NodeMap = ReadonlyMap<string, GraphNode>;

export type ConnectionMap = ReadonlyMap<string, GraphConnection>;
