/**
 * 视图数据上下文：所有视图共用同一份最新投影（05 §2.1）。
 *
 * 类型与构造函数定义在 `src/viewmodel/context.ts`（纯函数、可单测）；这里只是组件侧的入口名，
 * 让每个视图都从同一个地方取类型。**`roles` 来自投影**，见 `createViewContext` 的说明。
 */
export { createViewContext, type ViewContext, type ViewContextInput } from '../viewmodel/context';
