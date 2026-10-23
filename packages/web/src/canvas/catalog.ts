import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import type { CanvasNodeSpec, CanvasPortSpec } from './catalog-types';
import {
  CANVAS_CATEGORY_LABELS,
  CANVAS_SPEC_BASES,
  DEFAULT_CONVERSION,
  VALUE_KIND_OPTIONS,
  defaultEncodedValue,
} from './catalog-specs';
import { acceptsOf, declNodeOf } from './catalog-ports';

/**
 * 节点目录的对外入口（需求 §2.2、§4、§5）。
 *
 * 这里只放**纯数据与纯函数**：没有 DOM、没有坐标、没有求值，所以没有缓存失效问题。
 * 四种调用点各取所需：
 * - 工具箱：`CANVAS_CATALOG` + `CANVAS_CATEGORY_LABELS`，目录顺序就是显示顺序；
 * - 侧栏：`specOf(kind).fields`，`editor` 决定控件，`key` 就是节点属性名（字面值的 `kind`
 *   指 `value.kind`，见 `CanvasFieldSpec`）；
 * - 画布：`createNode` 造默认节点，`portsOf` 画端口，`portValueOf` 问「这个端口现在接着谁」；
 * - 文案：节点名用 `specOf(kind).label`，具体运算名用 `relationLabelOf` / `convertLabelOf`。
 *
 * 三条边界：
 * - **端口名与标签只有一份**：来自 `shared/canvas/document.ts` 的 `inputRefsOf`。目录只补类型
 *   （`acceptsOf`），不重写名字，否则界面与校验器会各接一套端口。
 * - **「未接线」用共享层的 `UNCONNECTED`（空串）**：默认节点的必填输入都填它，校验器报
 *   `unconnected`，这是编辑期的正常状态，不是存档损坏。
 * - **默认值必须能过 `parseCanvasDocument`**（测试锁住）：编辑中的图要能随时保存。
 */

/**
 * 按种类造一个默认节点；`id` 由调用方给（唯一性由界面保证，目录不查重）。
 *
 * 每个默认值都必须能过 `parseCanvasDocument`（见测试）：必填输入用 `UNCONNECTED` 占位，
 * 可选结构（切片的开始/结束/步长、分支的两条区域）一律留空，组合留空行数组。
 */
export function createNode(kind: canvas.CanvasNodeKind, id: string): canvas.CanvasNode {
  switch (kind) {
    case 'value':
      return { id, kind, value: defaultEncodedValue('int') };
    case 'group':
      // 空组合：`rows: []` 与 `rows: [[]]` 都能过 schema，取前者表示「一行都没有」，
      // 免得存档里留一条空行；放入第一个成员时再建第 0 行。成员接上之前校验报 `group_empty`，这是预期。
      return { id, kind, mode: 'list', rows: [] };
    case 'dict':
      return { id, kind, entries: [] };
    case 'relation':
      return { id, kind, op: 'int.add', left: canvas.UNCONNECTED, right: canvas.UNCONNECTED };
    case 'unary':
      return { id, kind, op: 'length', operand: canvas.UNCONNECTED };
    case 'index':
      return { id, kind, target: canvas.UNCONNECTED, index: canvas.UNCONNECTED };
    case 'lookup':
      return { id, kind, target: canvas.UNCONNECTED, key: canvas.UNCONNECTED };
    case 'slice':
      // 三段可选端口省略即默认（需求 §2.3），所以默认节点只有 target 一条引用。
      return { id, kind, target: canvas.UNCONNECTED };
    case 'repeat':
      return { id, kind, target: canvas.UNCONNECTED, count: canvas.UNCONNECTED };
    case 'convert':
      return { id, kind, spec: DEFAULT_CONVERSION, input: canvas.UNCONNECTED };
    case 'var-decl':
      // 名字默认 `a`：schema 要求非空，而目录拿不到已有名字，重名只能由界面在新建时避免。
      return { id, kind, name: 'a', type: 'int', binding: { mode: 'none' } };
    case 'var-ref':
      return { id, kind, decl: canvas.UNCONNECTED };
    case 'loop-index':
      return { id, kind, loop: canvas.UNCONNECTED };
    case 'start':
      return { id, kind };
    case 'if':
      return { id, kind, cond: canvas.UNCONNECTED, then: [], else: [] };
    case 'loop':
      return { id, kind, count: canvas.UNCONNECTED, body: [] };
    case 'method':
      // 还没有题目信息，方法标识先空着（`UNCONNECTED`）：校验器会报「没选方法」。
      return { id, kind, block: canvas.UNCONNECTED, args: {} };
    case 'assign':
      return { id, kind, target: canvas.UNCONNECTED, value: canvas.UNCONNECTED };
  }
}

/**
 * 按题目声明的方法造一个方法节点：参数名取自 `AuthorBlock.params`，每个参数一格端口。
 *
 * 参数值只能先给「未接线」——`args` 存的是**节点 id**，不是字面量，零值字面量得由调用方
 * 另造 value 节点接上（各参数类型的零值见 `methodArgZeroValue`）。参数超过
 * `CANVAS_MAX_METHOD_ARGS` 的声明在 `canvasMethodsOf` 那一层就被过滤，这里不重复截断。
 */
