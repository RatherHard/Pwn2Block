/**
 * 积木层（H 的写入范围：`packages/web/src/blocks/**`）。
 *
 * - `catalog.ts`：积木目录（类型名 / 字段 / 输入槽 / 中文文案 / tooltip），动作按 `allowedActions` 过滤。
 * - `definitions.ts`：把目录翻译成真实 Blockly 积木定义（`definePwn2BlockBlocks` 幂等注册）。
 * - `toolbox.ts`：生成 Blockly 的 categoryToolbox 数据。
 * - `workspace.ts`：Blockly workspace → 归一化积木树（喂给 `../compiler` 的 `compileProgram`）。
 * - `mount.ts`：挂载桥（inject / 编辑事件 / `loadProgram` 程序化装载 / 错误定位 / 卸载），
 *   页面只跟它打交道。
 */
export * from './catalog';
export * from './definitions';
export * from './toolbox';
export * from './workspace';
export * from './mount';
