/**
 * 客户端编译接缝的对外出口。
 *
 * 旧编译链（`compile / context / expr / statement / fields / bytes`）已随旧画布一起删除：
 * 现在真正编译 payload 的是 `canvas/compile.ts`，这里只剩判题、运行、高亮仍共用的三样东西：
 * - `artifact.ts`：`PayloadArtifact` 形状与「产物 + 编辑后过期」状态机；
 * - `locate.ts`：动作来源表 → 画布定位桥（错误 `blockId`、录像动作帧）；
 * - `types.ts`：`CompiledAction` / `ActionOrigin` / `CompileError` 等跨层契约。
 *
 * 这一层不 import Blockly、不碰 DOM，所以能在 node 里直接单测（08 §2 规则 3）。
 */
export * from './artifact';
export * from './locate';
export * from './types';
