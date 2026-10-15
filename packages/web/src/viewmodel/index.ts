/**
 * `src/viewmodel` 的公开入口：全部为**纯函数**，不依赖 DOM 与 lit。
 *
 * 组件只做排版与事件转发；可测逻辑放这里，组件渲染留给 D5 的 Playwright（05 §7）。
 */
export * from './context';
export * from './controller';
export * from './diff';
export * from './disasm';
export * from './format';
export * from './io';
export * from './keymap';
export * from './labels';
export * from './memory';
export * from './output';
export * from './pointer';
export * from './program';
export * from './queue';
export * from './reader';
export * from './registers';
export * from './replay';
export * from './roles';
export * from './session';
export * from './stack';
export * from './toolbar';
export * from './verdict';
export * from './views';
