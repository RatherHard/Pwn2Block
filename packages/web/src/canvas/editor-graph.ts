import { canvas } from '@pwn2block/shared';
import {
  clearPort,
  edited,
  nodeOf,
  portValueOf,
  portsOf,
  referenceIdsOf,
  refuse,
  replaceNode,
  shrinkGroups,
  stripSequences,
  withPortValue,
  withoutLayout,
  type CanvasEdit,
  type CanvasRemoval,
} from './editor-core';

/**
 * 接线、删除与坐标上的编辑命令（阶段三）。
 *
 * 三件事各自有一条硬边界：
 *
 * - **接线只写能写的**：目标端口必须存在、来源必须有数据结果、不能成环、静态类型要对得上；
 *   一条线接一个端口，端口已被占用就是**替换**（与旧面板一致），不另报问题。
 * - **删除是连带删除**：删指定节点 → 删引用它的节点 → 区域成员跟着容器走 →
 *   包络因为成员被删而变空就一起删，最后从 `main` 与所有区域序列里抹掉、删掉 `layout`。
 *   返回的 `removed` 按实际删除顺序排列，界面可以直接拿去提示。
 * - **移动只改坐标**：`moveLayout` 不碰任何引用与值（需求 §2.2「普通移动不改值」）。
 */

// ---------------------------------------------------------------------------
// 接线
// ---------------------------------------------------------------------------

/**
 * 接一条线。
 *
 * 检查顺序就是报错优先级：目标不存在 → 来源不存在 → 端口不存在 → 来源不是数据节点 →
 * 成环（`input_cycle`）→ 类型不匹配（`type_mismatch`）。全部通过才写，
 * 端口已有线时直接替换——一个端口只接一条线。
 */
export function connect(
  document: canvas.CanvasDocument,
  targetId: string,
  portName: string,
  sourceId: string,
): CanvasEdit {
  const target = nodeOf(document, targetId);
  if (target === undefined) return refuse(document, 'unknown_node', targetId, `端口所属的节点「${targetId}」不存在`);
  const source = nodeOf(document, sourceId);
  if (source === undefined) return refuse(document, 'unknown_node', sourceId, `接线来源的节点「${sourceId}」不存在`);
  const port = portsOf(target).find((candidate) => candidate.name === portName);
  if (port === undefined) return refuse(document, 'unknown_node', targetId, `节点「${targetId}」没有端口「${portName}」`);
  if (!canvas.isValueNode(source)) {
    return refuse(
      document,
      'type_mismatch',
      targetId,
      `「${sourceId}」是「${canvas.CANVAS_NODE_KIND_LABELS[source.kind]}」，没有数据结果，不能接到输入端口`,
    );
  }
  if (reaches(document, sourceId, targetId)) {
    return refuse(document, 'input_cycle', targetId, `「${sourceId}」已经直接或间接用到「${targetId}」，再接上会成环`);
  }
  const sourceType = canvas.staticTypeOf(document, sourceId);
  if (!acceptsType(port, sourceType)) {
    return refuse(
      document,
      'type_mismatch',
      targetId,
      `端口「${portName}」不接受${typeLabel(sourceType)}（来自「${sourceId}」）`,
    );
  }
  const next = withPortValue(target, portName, sourceId);
  if (next === undefined) return structuralPort(document, targetId, portName);
  return edited(replaceNode(document, next));
}

/** 断开一个端口上的线；端口本来就没接线时返回原文档，不报问题。 */
export function disconnect(
  document: canvas.CanvasDocument,
  targetId: string,
  portName: string,
): CanvasEdit {
  const target = nodeOf(document, targetId);
  if (target === undefined) return refuse(document, 'unknown_node', targetId, `端口所属的节点「${targetId}」不存在`);
  if (!portsOf(target).some((port) => port.name === portName)) {
    return refuse(document, 'unknown_node', targetId, `节点「${targetId}」没有端口「${portName}」`);
  }
  const current = portValueOf(target, portName);
  if (current === undefined || current === canvas.UNCONNECTED) return edited(document);
  const cleared = clearPort(target, portName);
  if (cleared === undefined) return structuralPort(document, targetId, portName);
  return edited(replaceNode(document, cleared));
}

/**
 * 端口存在，但不是接线命令该写的那种：组合行列、字典条目、变量绑定都由各自的命令维护。
 * 与「端口不存在」（`unknown_node`）分开报，界面才能给出「请用结构命令改」的提示。
 */
function structuralPort(
  document: canvas.CanvasDocument,
  targetId: string,
  portName: string,
): CanvasEdit {
  return refuse(
    document,
    'unknown_node',
    targetId,
    `端口「${portName}」属于结构编辑（组合行列 / 字典条目 / 变量绑定），请用对应的命令改，接线命令只写数据输入`,
  );
}

/** 从 `sourceId` 沿数据引用向上走，能不能碰到 `targetId`（碰到就是环）。 */
function reaches(document: canvas.CanvasDocument, sourceId: string, targetId: string): boolean {
  const nodes = canvas.nodeMapOf(document);
  const seen = new Set<string>();
  const stack: string[] = [sourceId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    if (id === targetId) return true;
    seen.add(id);
    const node = nodes.get(id);
    if (node === undefined) continue;
    for (const upstream of canvas.inputIdsOf(node)) stack.push(upstream);
  }
  return false;
}

