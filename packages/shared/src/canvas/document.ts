import type { BinaryOperator, ConversionSpec, UnaryOperator } from './operators';
import type { EncodedDictKey, EncodedScalarValue } from './value-codec';
import type { ValueKind } from './value';

/**
 * 新版画布的文档模型（需求 §2.2、§4.1、§6.1、§8）。
 *
 * 这一层只描述**可序列化的结构**，不碰 DOM、不碰求值：
 * - 每个数据节点产出一个值，输入写成**别的节点的 id**。表达式结构完全由引用决定，
 *   坐标与连线的先后不参与求值顺序（需求 §2.3「节点坐标、连线交叉不隐含优先级」）。
 * - **组合**（`group`）保存行列与模式：外层数组是行、内层是成员 id，顺序即先行后列；
 *   整组移动不改变值，只有吸附/脱离/重排/改模式才改结构（需求 §2.2）。
 * - **转换包络**（`convert`）通过 `input` 引用内部结构；包住「局部」就是包住一个子组合，
 *   因此嵌套天然成立，而「一个节点只能属于一个容器」由校验器检查（需求 §4.1）。
 * - `main` 是流程执行序列，阶段二才写入；阶段一恒为空，但字段先占位，免得存档再进一次位。
 */

/** 存档格式标识：与旧的 `pwn2block.workflow` 不同，读到旧格式直接判「不兼容」。 */
export const CANVAS_FORMAT = 'pwn2block.canvas';

/** 文档版本。不兼容的改动必须进位，读不到就明说，不猜。 */
export const CANVAS_VERSION = 2;

export const CANVAS_NODE_KINDS = [
  'value',
  'group',
  'dict',
  'relation',
  'unary',
  'index',
  'lookup',
  'slice',
  'repeat',
  'convert',
] as const;

export type CanvasNodeKind = (typeof CANVAS_NODE_KINDS)[number];

/** 节点 id：稳定、可读、能进 CSS 选择器；与旧画布同一口径。 */
export const CANVAS_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const CANVAS_NODE_KIND_LABELS: Readonly<Record<CanvasNodeKind, string>> = {
  value: '值',
  group: '组合',
  dict: '字典',
  relation: '运算',
  unary: '附属操作',
  index: '按索引取元素',
  lookup: '按键取值',
  slice: '切片',
  repeat: '重复',
  convert: '转换',
};

/** 组合的两种模式（需求 §2.2）。成员必须同类型的是「合并为串」，其余一律「组成列表」。 */
export const GROUP_MODES = ['merge', 'list'] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

export const GROUP_MODE_LABELS: Readonly<Record<GroupMode, string>> = {
  merge: '合并为串',
  list: '组成列表',
};

interface CanvasNodeBase {
  readonly id: string;
}

/**
 * 字面值节点：直接承载一个标量。
 *
 * 列表不在这里：列表由组合产生，保证「列表 = 一组摆放好的成员」这一条唯一来源。
 */
export interface ValueNode extends CanvasNodeBase {
  readonly kind: 'value';
  readonly value: EncodedScalarValue;
}

/** 吸附组合：`rows` 外层是行、内层是成员 id；成员按先行后列展开。 */
export interface GroupNode extends CanvasNodeBase {
  readonly kind: 'group';
  readonly mode: GroupMode;
  readonly rows: readonly (readonly string[])[];
}

/** 字典节点：键是字面键（字符串或整数），值是别的节点。 */
export interface DictNode extends CanvasNodeBase {
  readonly kind: 'dict';
  readonly entries: readonly { readonly key: EncodedDictKey; readonly value: string }[];
}

/** 关系方框：一个二元运算，左右操作数各引用一个节点。 */
export interface RelationNode extends CanvasNodeBase {
  readonly kind: 'relation';
  readonly op: BinaryOperator;
  readonly left: string;
  readonly right: string;
}

/** 附属操作：取反、长度。 */
export interface UnaryNode extends CanvasNodeBase {
  readonly kind: 'unary';
  readonly op: UnaryOperator;
  readonly operand: string;
}

/** 按索引取元素：列表、字节串、文本。 */
export interface IndexNode extends CanvasNodeBase {
  readonly kind: 'index';
  readonly target: string;
  readonly index: string;
}

/** 字典按键取值（缺失键报错）。 */
export interface LookupNode extends CanvasNodeBase {
  readonly kind: 'lookup';
  readonly target: string;
  readonly key: string;
}

/** 切片：`[开始:结束:步长]`，三段都可省略，省略即默认（需求 §2.3）。 */
export interface SliceNode extends CanvasNodeBase {
  readonly kind: 'slice';
  readonly target: string;
  readonly start?: string;
  readonly end?: string;
  readonly step?: string;
}

