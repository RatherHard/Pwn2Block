import type { BlockAction, PortType, PrimitiveAction, WorkflowIssue } from '@pwn2block/shared';

/**
 * 编译产物契约：**新旧画布共用**的这一套类型。
 *
 * 为什么放在 `canvas/` 而不是 `workflow/`：产物（动作序列 + 来源表 + 预览 + 轨迹）是
 * 「画布 → 网络请求 → 回放」三处共用的形状，既不依赖旧画布的图文档，也不依赖 Blockly。
 * 它和 `canvas/compile.ts`、`canvas/save.ts` 一样属于新版画布的地盘；旧画布删除后
 * 这份定义**仍然留在原地**，所以不能让新画布继续从即将消失的 `workflow/types.ts` 取类型。
 *
 * 过渡态（有意为之，不是漏改）：旧 `workflow/types.ts` 里暂时还留着一份**同形状**定义，
 * 因为旧编译链（`workflow/*`、`compiler/*`、`graph/*`）还没搬家，这一步不动它们。
 * 两份定义在类型上结构兼容，但**禁止各自演化**：改字段必须同时改两处，
 * 直到旧画布删除、只留下本模块这一份。
 *
 * 只搬产物契约：`PortType`（共享包已有）、`WorkflowDocument`、`WorkflowContext`、
 * `PythonEvaluator` 等旧画布独有的东西留在原处，不复制进来。
 */

/** 编译产物里的动作：与现有动作协议完全一致，服务端仍做权限校验与权威判题。 */
export type CompiledAction = PrimitiveAction | BlockAction;

/**
 * `WorkflowIssue` / `WorkflowIssueCode` 定义在 `@pwn2block/shared`：服务端校验、共享 Schema
 * 与旧编译器都要用同一份，复制到 web 会立刻分叉。这里只做**再导出**，让新画布所有
 * 产物相关类型有同一个入口，不必知道共享包把它们放在哪个文件里。
 */
export type { WorkflowIssue, WorkflowIssueCode } from '@pwn2block/shared';

/**
 * 预览条目的类型标签。
 *
 * 旧编译按端口类型标注；新版画布（`canvas/compile.ts`）产出的预览不属于任何端口，
 * 统一标成 `canvas`。界面目前只读 `summary`，所以这里是**加宽**而不是换一套类型：
 * 旧画布删除后，这个联合再收敛成 `'canvas'`（那是一次形状改动，要连同测试一起做）。
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
