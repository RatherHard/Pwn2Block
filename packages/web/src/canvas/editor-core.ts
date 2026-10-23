import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { createMethodNode, portValueOf, portsOf } from './catalog';

/**
 * 新版画布编辑命令的公共底座（阶段三）。
 *
 * 这一层只做**纯函数**的文档改写：不碰 DOM、不读时间、不抛异常。
 * 一次编辑要么给出新文档，要么原样返回旧文档并附一条中文说明（见 `refuse`）。
 * 文档一律按不可变方式重写：调用方拿到的 `document` 永远是新的，输入文档不会被改动，
 * 于是撤销栈只要存文档引用就够了。
 *
 * 三条与产品语义相关的边界：
 *
 * 1. **命令不校验整份文档**：每个命令只回答「这一次操作本身能不能做」，返回的问题也只是
 *    这一条命令自己的问题。全量结构与类型问题归 `validateCanvasDocument`（需求 §7）。
 * 2. **端口即字段**：文档里节点上的引用字段就是画布的输入端口（`relation.left`、
 *    `convert.input`、`if.cond`、`method.args` 的参数名……）。`catalog.portsOf` 回答「有哪些端口」，
 *    这里回答「怎么把它写进节点、怎么写回「未接线」」。
 * 3. **不猜「未接线」的字面值**：清空一个必填端口时，向 `catalog.createNode` 要同一节点的
 *    规范缺省值再写回去，而不是自己编一个空串——空串过不了存档 Schema。
 */

// ---------------------------------------------------------------------------
// 结果类型
// ---------------------------------------------------------------------------

/** 一次编辑的结果：新文档 + 这次编辑本身需要用户知道的问题（不是全量校验结果）。 */
export interface CanvasEdit {
  readonly document: canvas.CanvasDocument;
  readonly issues: readonly canvas.CanvasIssue[];
}

/** 删除的结果：`removed` 是实际删掉的节点（含连带删除的下游与包络），供界面提示。 */
export interface CanvasRemoval {
  readonly document: canvas.CanvasDocument;
  readonly removed: readonly string[];
}

/** 编辑成功；`issues` 只放「做了但要让用户知道」的提醒。 */
export function edited(document: canvas.CanvasDocument, issues: readonly canvas.CanvasIssue[] = []): CanvasEdit {
  return { document, issues };
}

/** 拒绝一次编辑：文档原样返回，只带这一条问题，界面上节点不跳、坐标不动。 */
export function refuse(
  document: canvas.CanvasDocument,
  code: canvas.CanvasIssueCode,
  nodeId: string,
  message: string,
): CanvasEdit {
  return { document, issues: [canvas.errorIssue(code, nodeId, message)] };
}

// ---------------------------------------------------------------------------
// 文档查询与局部替换
// ---------------------------------------------------------------------------

export function nodeOf(document: canvas.CanvasDocument, id: string): canvas.CanvasNode | undefined {
  return canvas.nodeMapOf(document).get(id);
}

export function hasNode(document: canvas.CanvasDocument, id: string): boolean {
  return nodeOf(document, id) !== undefined;
}

/** 节点 id 形状：与存档 Schema 同一口径，坏 id 连存都存不下去，所以命令层先挡住。 */
export function isValidNodeId(id: string): boolean {
  return canvas.CANVAS_NODE_ID_RE.test(id);
}

export function replaceNode(document: canvas.CanvasDocument, next: canvas.CanvasNode): canvas.CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === next.id ? next : node)),
  };
}

export function withNodes(
  document: canvas.CanvasDocument,
  nodes: readonly canvas.CanvasNode[],
): canvas.CanvasDocument {
  return { ...document, nodes };
}

/** 写坐标：只影响显示，不进语义（需求 §2.2）。坐标按 `{x, y}` 复制，不把调用方的额外字段带进存档。 */
export function withLayout(
  document: canvas.CanvasDocument,
  entries: readonly (canvas.CanvasNodeLayout & { readonly id: string })[],
): canvas.CanvasDocument {
  if (entries.length === 0) return document;
  const layout: Record<string, canvas.CanvasNodeLayout> = { ...document.layout };
  for (const entry of entries) layout[entry.id] = { x: entry.x, y: entry.y };
  return { ...document, layout };
}

export function withoutLayout(document: canvas.CanvasDocument, ids: ReadonlySet<string>): canvas.CanvasDocument {
  const kept = Object.entries(document.layout).filter(([id]) => !ids.has(id));
  if (kept.length === Object.keys(document.layout).length) return document;
  return { ...document, layout: Object.fromEntries(kept) };
}

