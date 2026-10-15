import * as Blockly from 'blockly';
import type { AuthorBlock } from '@pwn2block/shared';
import { BLOCK_TYPES, type BlockType, authorBlockType } from '../compiler/types';
import {
  BLOCK_SPECS,
  SHADOW_MATH_NUMBER,
  TOOLBOX_CATEGORY_META,
  type BlockFieldSpec,
  type BlockInputSpec,
  type BlockSpec,
  authorBlockSpec,
} from './catalog';

/**
 * 把 `catalog.ts` 的**数据描述**翻译成真实的 Blockly 积木定义（H01，05 §3.1）。
 *
 * 分工：`catalog.ts` 只说"有哪些积木、字段叫什么、中文叫什么"；本文件是唯一一处
 * `BlockSpec → Blockly` 的翻译，所以两边不会各写一套控件。编译器认的类型名、输入槽名、
 * 字段名仍然全部来自 `compiler/types.ts`（catalog 已经把常量传下去了）。
 *
 * 三条实现约定：
 * - **画布形态必须显式登记**：`BLOCK_SHAPES` 覆盖 `BLOCK_TYPES` 的每一个键，新增积木时
 *   忘了登记会在运行期立刻抛错，而不是静默变成值块。
 * - **变量字段存名字**：Blockly 的 `FieldVariable.getValue()` 给的是变量 **id**，而编译契约
 *   要的是**名字**（`FIELDS.variable`）；这一层只负责把字段挂上去，取名字的转换在
 *   `workspace.ts` 的归一化里做（见那里的说明）。
 * - **影子积木的默认值必须来自 catalog**：`step` / `run` 的输入"空着"有默认含义，
 *   挂上影子块就永远不空，所以影子值取文档里的默认值而不是数字积木自己的 0
 *   （原因写在 `BlockInputSpec.shadowValue` 的注释里）。
 */

/** 影子数字积木的字段名：catalog 里的 `math_number` 用的就是它。 */
const SHADOW_NUMBER_FIELD = 'NUM';

/**
 * 变量字段的默认变量名。
 *
 * 取 `n`：编译器既有测试与 05 §4 的示例都用它（`fields: { VAR: 'n' }`），
 * 而且比 Blockly 自动生成的 `item` / `item1` 更符合中文界面里的示例习惯。
 */
export const DEFAULT_VARIABLE_NAME = 'n';

/** 画布形态：语句块（有前后连接）还是值块（有输出连接）。 */
type BlockShape = 'statement' | 'value';

/** 画布上只允许一个「开始」积木（05 §3.1）。 */
export const START_BLOCK_MAX_INSTANCES = 1;

/**
 * 传给 `Blockly.inject` 的 `maxInstances`。
 *
 * Blockly 会在**工具箱拖出、复制、粘贴**这三条路径上按它禁用超额的积木
 * （`remainingCapacityOfType` / `isCapacityAvailable`）。注意 `workspace.newBlock()`
 * 是程序化创建，Blockly 不查容量——所以「唯一开始块」的最终兜底是编译期：
 * 画布上真出现两个开始积木时，编译器报 `MESSAGE_MULTIPLE_START_BLOCKS`
 * 并指出积木位置（`compiler/compile.ts`）。两条防线缺一不可。
 */
export const BLOCK_MAX_INSTANCES: Readonly<Record<string, number>> = {
  [BLOCK_TYPES.start]: START_BLOCK_MAX_INSTANCES,
};

/**
 * 每个积木类型的画布形态。
 *
 * `value_addr` 不在 `BLOCK_SPECS` 里（它属于出题人侧/未来的地址值积木），但类型名在
 * `BLOCK_TYPES` 里，所以这里也要登记——`Record<BlockType, …>` 会让漏登记变成类型错误。
 */
