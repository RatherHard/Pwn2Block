/**
 * 节点画布的共享契约（07 §3）。
 *
 * 依赖方向：只依赖 `shared` 内的其他模块，不引用画布库、浏览器 API 或求值实现。
 * 图模型、节点目录与传输编码都在这里，前端与后端读的是同一份定义。
 */
export * from './catalog';
export * from './catalog-library';
export * from './save';
export * from './schema';
export * from './toolkit';
export * from './types';
export * from './values';
