/**
 * 编译结果的跨层契约（判题、运行、高亮、输出区共用）。
 *
 * 这里只留**还有活调用方**的形状：
 * - `CompiledAction`：8 类原子动作 + 出题人积木（展开由服务端完成，03 §3）；
 * - `ActionOrigin` + `ACTION_ORIGIN_VERSION`：动作 → 画布节点的来源表（08 §9.2）；
 * - `CompileError`：编译问题，`blockId` 空串表示「没有具体位置」。
 *
 * 旧画布的编译器（`compile / context / expr / statement / fields / bytes`）连同它的
 * 积木类型名、字段表、上限常量一起删掉了：现在真正产出动作的是 `canvas/compile.ts`，
 * 它给出 `WorkflowArtifact`，进控制器的入口是 `compiler/artifact.ts` 的 `adopt()`。
 * 所以这里不再有 `NormalizedWorkspace`／`CompileResult`／`CompilerLimits` 之类只服务旧编译链的类型。
 */
import type { BlockAction, PrimitiveAction } from '@pwn2block/shared';

/** 编译产物：8 类原子动作 + 出题人积木（展开由服务端完成，03 §3）。 */
export type CompiledAction = PrimitiveAction | BlockAction;

/**
 * 动作来源：`actions[i]` 是由画布上哪个节点产生的（05 §3、08 §9.2）。
 *
 * 前端用它把输出区 / 录像里的某一步跳回画布上的节点；它**不进网络 payload**。
 */
export interface ActionOrigin {
  /** 在 `actions` 里的下标（显式写出来，便于前端建索引时自证对齐）。 */
  readonly index: number;
  /**
   * 产生该动作的节点 id。
   * 循环展开出的每一次迭代都指向**同一个**循环节点（不是循环体里那一块）：
   * 前端点某一步时要能跳回「就是这个循环」。
   */
  readonly blockId: string;
}

/** 来源表格式版本：与产物版本不一致时按「来源未知」处理，不做猜测式定位。 */
export const ACTION_ORIGIN_VERSION = 1;

export interface CompileError {
  /** 出错节点的 id；空串表示「没有具体位置可指」，见 `compiler/locate.ts` 的 `isLocatableError`。 */
  readonly blockId: string;
  readonly message: string;
}