const BLOCK_SHAPES: Readonly<Record<BlockType, BlockShape>> = {
  [BLOCK_TYPES.start]: 'statement',

  [BLOCK_TYPES.varsSet]: 'statement',
  [BLOCK_TYPES.varsGet]: 'value',
  [BLOCK_TYPES.mathNumber]: 'value',
  [BLOCK_TYPES.mathArithmetic]: 'value',
  [BLOCK_TYPES.logicCompare]: 'value',
  [BLOCK_TYPES.valueAddr]: 'value',
  [BLOCK_TYPES.controlsIf]: 'statement',
  [BLOCK_TYPES.controlsRepeat]: 'statement',
  [BLOCK_TYPES.controlsWhileUntil]: 'statement',

  [BLOCK_TYPES.bytesPadding]: 'value',
  [BLOCK_TYPES.bytesString]: 'value',
  [BLOCK_TYPES.bytesInt]: 'value',
  [BLOCK_TYPES.bytesAddr]: 'value',
  [BLOCK_TYPES.bytesRaw]: 'value',
  [BLOCK_TYPES.bytesConcat]: 'value',

  [BLOCK_TYPES.actionWriteBytes]: 'statement',
  [BLOCK_TYPES.actionPush]: 'statement',
  [BLOCK_TYPES.actionPop]: 'statement',
  [BLOCK_TYPES.actionCall]: 'statement',
  [BLOCK_TYPES.actionRet]: 'statement',
  [BLOCK_TYPES.actionFeed]: 'statement',
  [BLOCK_TYPES.actionStep]: 'statement',
  [BLOCK_TYPES.actionRun]: 'statement',
};

/** 一个 Blockly 积木定义：目前只需要 `init`（`BlockDefinition` 在上游是 `any`）。 */
export interface Pwn2BlockDefinition {
  init(this: Blockly.Block): void;
}

/** 该描述的画布形态；出题人积木是动作，一律语句块。 */
function shapeOf(spec: BlockSpec): BlockShape {
  if (spec.category === 'author') return 'statement';
  const shape = BLOCK_SHAPES[spec.type as BlockType];
  if (shape === undefined) {
    throw new Error(
      `积木 ${spec.type} 未登记画布形态：新增积木时必须在 BLOCK_SHAPES 里声明它是语句块还是值块`,
    );
  }
  return shape;
}

function makeField(spec: BlockFieldSpec): Blockly.Field {
  switch (spec.kind) {
    case 'dropdown': {
      const options = (spec.options ?? []).map(
        (option): [string, string] => [option.label, option.value],
      );
      if (options.length === 0) {
        throw new Error(`积木字段 ${spec.name} 声明为下拉，但没有给选项`);
      }
      const field = new Blockly.FieldDropdown(options);
      if (spec.defaultValue !== undefined) field.setValue(spec.defaultValue);
      return field;
    }
    case 'number':
      return new Blockly.FieldNumber(numericDefault(spec));
    case 'text':
      return new Blockly.FieldTextInput(stringDefault(spec));
    case 'variable':
      return new Blockly.FieldVariable(DEFAULT_VARIABLE_NAME);
  }
}

function numericDefault(spec: BlockFieldSpec): number {
  const value = spec.defaultValue;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`积木字段 ${spec.name} 声明为数字，但默认值不是有限数字`);
}

