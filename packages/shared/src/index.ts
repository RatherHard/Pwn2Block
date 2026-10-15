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
export * from './solution';
export * from './validate';
export * from './vm';
