/**
 * 新版画布（节点画布改版）的共享语义层。
 *
 * 这一层只做纯计算：值模型、吸附组合、运算、切片、转换、文档形状、求值与校验。
 * 它不碰 DOM、不依赖 `web`；旧的 `workflow/` 已整体删除，这里（连同 `artifact.ts` 里
 * 从它搬来的两组产物类型）是唯一的事实来源。
 */
export * from './result';
export * from './value';
export * from './value-codec';
export * from './operators';
export * from './document';
export * from './issues';
export * from './ops';
export * from './collection';
export * from './slice';
export * from './convert';
export * from './evaluate';
export * from './validate';
export * from './schema';
export * from './methods';
export * from './variables';
export * from './flow';
export * from './actions';
export * from './preview';
/**
 * 产物契约：`PortType` 与 `WorkflowIssue`（从已删除的 `workflow/types.ts` 原样搬来，
 * 来龙去脉见 `artifact.ts` 的文件头）。它们不属于新画布的语义，但和产物同属一层，
 * 所以留在同一个命名空间里，调用点仍写 `canvas.PortType`。
 */
export * from './artifact';

export * from './logic-model';
export * from './logic-runtime';

export { logicLiteral } from './logic-values';