export function createMethodNode(id: string, block: AuthorBlock): canvas.CanvasNode {
  const args: Record<string, string> = {};
  for (const param of block.params) args[param.name] = canvas.UNCONNECTED;
  return { id, kind: 'method', block: block.id, args };
}

/** 方法参数的零值：字节串是空字节串，整数与地址是 0。 */
export function methodArgZeroValue(type: canvas.CanvasMethodParamType): canvas.EncodedScalarValue {
  return type === 'bytes' ? { kind: 'byte', hex: '' } : { kind: 'int', value: '0' };
}

/** 装配静态端口时用的探针 id：只为了让 `inputRefsOf` 有一个实例可问，不进任何文档。 */
const SPEC_PROBE_ID = 'spec';

/**
 * 目录本身：手写的部分（`CANVAS_SPEC_BASES`）加上按默认实例装配出的端口。
 *
 * 端口从 `portsOf(createNode(kind, …))` 来，所以「目录里的端口」与「实例上的端口」不可能对不上：
 * 一个是另一个算出来的。默认实例的端口就是种类级端口——关系是默认运算、转换是默认参数，
 * 组合/字典/方法还没有成员所以是空数组。
 */
export const CANVAS_CATALOG: readonly CanvasNodeSpec[] = CANVAS_SPEC_BASES.map((base) => ({
  ...base,
  ports: portsOf(createNode(base.kind, SPEC_PROBE_ID)),
}));

const SPEC_BY_KIND: ReadonlyMap<canvas.CanvasNodeKind, CanvasNodeSpec> = new Map(
  CANVAS_CATALOG.map((spec): [canvas.CanvasNodeKind, CanvasNodeSpec] => [spec.kind, spec]),
);

/** 按种类取描述。种类来自存档或界面，越界时不猜，直接抛错（调用方拿到的是自己的 bug）。 */
export function specOf(kind: canvas.CanvasNodeKind): CanvasNodeSpec {
  const spec = SPEC_BY_KIND.get(kind);
  if (spec === undefined) throw new Error(`节点目录里没有 ${String(kind)}`);
  return spec;
}

/**
 * 节点实例的数据端口，顺序与 `inputRefsOf(node)` 一致（也就是与 `inputIdsOf(node)` 一致）。
 *
 * 名字、标签、是否必填都取自共享层；这里只补「吃什么类型」。关系/一元/转换按实例的 op 或转换
 * 种类决定类型；`assign` 的右值还牵着目标声明，所以可以额外传文档——给了按声明类型，没给就退化成
 * `'any'`（不传文档的调用照样能画端口，只是变量那两处类型不精确）。
 *
 * 可选端口（切片的起点/终点/步长）**始终列出**、`required: false`：界面要能看见并接上它们，
 * 接没接由 `portValueOf` 回答。
 */
export function portsOf(
  node: canvas.CanvasNode,
  document?: canvas.CanvasDocument,
): readonly CanvasPortSpec[] {
  return canvas.inputRefsOf(node).map((ref) => ({
    name: ref.name,
    label: ref.label,
    accepts: acceptsOf(node, ref.name, document),
    required: ref.required,
  }));
}

/** 某个端口现在接的节点 id；没接线（或端口名不属于这个节点）返回 `undefined`。 */
export function portValueOf(node: canvas.CanvasNode, portName: string): string | undefined {
  const ref = canvas.inputRefsOf(node).find((item) => item.name === portName);
  return ref === undefined ? undefined : ref.id;
}

/** 声明 id → 名字，供端口标签显示「槽位 a」这类文案；不是变量（或悬空）返回 `undefined`。 */
export function declLabelOf(document: canvas.CanvasDocument, declId: string): string | undefined {
  const decl = declNodeOf(canvas.nodeMapOf(document), declId);
  return decl === undefined ? undefined : decl.name;
}

const BINARY_SPEC_BY_OP: ReadonlyMap<string, canvas.BinaryOperatorSpec> = new Map(
  canvas.BINARY_OPERATORS.map((op): [string, canvas.BinaryOperatorSpec] => [op, canvas.binaryOperatorSpec(op)]),
);

/** 关系节点的具体运算名：直接用运算目录里的 `label`，界面不另写一份中文文案。 */
export function relationLabelOf(op: string): string {
  const spec = BINARY_SPEC_BY_OP.get(op);
  return spec === undefined ? `未知运算（${op}）` : spec.label;
}

/** 转换节点的具体转换名：同样直接用转换目录里的 `CONVERSION_LABELS`。 */
export function convertLabelOf(spec: canvas.ConversionSpec): string {
  return canvas.CONVERSION_LABELS[spec.kind];
}

export * from './catalog-types';
export { acceptsOf } from './catalog-ports';
export { CANVAS_CATEGORY_LABELS, DEFAULT_CONVERSION, VALUE_KIND_OPTIONS, defaultEncodedValue };
