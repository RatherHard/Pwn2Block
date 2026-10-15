import { CONCAT_ITEM_PREFIX } from './types';
import type { BlockFieldValue, NormalizedBlock } from './types';

/**
 * 归一化积木树上的纯读取工具。
 *
 * 它们只做"取值 + 基本校验"，不认识积木语义；语义与报错都在 `expr.ts` / `statement.ts`，
 * 这样字段名或取值口径变了只需要改一处。
 */

/** 字段是否存在（即使值为空串）。用于区分"没这个字段"和"字段值不合法"。 */
export function hasField(block: NormalizedBlock, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(block.fields, name);
}

/** 读字符串字段：Blockly 的数字字段也会被转成字符串，方便下拉 / 文本字段统一处理。 */
export function readStringField(block: NormalizedBlock, name: string): string | undefined {
  const raw: BlockFieldValue | undefined = block.fields[name];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return undefined;
}

/** 读数字字段；字段不是可用数字时返回 `undefined`，由调用方决定是否报错。 */
export function readNumberField(block: NormalizedBlock, name: string): number | undefined {
  const raw: BlockFieldValue | undefined = block.fields[name];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** 输入槽上连接的积木；未连接时是 `undefined`。 */
export function inputBlock(block: NormalizedBlock, name: string): NormalizedBlock | undefined {
  return block.inputs[name];
}

/**
 * 变参输入：`item0` / `item1` / … 按数字升序取出，跳过未连接的槽。
 * `bytes_concat` 用它，将来列表类积木也可以复用同一套约定。
 */
export function variadicInputs(
  block: NormalizedBlock,
  prefix: string = CONCAT_ITEM_PREFIX,
): readonly NormalizedBlock[] {
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  const indexed: { index: number; block: NormalizedBlock }[] = [];
  for (const [key, value] of Object.entries(block.inputs)) {
    if (value === undefined) continue;
    const matched = pattern.exec(key);
    if (!matched) continue;
    indexed.push({ index: Number(matched[1]), block: value });
  }
  indexed.sort((left, right) => left.index - right.index);
  return indexed.map((entry) => entry.block);
}
