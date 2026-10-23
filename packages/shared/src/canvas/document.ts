import type { BinaryOperator, ConversionSpec, UnaryOperator } from './operators';
import type { EncodedDictKey, EncodedScalarValue } from './value-codec';
import type { ValueKind } from './value';

/**
 * 新版画布的文档模型（需求 §2.2、§3、§4.1、§5.2、§6.1、§8）。
 *
 * 这一层只描述**可序列化的结构**，不碰 DOM、不碰求值：
 * - 每个数据节点产出一个值，输入写成**别的节点的 id**。表达式结构完全由引用决定，
 *   坐标与连线的先后不参与求值顺序（需求 §2.3「节点坐标、连线交叉不隐含优先级」）。
 * - **组合**（`group`）保存行列与模式：外层数组是行、内层是成员 id，顺序即先行后列；
 *   整组移动不改变值，只有吸附/脱离/重排/改模式才改结构（需求 §2.2）。
 * - **转换包络**（`convert`）通过 `input` 引用内部结构；包住「局部」就是包住一个子组合，
 *   因此嵌套天然成立，而「一个节点只能属于一个容器」由校验器检查（需求 §4.1）。
 * - **流程**（阶段二）用三条序列表达顺序：`main` 是顶层，分支的 `then`/`else` 与循环的 `body`
 *   是区域。一个流程节点只能出现在一条序列里，因此「回边」和「跨区域接线」在结构上无法表达，
 *   不需要靠校验器去追环（需求 §5.2）。
 * - **变量**（阶段二）有一个唯一声明 `var-decl`，读取用引用视图 `var-ref`，
 *   流程赋值用 `assign`。声明上的 `binding` 区分「初始值」与「派生绑定」（需求 §3）。
 */

/** 存档格式标识：与旧的 `pwn2block.workflow` 不同，读到旧格式直接判「不兼容」。 */
export const CANVAS_FORMAT = 'pwn2block.canvas';

/** 文档版本。不兼容的改动必须进位，读不到就明说，不猜。 */
export const CANVAS_VERSION = 2;

