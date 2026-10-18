/**
 * 节点画布的图模型、校验、求值与编译（07 §3）。
 *
 * 依赖方向：`workflow/` 不 import `graph/`（画布库适配）也不 import `components/`；
 * 画布组件反过来消费这里。所以编译器、校验器能在 node 里直接单测（07 §6）。
 */
export * from './artifact';
export * from './compile';
export * from './document';
export * from './evaluate';
export * from './params';
export * from './types';
export * from './validate';
