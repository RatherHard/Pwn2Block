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
export * from './workflow';
/**
 * 新版画布（节点画布改版）的语义层。用命名空间导出而不是 `export *`：
 * 它和旧 `workflow/` 里同名的 `EncodedValue`、`Value` 等概念并存一段时间，
 * 命名空间能让调用点显式写 `canvas.xxx`，改版完成后旧的那一份整体删除。
 */
export * as canvas from './canvas';
