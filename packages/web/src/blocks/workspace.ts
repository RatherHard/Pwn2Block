import type { Workspace } from 'blockly';
import type { NormalizedBlock, NormalizedWorkspace } from '../compiler/types';

/**
 * Blockly workspace → 归一化积木树的适配器（08 §2 规则 3）。
 *
 * 为什么用"窄接口"而不是直接吃 `Blockly.Workspace`：
 * - 这一层是编译路径上**唯一**接触 Blockly 对象的地方，归一化之后编译器只看到纯数据，
 *   于是编译器可以在 node 里单测（vitest 环境是 node，没有 DOM）。
 * - 窄接口是 Blockly 公共 API 的结构子集，`BlocklyWorkspaceIsCompatible` 在编译期保证
 *   真实 `Workspace` 可以直接传进来（D2 用），测试则传手写的假对象。
 *
 * 归一化规则：
 * - `fields`：遍历每个输入的 `fieldRow`，取有 `name` 的字段；Blockly 的布尔字段转成
 *   `'true'` / `'false'`，数字字段保留数字。
 * - `inputs`：只记录**连上了积木**的输入槽，未连接的槽不出现（编译器按 `undefined` 处理）。
 * - `next`：语句链上的下一块；值表达式没有 `next`。
 * - 被禁用的积木（`isEnabled() === false`）视为未连接，不参与编译。
 * - 成环或重复引用同一个块 id 一律抛错：编译器依赖"树"这个前提，坏数据不能悄悄传下去。
 */

export interface BlocklyFieldLike {
  readonly name?: string;
  getValue(): unknown;
}

export interface BlocklyConnectionLike {
  targetBlock(): BlocklyBlockLike | null;
}

export interface BlocklyInputLike {
  readonly name: string;
  readonly connection: BlocklyConnectionLike | null;
  /** Blockly v13 把字段挂在输入上（`Input.fieldRow`）。 */
  readonly fieldRow?: readonly BlocklyFieldLike[];
}

export interface BlocklyBlockLike {
  readonly id: string;
  readonly type: string;
  readonly inputList: readonly BlocklyInputLike[];
  getNextBlock(): BlocklyBlockLike | null;
  isEnabled?(): boolean;
}

export interface BlocklyWorkspaceLike {
  getTopBlocks(ordered?: boolean): readonly BlocklyBlockLike[];
}

/** 编译期保证真实 Blockly `Workspace` 满足窄接口：不满足时这里会编译报错。 */
type CompatibleWorkspace<T extends BlocklyWorkspaceLike> = T;
export type BlocklyWorkspaceIsCompatible = CompatibleWorkspace<Workspace>;

export type WorkspaceErrorCode = 'cycle' | 'missing_id';

/** 归一化失败：输入不是一棵良构的积木树（正常 Blockly 画布不会出现）。 */
export class WorkspaceNormalizationError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceNormalizationError';
    this.code = code;
  }
}

/** 把整个画布归一化成积木树森林。 */
export function normalizeWorkspace(workspace: BlocklyWorkspaceLike): NormalizedWorkspace {
  const seen = new Set<string>();
  const blocks: NormalizedBlock[] = [];
  // ordered=true：顺序稳定，便于错误列表与测试断言。
  for (const top of workspace.getTopBlocks(true)) {
    if (isDisabled(top)) continue;
    blocks.push(normalizeBlock(top, seen));
  }
  return { blocks };
}

function isDisabled(block: BlocklyBlockLike): boolean {
  return block.isEnabled?.() === false;
}

function normalizeBlock(block: BlocklyBlockLike, seen: Set<string>): NormalizedBlock {
  if (block.id === '') {
    throw new WorkspaceNormalizationError('missing_id', '积木缺少 id，无法把编译错误定位回画布');
  }
  if (seen.has(block.id)) {
    throw new WorkspaceNormalizationError('cycle', `积木成环或重复引用：${block.id}`);
  }
  seen.add(block.id);

  const next = block.getNextBlock();
  const normalized: NormalizedBlock = {
    id: block.id,
    type: block.type,
    fields: readFields(block),
    inputs: readInputs(block, seen),
    ...(next === null || isDisabled(next) ? {} : { next: normalizeBlock(next, seen) }),
  };
  return normalized;
}

function readFields(block: BlocklyBlockLike): Record<string, string | number> {
  const fields: Record<string, string | number> = {};
  for (const input of block.inputList) {
    for (const field of input.fieldRow ?? []) {
      if (field.name === undefined || field.name === '') continue;
      const value = toFieldValue(field.getValue());
      if (value !== undefined) fields[field.name] = value;
    }
  }
  return fields;
}

function toFieldValue(raw: unknown): string | number | undefined {
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return undefined;
}

function readInputs(
  block: BlocklyBlockLike,
  seen: Set<string>,
): Record<string, NormalizedBlock | undefined> {
  const inputs: Record<string, NormalizedBlock | undefined> = {};
  for (const input of block.inputList) {
    const child = input.connection?.targetBlock() ?? null;
    if (child === null || isDisabled(child)) continue;
    inputs[input.name] = normalizeBlock(child, seen);
  }
  return inputs;
}
