/**
 * 节点画布与 Python 数据处理的共享契约（07 §3）。
 *
 * 依赖方向：只依赖 `shared` 内的其他模块，不引用画布库、浏览器 API 或求值实现。
 * 图模型、节点目录、传输编码和 Python 协议都在这里，前端与后端读的是同一份定义。
 */
export * from './catalog';
export * from './python';
export * from './schema';
export * from './toolkit';
export * from './types';
export * from './values';