/** 产出值的数据节点（阶段一）。 */
export const CANVAS_DATA_NODE_KINDS = [
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

/** 也有数据结果、但依赖执行状态的节点（阶段二）：变量读取与循环索引。 */
export const CANVAS_VARIABLE_NODE_KINDS = ['var-decl', 'var-ref', 'loop-index'] as const;

/** 没有数据结果的流程节点（阶段二）。 */
export const CANVAS_FLOW_NODE_KINDS = ['start', 'if', 'loop', 'method', 'assign'] as const;

export const CANVAS_NODE_KINDS = [
  ...CANVAS_DATA_NODE_KINDS,
  ...CANVAS_VARIABLE_NODE_KINDS,
  ...CANVAS_FLOW_NODE_KINDS,
] as const;

export type CanvasDataNodeKind = (typeof CANVAS_DATA_NODE_KINDS)[number];
export type CanvasVariableNodeKind = (typeof CANVAS_VARIABLE_NODE_KINDS)[number];
export type CanvasFlowNodeKind = (typeof CANVAS_FLOW_NODE_KINDS)[number];
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
  'var-decl': '变量声明',
  'var-ref': '变量引用',
  'loop-index': '循环索引',
  start: '开始',
  if: '条件分支',
  loop: '次数循环',
  method: '方法',
  assign: '设置变量',
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

// ---------------------------------------------------------------------------
// 变量（需求 §3）
// ---------------------------------------------------------------------------

/**
 * 变量的初始化关系（需求 §3.1–3.2）。
 *
 * - `none`：未初始化。允许存在，真正读取时才报错（§3.1）。
 * - `initial`：初始值。本次执行开头算一次，之后由流程赋值更新。
 * - `derived`：派生绑定。只读，每次读取都按表达式重新求值，跟随源变量（§3.2）。
 */
export type VariableBinding =
  | { readonly mode: 'none' }
  | { readonly mode: 'initial'; readonly input: string }
  | { readonly mode: 'derived'; readonly input: string };

/** 全局变量声明：一个变量只有一份声明，名字与类型固定（需求 §3.1）。 */
export interface VarDeclNode extends CanvasNodeBase {
  readonly kind: 'var-decl';
  readonly name: string;
  readonly type: ValueKind;
  readonly binding: VariableBinding;
}

/** 引用视图：指向同一声明，读出来是当前值；重命名由声明同步（需求 §3.1）。 */
export interface VarRefNode extends CanvasNodeBase {
  readonly kind: 'var-ref';
  readonly decl: string;
}

/** 循环索引：从 0 开始、只读，只在所属循环体及其嵌套区域内可用（需求 §5.3）。 */
export interface LoopIndexNode extends CanvasNodeBase {
  readonly kind: 'loop-index';
  readonly loop: string;
}

// ---------------------------------------------------------------------------
// 流程（需求 §5）
// ---------------------------------------------------------------------------

/** 开始节点：整个工作流只有一个，且必须是 `main` 的第一项（需求 §5.2）。 */
export interface StartNode extends CanvasNodeBase {
  readonly kind: 'start';
}

/**
 * 条件分支：`then` / `else` 两条区域序列，各自顺序执行，完成后从容器出口继续（需求 §5.2）。
 *
 * 区域用**数组**而不是连线：顺序显式、不可回边、不可跨区内接线。首版不提供「分支结果」。
 */
export interface IfNode extends CanvasNodeBase {
  readonly kind: 'if';
  readonly cond: string;
  readonly then: readonly string[];
  readonly else: readonly string[];
}

/** 次数循环：进入时读一次次数（非负整数，0 次合法），`body` 顺序执行（需求 §5.3）。 */
export interface LoopNode extends CanvasNodeBase {
  readonly kind: 'loop';
  readonly count: string;
  readonly body: readonly string[];
}

/**
 * 出题方法：名称与参数来自题目公开声明，参数接数据表达式（需求 §5.4）。
 *
 * `args` 是「参数名 → 数据节点 id」。求值到这一步时把当时的参数值固定进动作，
 * 之后的变量变化不追溯修改已生成动作。
 */
export interface MethodNode extends CanvasNodeBase {
  readonly kind: 'method';
  readonly block: string;
  readonly args: Readonly<Record<string, string>>;
}

/** 流程赋值（设置变量）：执行到这一步取值一次，只写普通变量（需求 §3.2）。 */
export interface AssignNode extends CanvasNodeBase {
  readonly kind: 'assign';
  readonly target: string;
  readonly value: string;
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
  | ConvertNode
  | VarDeclNode
  | VarRefNode
  | LoopIndexNode
  | StartNode
  | IfNode
  | LoopNode
  | MethodNode
  | AssignNode;

/** 有数据结果的节点：数据节点 + 变量读取 + 循环索引。流程节点与声明不在其中（需求 §5.1）。 */
export function isValueNode(node: CanvasNode): boolean {
  if (node.kind === 'var-ref' || node.kind === 'loop-index') return true;
  return (CANVAS_DATA_NODE_KINDS as readonly string[]).includes(node.kind);
}

/** 流程节点：没有数据结果，只能出现在 `main` 或某个区域的序列里。 */
export function isFlowNode(node: CanvasNode): node is StartNode | IfNode | LoopNode | MethodNode | AssignNode {
  return (CANVAS_FLOW_NODE_KINDS as readonly string[]).includes(node.kind);
}

/** 声明上的初始化表达式（没有绑定就是 `undefined`）。 */
export function variableBindingInput(binding: VariableBinding): string | undefined {
  return binding.mode === 'none' ? undefined : binding.input;
}

/** 流程节点的子序列（分支两条、循环一条）；叶子节点返回空数组。 */
export function flowChildrenOf(node: CanvasNode): readonly (readonly string[])[] {
  switch (node.kind) {
    case 'if':
      return [node.then, node.else];
    case 'loop':
      return [node.body];
    default:
      return [];
  }
}

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

/** 节点引用的上游**数据**节点 id，按输入顺序；重复引用（同一上游接两个输入）保留重复。 */
export function inputIdsOf(node: CanvasNode): readonly string[] {
  switch (node.kind) {
    case 'value':
    case 'start':
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
    case 'var-decl':
      return node.binding.mode === 'none' ? [] : [node.binding.input];
    case 'var-ref':
    case 'loop-index':
      return [];
    case 'assign':
      return [node.value];
    case 'if':
      return [node.cond];
    case 'loop':
      return [node.count];
    case 'method':
      return Object.values(node.args);
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