/** 重复：列表、字节串、文本按次数重复。 */
export interface RepeatNode extends CanvasNodeBase {
  readonly kind: 'repeat';
  readonly target: string;
  readonly count: string;
}

/** 转换包络：外壳连同内部结构对外是一个数据节点，只给一个转换结果（需求 §4.1）。 */
export interface ConvertNode extends CanvasNodeBase {
  readonly kind: 'convert';
  readonly spec: ConversionSpec;
  readonly input: string;
}

export type CanvasNode =
  | ValueNode
  | GroupNode
  | DictNode
  | RelationNode
  | UnaryNode
  | IndexNode
  | LookupNode
  | SliceNode
  | RepeatNode
  | ConvertNode;

/** 节点位置：只影响显示，不进语义版本（需求 §2.2「普通移动整个组合不改变值」）。 */
export interface CanvasNodeLayout {
  readonly x: number;
  readonly y: number;
}

export interface CanvasDocument {
  readonly format: typeof CANVAS_FORMAT;
  readonly version: number;
  readonly nodes: readonly CanvasNode[];
  readonly layout: Readonly<Record<string, CanvasNodeLayout>>;
  /** 流程执行序列（阶段二写入；阶段一为空数组）。 */
  readonly main: readonly string[];
}

/** 空画布：没有任何节点，能保存、能恢复、能通过形状校验；能否执行由校验器判定。 */
export function emptyCanvasDocument(): CanvasDocument {
  return {
    format: CANVAS_FORMAT,
    version: CANVAS_VERSION,
    nodes: [],
    layout: {},
    main: [],
  };
}

// ---------------------------------------------------------------------------
// 结构查询
// ---------------------------------------------------------------------------

/** 节点引用的上游节点 id，按输入顺序；重复引用（同一上游接两个输入）保留重复。 */
export function inputIdsOf(node: CanvasNode): readonly string[] {
  switch (node.kind) {
    case 'value':
      return [];
    case 'group':
      return groupMembers(node);
    case 'dict':
      return node.entries.map((entry) => entry.value);
    case 'relation':
      return [node.left, node.right];
    case 'unary':
      return [node.operand];
    case 'index':
      return [node.target, node.index];
    case 'lookup':
      return [node.target, node.key];
    case 'slice':
      return [node.target, node.start, node.end, node.step].filter((id): id is string => id !== undefined);
    case 'repeat':
      return [node.target, node.count];
    case 'convert':
      return [node.input];
  }
}

/** 组合的成员：先行后列（需求 §2.2「先从左到右、再从上到下」）。 */
export function groupMembers(node: GroupNode): readonly string[] {
  return node.rows.flat();
}

/** 组合的成员数。 */
export function groupMemberCount(node: GroupNode): number {
  return node.rows.reduce((sum, row) => sum + row.length, 0);
}

/** 建组时的默认模式：全字节串合并为字节串、全文本合并为文本，其余组成列表（需求 §2.2）。 */
export function suggestGroupMode(kinds: readonly ValueKind[]): GroupMode {
  if (kinds.length === 0) return 'list';
  if (kinds.every((kind) => kind === 'byte')) return 'merge';
  if (kinds.every((kind) => kind === 'string')) return 'merge';
  return 'list';
}

/** 节点表：重复 id 保留第一个，重复本身由校验器报。 */
export function nodeMapOf(document: CanvasDocument): ReadonlyMap<string, CanvasNode> {
  const map = new Map<string, CanvasNode>();
  for (const node of document.nodes) {
    if (!map.has(node.id)) map.set(node.id, node);
  }
  return map;
}

/** 谁引用了 `targetId`：返回值是引用者的节点 id（同一声明可被多处引用，需求 §6.1）。 */
export function consumersOf(document: CanvasDocument, targetId: string): readonly string[] {
  const consumers: string[] = [];
  for (const node of document.nodes) {
    if (inputIdsOf(node).includes(targetId)) consumers.push(node.id);
  }
  return consumers;
}

/**
 * 归属表：节点 id → 包住它的组合节点 id。
 *
 * 归属只由成员关系决定，不看坐标（需求 §4.1「包络是结构容器，不是按坐标判断成员的视觉选框」）。
 * 一个节点出现两次就记第一个，重复归属由校验器报。
 */
export function ownerMapOf(document: CanvasDocument): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const node of document.nodes) {
    if (node.kind !== 'group') continue;
    for (const member of groupMembers(node)) {
      if (!owners.has(member)) owners.set(member, node.id);
    }
  }
  return owners;
}

/** 从某个节点向上找所有容器（由内到外），用于「包络整个整体」与解除包络。 */
export function ownersOf(document: CanvasDocument, nodeId: string): readonly string[] {
  const owners = ownerMapOf(document);
  const chain: string[] = [];
  let current = owners.get(nodeId);
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = owners.get(current);
  }
  return chain;
}
