/**
 * 积木层（H 的写入范围：`packages/web/src/blocks/**`）。
 *
 * - `catalog.ts`：积木目录（类型名 / 字段 / 输入槽 / 中文文案 / tooltip），动作按 `allowedActions` 过滤。
 * - `toolbox.ts`：生成 Blockly 的 categoryToolbox 数据。
 * - `workspace.ts`：Blockly workspace → 归一化积木树（喂给 `../compiler` 的 `compileProgram`）。
 */
export * from './catalog';
export * from './toolbox';
export * from './workspace';