// ---------------------------------------------------------------------------
// 序列（`main` 与各区域）
// ---------------------------------------------------------------------------

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** 改写每个容器自己的区域序列；没变的容器保持原引用，避免整棵树被无谓复制。 */
export function withSequences(
  nodes: readonly canvas.CanvasNode[],
  map: (ids: readonly string[]) => readonly string[],
): readonly canvas.CanvasNode[] {
  return nodes.map((node) => {
    if (node.kind === 'if') {
      const then = map(node.then);
      const otherwise = map(node.else);
      if (sameIds(then, node.then) && sameIds(otherwise, node.else)) return node;
      return { ...node, then, else: otherwise };
    }
    if (node.kind === 'loop') {
      const body = map(node.body);
      return sameIds(body, node.body) ? node : { ...node, body };
    }
    return node;
  });
}

/** 从 `main` 与所有区域序列里抹掉这些 id：删节点以后不能留悬空序列项。 */
export function stripSequences(
  document: canvas.CanvasDocument,
  removed: ReadonlySet<string>,
): canvas.CanvasDocument {
  const strip = (ids: readonly string[]): readonly string[] => ids.filter((id) => !removed.has(id));
  return {
    ...document,
    main: strip(document.main),
    nodes: withSequences(document.nodes, strip),
  };
}

/**
 * 节点**引用**的上游 id：数据输入之外，还包括三处不是「值输入」的引用
 * （变量引用的声明、循环索引指向的循环、流程赋值的写入目标），
 * 这样删除时不会留下指向已删节点的悬空 id。未接线（`UNCONNECTED`）不算引用。
 */
export function referenceIdsOf(node: canvas.CanvasNode): readonly string[] {
  return ownReferencesOf(node).filter((id) => id !== canvas.UNCONNECTED);
}

function ownReferencesOf(node: canvas.CanvasNode): readonly string[] {
  switch (node.kind) {
    case 'var-ref':
      return [node.decl];
    case 'loop-index':
      return [node.loop];
    case 'assign':
      return [node.target, node.value];
    default:
      return canvas.inputIdsOf(node);
  }
}

/** 组合成员里被删掉的部分：删成员不删整个组合，只收缩行列（空行一并移除）。 */
export function shrinkGroups(
  nodes: readonly canvas.CanvasNode[],
  removed: ReadonlySet<string>,
): readonly canvas.CanvasNode[] {
  return nodes.map((node) => {
    if (node.kind !== 'group') return node;
    const rows = node.rows
      .map((row) => row.filter((member) => !removed.has(member)))
      .filter((row) => row.length > 0);
    const unchanged =
      rows.length === node.rows.length && rows.every((row, index) => sameIds(row, node.rows[index]));
    return unchanged ? node : { ...node, rows };
  });
}

/**
 * 拆掉一个组合（结构容器）：成员留在文档里、只是不再有归属；组合自己的坐标一并删掉，
 * 外层包络如果因为这一拆变空也一起拆。
 *
 * 与 `removeNodes` 的区别是**不连带删引用者**：解除包络是结构操作，引用它的节点是否悬空
 * 交给校验器说，不在这里静默删掉用户另外几个节点。
 */
export function dropGroup(
  document: canvas.CanvasDocument,
  groupId: string,
): { readonly document: canvas.CanvasDocument; readonly removed: readonly string[] } {
  const gone = new Set([groupId]);
  for (const parentId of canvas.ownersOf(document, groupId)) {
    const parent = nodeOf(document, parentId);
    if (parent === undefined || parent.kind !== 'group') continue;
    if (canvas.groupMembers(parent).every((member) => gone.has(member))) gone.add(parentId);
  }
  const nodes = shrinkGroups(document.nodes.filter((node) => !gone.has(node.id)), gone);
  const stripped = stripSequences({ ...document, nodes }, gone);
  return { document: withoutLayout(stripped, gone), removed: [...gone] };
}

// ---------------------------------------------------------------------------
// 标识符
// ---------------------------------------------------------------------------

