import type { AuthorBlock } from '@pwn2block/shared';
import type { BlockCategory } from './catalog';
import { TOOLBOX_CATEGORY_META, blocksForChallenge } from './catalog';

/**
 * 工具箱生成（05 §3.1）。
 *
 * 工具箱是**纯数据**：按题目的 `allowedActions` 过滤动作积木，按 `authorBlocks` 动态追加
 * 出题人积木。Blockly 只负责把它渲染出来，所以这里能在 node 里直接单测。
 *
 * 未允许的动作不出现（05 §3.1），但这只是便利——真正拦住它们的是编译器与服务端
 * （编译期报错、服务端再校验一次，04 §2）。
 */

export interface ToolboxBlockEntry {
  readonly kind: 'block';
  readonly type: string;
}

export interface ToolboxCategory {
  readonly kind: 'category';
  readonly name: string;
  readonly colour: string;
  readonly contents: readonly ToolboxBlockEntry[];
}

export interface ToolboxDefinition {
  readonly kind: 'categoryToolbox';
  readonly contents: readonly ToolboxCategory[];
}

/** 分类在工具箱里的固定顺序：先开始，后通用 / 字节 / 动作，出题人积木排最后。 */
export const CATEGORY_ORDER: readonly BlockCategory[] = [
  'start',
  'generic',
  'bytes',
  'action',
  'author',
];

export interface ToolboxChallenge {
  readonly allowedActions: readonly string[];
  readonly authorBlocks?: readonly AuthorBlock[];
}

/** 生成 Blockly 的 categoryToolbox 数据；空分类不会出现。 */
export function buildToolbox(challenge: ToolboxChallenge): ToolboxDefinition {
  const visible = blocksForChallenge(challenge);
  const contents: ToolboxCategory[] = [];

  for (const category of CATEGORY_ORDER) {
    const entries = visible
      .filter((spec) => spec.category === category)
      .map((spec): ToolboxBlockEntry => ({ kind: 'block', type: spec.type }));
    if (entries.length === 0) continue;
    contents.push({
      kind: 'category',
      name: TOOLBOX_CATEGORY_META[category].name,
      colour: TOOLBOX_CATEGORY_META[category].colour,
      contents: entries,
    });
  }

  return { kind: 'categoryToolbox', contents };
}

/** 工具箱里出现的全部积木类型，方便测试与调试面板核对。 */
export function toolboxBlockTypes(challenge: ToolboxChallenge): readonly string[] {
  return buildToolbox(challenge).contents.flatMap((category) =>
    category.contents.map((entry) => entry.type),
  );
}
