/**
 * `@pwn2block/shared`：类型与 Schema 的单一事实来源（07 §2）。
 *
 * 依赖方向：只被 `engine` / `server` / `web` / `authoring` 依赖，自己不依赖任何包。
 * 这里不放文件 IO、不放 HTTP、不放引擎实现。
 */
export * from './actions';
export * from './api';
export * from './challenge';
export * from './encoding';
export * from './errors';
export * from './fixtures';
export * from './hex';
export * from './limits';
export * from './placeholders';
export * from './primitives';
export * from './projection';
export * from './pseudocode';
export * from './solution';
export * from './validate';
export * from './vm';
/**
 * 新版画布（节点画布改版）的语义层。用命名空间导出而不是 `export *`：
 * 它与根上其余导出有同名概念（`Value`、`Action`、`CanvasDocument`……），
 * 命名空间让调用点显式写 `canvas.xxx`。旧的 `workflow/` 已整体删除。
 */
export * as canvas from './canvas';
/**
 * 过渡期的扁平入口：产物契约里的 `PortType` / `WorkflowIssue` 现在住在 `canvas/artifact.ts`
 * （从已删除的 `workflow/types.ts` 原样搬来），但 web 的产物模块仍按扁平名字引用它们。
 * web 侧改走 `canvas.*` 后，这三行随之删除。
 */
export type { PortType, WorkflowIssue, WorkflowIssueCode } from './canvas';