/** 找一个没被占用的新 id：`prefix` 里的非法字符先清掉，再拼数字。 */
export function newNodeId(document: canvas.CanvasDocument, prefix = 'node'): string {
  const used = new Set(document.nodes.map((node) => node.id));
  const base = prefix.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48) || 'node';
  for (let index = 1; ; index += 1) {
    const candidate = `${base}${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// 目录判定（把字符串收窄成封闭联合）
// ---------------------------------------------------------------------------

export function isBinaryOperator(op: string): op is canvas.BinaryOperator {
  return canvas.BINARY_OPERATORS.some((known) => known === op);
}

export function isUnaryOperator(op: string): op is canvas.UnaryOperator {
  return canvas.UNARY_OPERATORS.some((known) => known === op);
}

export function isGroupMode(mode: string): mode is canvas.GroupMode {
  return canvas.GROUP_MODES.some((known) => known === mode);
}

export function isConversionKind(kind: string): kind is canvas.ConversionKind {
  return Object.hasOwn(canvas.CONVERSION_LABELS, kind);
}

// ---------------------------------------------------------------------------
// 端口读写（catalog 是唯一的目录事实来源，这里只补「写」）
// ---------------------------------------------------------------------------

export { createNode, portValueOf, portsOf } from './catalog';

/**
 * 把一条接线写进节点：认得的端口返回新节点，认不得的返回 `undefined`
 * （组合行列、字典条目这类结构端口不靠 `connect` 写）。
 */
export function withPortValue(
  node: canvas.CanvasNode,
  portName: string,
  value: string,
): canvas.CanvasNode | undefined {
  switch (node.kind) {
    case 'relation':
      if (portName === 'left') return { ...node, left: value };
      if (portName === 'right') return { ...node, right: value };
      return undefined;
    case 'unary':
      return portName === 'operand' ? { ...node, operand: value } : undefined;
    case 'index':
      if (portName === 'target') return { ...node, target: value };
      if (portName === 'index') return { ...node, index: value };
      return undefined;
    case 'lookup':
      if (portName === 'target') return { ...node, target: value };
      if (portName === 'key') return { ...node, key: value };
      return undefined;
    case 'slice':
      if (portName === 'target') return { ...node, target: value };
      if (portName === 'start') return { ...node, start: value };
      if (portName === 'end') return { ...node, end: value };
      if (portName === 'step') return { ...node, step: value };
      return undefined;
    case 'repeat':
      if (portName === 'target') return { ...node, target: value };
      if (portName === 'count') return { ...node, count: value };
      return undefined;
    case 'convert':
      return portName === 'input' ? { ...node, input: value } : undefined;
    case 'if':
      return portName === 'cond' ? { ...node, cond: value } : undefined;
    case 'loop':
      return portName === 'count' ? { ...node, count: value } : undefined;
    case 'assign':
      return portName === 'value' ? { ...node, value } : undefined;
    case 'method':
      return { ...node, args: { ...node.args, [portName]: value } };
    default:
      return undefined;
  }
}

/**
 * 断开一条接线。
 *
 * 必填端口写回 `UNCONNECTED`（`''`）而不是删字段：文档形状要求引用字段始终存在，
 * 「还没接线」是一等状态，由 `validateCanvasDocument` 报 `unconnected`（需求 §7）。
 * 可选端口（切片的三段）直接删字段，它们本来就可以缺省。
 */
export function clearPort(node: canvas.CanvasNode, portName: string): canvas.CanvasNode | undefined {
  const port = portsOf(node).find((candidate) => candidate.name === portName);
  if (port === undefined) return undefined;
  if (!port.required) return withoutOptionalPort(node, portName);
  return withPortValue(node, portName, canvas.UNCONNECTED);
}

function withoutOptionalPort(node: canvas.CanvasNode, portName: string): canvas.CanvasNode | undefined {
  if (node.kind !== 'slice') return undefined;
  if (portName !== 'start' && portName !== 'end' && portName !== 'step') return undefined;
  if (node[portName] === undefined) return node;
  const next: canvas.SliceNode = { ...node };
  delete next[portName];
  return next;
}

/**
 * 按题目声明重建方法节点：参数键严格等于声明的参数表，没接线的参数填 `UNCONNECTED`，
 * 名字仍然对得上的旧接线保留下来（需求 §5.4、§6.3「换方法不丢已接的参数」）。
 */
export function methodNodeOf(
  id: string,
  block: AuthorBlock,
  previous?: canvas.CanvasNode,
): canvas.CanvasNode {
  const fresh = createMethodNode(id, block);
  if (fresh.kind !== 'method') return fresh;
  const args: Record<string, string> = {};
  for (const param of block.params) {
    const wired = previous === undefined ? undefined : portValueOf(previous, param.name);
    args[param.name] = wired ?? canvas.UNCONNECTED;
  }
  return { ...fresh, args };
}