/**
 * 端口接受不接受这个静态类型。
 *
 * `accepts` 的形状由 catalog 决定（单个 `'any'` 或一张种类表），这里按运行时归一化读，
 * 不把「目录字段长什么样」写死进命令层。类型推不出来（`undefined`）或元素级未知（`'any'`）
 * 一律放行：编辑期只拦「必然是错的」，剩下的交给求值与求值前的静态校验。
 */
function acceptsType(port: { readonly accepts: unknown } | undefined, sourceType: canvas.StaticType | undefined): boolean {
  if (port === undefined) return false;
  const accepts = normalizeAccepts(port.accepts);
  if (accepts === 'any') return true;
  if (sourceType === undefined || sourceType === 'any') return true;
  return accepts.includes(sourceType) || accepts.includes('any');
}

function normalizeAccepts(accepts: unknown): readonly string[] | 'any' {
  if (accepts === 'any') return 'any';
  if (!Array.isArray(accepts)) return 'any';
  return accepts.filter((item): item is string => typeof item === 'string');
}

function typeLabel(type: canvas.StaticType | undefined): string {
  return type === undefined || type === 'any' ? '类型未知的值' : canvas.VALUE_KIND_LABELS[type];
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/**
 * 删节点（连带删除）。
 *
 * 顺序上刻意如此：先按调用方给的顺序删，再补「引用已删节点」的节点，再补区域成员
 * （容器被删了，里面的语句失去位置），最后补「因为成员被删而变空」的包络；
 * 每一轮都可能带出新的引用者，所以循环到稳定为止。组合只收缩不删，除非真的空了。
 */
export function removeNodes(document: canvas.CanvasDocument, ids: readonly string[]): CanvasRemoval {
  const removed = cascadeRemoval(document, ids);
  if (removed.length === 0) return { document, removed: [] };

  const gone = new Set(removed);
  const surviving = document.nodes.filter((node) => !gone.has(node.id));
  const shrunk = shrinkGroups(surviving, gone);
  const stripped = stripSequences({ ...document, nodes: shrunk }, gone);
  return { document: withoutLayout(stripped, gone), removed };
}

/** 实际删除顺序：调用方点名的 → 引用者 → 区域成员 → 变空的包络，按发现顺序累加。 */
function cascadeRemoval(document: canvas.CanvasDocument, ids: readonly string[]): readonly string[] {
  const nodes = canvas.nodeMapOf(document);
  const gone = new Set<string>();
  const order: string[] = [];
  const remove = (id: string): boolean => {
    if (gone.has(id) || !nodes.has(id)) return false;
    gone.add(id);
    order.push(id);
    return true;
  };

  for (const id of ids) remove(id);
  let changed = gone.size > 0;
  while (changed) {
    const children = removeRegionMembers(nodes, gone, remove);
    const referrers = removeReferrers(document, gone, remove);
    const emptied = removeEmptiedGroups(document, gone, remove);
    changed = children || referrers || emptied;
  }
  return order;
}

/** 容器被删 → 它两条（或一条）区域里的语句一起删，否则它们会变成悬空的孤儿流程节点。 */
function removeRegionMembers(
  nodes: ReadonlyMap<string, canvas.CanvasNode>,
  gone: ReadonlySet<string>,
  remove: (id: string) => boolean,
): boolean {
  let changed = false;
  for (const id of [...gone]) {
    const node = nodes.get(id);
    if (node === undefined) continue;
    for (const sequence of canvas.flowChildrenOf(node)) {
      for (const child of sequence) {
        if (remove(child)) changed = true;
      }
    }
  }
  return changed;
}

/** 引用了已删节点的节点一起删（组合除外：组合只收缩，变空由下一轮处理）。 */
function removeReferrers(
  document: canvas.CanvasDocument,
  gone: ReadonlySet<string>,
  remove: (id: string) => boolean,
): boolean {
  let changed = false;
  for (const node of document.nodes) {
    if (gone.has(node.id) || node.kind === 'group') continue;
    if (referenceIdsOf(node).some((id) => gone.has(id)) && remove(node.id)) changed = true;
  }
  return changed;
}

/** 成员被删光的包络一起删；原本就是空组合的（不是这次删空的）不归这条命令管。 */
function removeEmptiedGroups(
  document: canvas.CanvasDocument,
  gone: ReadonlySet<string>,
  remove: (id: string) => boolean,
): boolean {
  let changed = false;
  for (const node of document.nodes) {
    if (node.kind !== 'group' || gone.has(node.id)) continue;
    const members = canvas.groupMembers(node);
    if (members.length === 0 || !members.every((member) => gone.has(member))) continue;
    if (remove(node.id)) changed = true;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 坐标
// ---------------------------------------------------------------------------

/** 移动节点：只改坐标，不改值、不改接线、不进语义版本（需求 §2.2）。不存在的 id 直接忽略。 */
export function moveLayout(
  document: canvas.CanvasDocument,
  moves: readonly (canvas.CanvasNodeLayout & { readonly id: string })[],
): canvas.CanvasDocument {
  const nodes = canvas.nodeMapOf(document);
  const known = moves.filter((move) => nodes.has(move.id));
  if (known.length === 0) return document;
  const layout: Record<string, canvas.CanvasNodeLayout> = { ...document.layout };
  for (const move of known) layout[move.id] = { x: move.x, y: move.y };
  return { ...document, layout };
}
