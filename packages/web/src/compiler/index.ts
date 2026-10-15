/**
 * 客户端编译器（H 的写入范围：`packages/web/src/compiler/**`）。
 *
 * 对外只需要三样东西：
 * - `compileProgram`：归一化积木树 + 公开包 → 动作序列或带 blockId 的错误。
 * - `NormalizedBlock` / `NormalizedWorkspace` 等契约类型（`types.ts` 里写清了形状）。
 * - 字节原语 `bytes.ts`：`padding / string / int / addr / raw / concat`。
 * - `createArtifactTracker`：程序区的「产物 + 编辑后过期」状态机（`artifact.ts`）。
 * - `locate.ts`：编译结果 → 画布定位桥（错误 `blockId`、动作来源表、录像动作帧）。
 *
 * 这一层不 import Blockly、不碰 DOM，所以能在 node 里直接单测（08 §2 规则 3）。
 * Blockly workspace → 归一化积木树的适配器在 `../blocks/workspace`，不属于编译器本身。
 */
export * from './artifact';
export * from './bytes';
export * from './compile';
export * from './locate';
export * from './types';