function stringDefault(spec: BlockFieldSpec): string {
  const value = spec.defaultValue;
  if (value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * 字段的文字说明。
 *
 * 变量字段**不加**说明文字：字段本身显示的就是变量名，而 `vars_get` 的积木文案已经是
 * 「变量」，再加一遍会读成「变量 变量 n」。
 */
function fieldLabelOf(spec: BlockFieldSpec): string | undefined {
  return spec.kind === 'variable' ? undefined : spec.label;
}

function appendInput(block: Blockly.Block, spec: BlockInputSpec): void {
  const input =
    spec.kind === 'statement'
      ? block.appendStatementInput(spec.name)
      : block.appendValueInput(spec.name);
  if (spec.label !== '') input.appendField(spec.label);
  if (spec.kind === 'value' && spec.shadow !== undefined) {
    attachShadow(input, spec);
  }
}

/** 给值输入挂影子积木；只有 `math_number` 需要写数字字段，其余只给类型。 */
function attachShadow(input: Blockly.Input, spec: BlockInputSpec): void {
  const shadow = spec.shadow;
  if (shadow === undefined) return;
  const connection = input.connection;
  if (connection === null || connection === undefined) return;
  if (shadow === SHADOW_MATH_NUMBER) {
    // catalog 的注释要求这里的默认值等于文档里的默认值，而不是数字积木自己的 0。
    connection.setShadowState({
      type: shadow,
      fields: { [SHADOW_NUMBER_FIELD]: spec.shadowValue ?? 0 },
    });
    return;
  }
  connection.setShadowState({ type: shadow });
}

function initBlock(block: Blockly.Block, spec: BlockSpec): void {
  block.appendDummyInput().appendField(spec.label);
  for (const field of spec.fields ?? []) {
    const dummy = block.appendDummyInput();
    const label = fieldLabelOf(field);
    if (label !== undefined && label !== '') dummy.appendField(label);
    // 字段名必须显式传进去：不传的话 Blockly 不会给字段命名，
    // `block.getField('WIDTH')` 找不到它，归一化与编译期就都读不到这个字段。
    dummy.appendField(makeField(field), field.name);
  }
  for (const input of spec.inputs ?? []) appendInput(block, input);

  if (shapeOf(spec) === 'value') {
    block.setOutput(true, null);
  } else {
    // 「开始」积木是链首：它只有下一个连接，没有上一个。
    if (spec.type !== BLOCK_TYPES.start) block.setPreviousStatement(true, null);
    block.setNextStatement(true, null);
  }
  block.setColour(TOOLBOX_CATEGORY_META[spec.category].colour);
  block.setTooltip(spec.tooltip);
}

/** 单个积木描述的定义对象；导出给测试直接断言，不必先注册。 */
export function blockDefinitionOf(spec: BlockSpec): Pwn2BlockDefinition {
  return {
    init(this: Blockly.Block): void {
      initBlock(this, spec);
    },
  };
}

function registerAll(specs: readonly BlockSpec[]): number {
  const definitions: Record<string, Pwn2BlockDefinition> = {};
  for (const spec of specs) {
    // 幂等：已经注册过的类型直接跳过（重复 defineBlocks 会覆盖，且同一类型可能被多次调用）。
    if (Blockly.Blocks[spec.type] !== undefined) continue;
    definitions[spec.type] = blockDefinitionOf(spec);
  }
  const types = Object.keys(definitions);
  if (types.length > 0) Blockly.common.defineBlocks(definitions);
  return types.length;
}

/**
 * 注册通用 / 字节 / 动作积木（catalog 里的全部静态积木）。
 *
 * 幂等：重复调用不会重复注册，也不会覆盖已有定义。测试与挂载桥都可以放心调用。
 */
export function definePwn2BlockBlocks(): number {
  return registerAll(BLOCK_SPECS);
}

/**
 * 注册本题的出题人积木（类型名 `author_<id>`）。
 *
 * 规格随题目变化，所以和静态积木分开；同一个 id 只会注册一次。**换题需要刷新页面**：
 * 同名出题人积木不会就地改定义（真实场景里一个会话只服务一道题，04 §1）。
 */
export function defineAuthorBlockDefinitions(challenge: {
  readonly authorBlocks?: readonly AuthorBlock[];
}): number {
  return registerAll((challenge.authorBlocks ?? []).map(authorBlockSpec));
}

/** 出题人积木的类型名，供测试与挂载桥核对（避免各处硬编码前缀）。 */
export function registeredAuthorTypes(challenge: {
  readonly authorBlocks?: readonly AuthorBlock[];
}): readonly string[] {
  return (challenge.authorBlocks ?? []).map((block) => authorBlockType(block.id));
}
