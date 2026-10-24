import { CANVAS_MAX_COLLECTION_ITEMS, CANVAS_MAX_VARIABLES, CANVAS_MAX_VAR_NAME_CHARS, canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import {
  createNode,
  edited,
  hasNode,
  isBinaryOperator,
  isConversionKind,
  isGroupMode,
  isUnaryOperator,
  isValidNodeId,
  methodNodeOf,
  nodeOf,
  refuse,
  replaceNode,
  withLayout,
  withNodes,
  type CanvasEdit,
} from './editor-core';

/**
 * 节点、内容与变量上的编辑命令（阶段三）。
 *
 * 这些命令都只回答「这一次改能不能做」：
 * - 节点种类不对、id 重复、名字不合法就原样返回并附一条问题，界面不会被改坏；
 * - 改运算 / 改转换 / 换方法以后**保留能按名字对上的接线**（`carryPorts`），
 *   对不上的端口自然丢掉，绝不留下张冠李戴的引用（需求 §2.3、§4.2）；
 * - 命令本身不跑全量校验，`validateCanvasDocument` 仍然是结构与类型的唯一裁判（需求 §7）。
 */

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/** 新增一个目录里的节点：形状由 `catalog.createNode` 给，坐标由这里写。 */
export function addNode(
  document: canvas.CanvasDocument,
  kind: canvas.CanvasNodeKind,
  id: string,
  at: canvas.CanvasNodeLayout,
): CanvasEdit {
  return addExistingNode(document, createNode(kind, id), at);
}

/** 把已有节点（例如从剪贴板或导入来的）放进文档；id 冲突一律拒绝，不覆盖别人的节点。 */
export function addExistingNode(
  document: canvas.CanvasDocument,
  node: canvas.CanvasNode,
  at: canvas.CanvasNodeLayout,
): CanvasEdit {
  if (!isValidNodeId(node.id)) {
    return refuse(document, 'invalid_id', node.id, `节点 id「${node.id}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, node.id)) {
    return refuse(document, 'duplicate_id', node.id, `节点 id「${node.id}」已经存在，不能重复添加`);
  }
  return edited(withLayout(withNodes(document, [...document.nodes, node]), [{ id: node.id, x: at.x, y: at.y }]));
}

/** 写字面值：先按存档口径解码一次，坏了就报 `invalid_value`，不让坏值进文档。 */
export function setValue(
  document: canvas.CanvasDocument,
  nodeId: string,
  value: canvas.EncodedScalarValue,
): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'value') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不承载字面值`);
  }
  const decoded = canvas.decodeScalarValue(value);
  if (!decoded.ok) return refuse(document, 'invalid_value', nodeId, decoded.message);
  return edited(replaceNode(document, { ...node, value }));
}

/** 切换关系方框的运算：`left` / `right` 两个端口名不变，接线按原样保留。 */
export function setRelationOp(document: canvas.CanvasDocument, nodeId: string, op: string): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'relation') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是关系方框`);
  }
  if (!isBinaryOperator(op)) return refuse(document, 'unknown_kind', nodeId, `未知的二元运算「${op}」`);
  return edited(replaceNode(document, { ...node, op }));
}

/** 切换附属操作（取反 / 长度）：`operand` 端口名不变，接线保留。 */
export function setUnaryOp(document: canvas.CanvasDocument, nodeId: string, op: string): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'unary') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是附属操作`);
  }
  if (!isUnaryOperator(op)) return refuse(document, 'unknown_kind', nodeId, `未知的一元运算「${op}」`);
  return edited(replaceNode(document, { ...node, op }));
}

/** 切换转换包的转换种类：参数整体替换，`input` 端口的接线保留（类型对不对由校验器说）。 */
export function setConversion(
  document: canvas.CanvasDocument,
  nodeId: string,
  spec: canvas.ConversionSpec,
): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'convert') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是转换`);
  }
  if (!isConversionKind(spec.kind)) return refuse(document, 'unknown_kind', nodeId, `未知的转换种类「${String(spec.kind)}」`);
  return edited(replaceNode(document, { ...node, spec }));
}

/**
 * 重写字典条目：键的编码、重复键与值节点是否存在都在这里挡一次。
 *
 * 条目值引用的是**别的节点 id**，所以悬空的值直接拒绝——字典不像输入端口那样有「未接线」状态。
 */
export function setDictEntries(
  document: canvas.CanvasDocument,
  nodeId: string,
  entries: readonly { readonly key: canvas.EncodedDictKey; readonly value: string }[],
): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'dict') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是字典`);
  }
  if (entries.length > CANVAS_MAX_COLLECTION_ITEMS) {
    return refuse(document, 'limit_exceeded', nodeId, `字典最多 ${CANVAS_MAX_COLLECTION_ITEMS} 条，收到 ${entries.length} 条`);
  }
  const issues: canvas.CanvasIssue[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const decoded = canvas.decodeKey(entry.key);
    if (!decoded.ok) {
      issues.push(canvas.errorIssue('invalid_value', nodeId, decoded.message));
      continue;
    }
    const identity = canvas.keyIdentity(decoded.value);
    if (seen.has(identity)) {
      issues.push(
        canvas.errorIssue('dict_duplicate_key', nodeId, `字典键 ${canvas.keyLabel(decoded.value)} 重复，必须唯一`),
      );
    }
    seen.add(identity);
    if (!hasNode(document, entry.value)) {
      issues.push(
        canvas.errorIssue(
          'unknown_node',
          nodeId,
          `字典项 ${canvas.keyLabel(decoded.value)} 引用的节点「${entry.value}」不存在`,
        ),
      );
    }
  }
  if (issues.length > 0) return { document, issues };
  return edited(replaceNode(document, { ...node, entries }));
}

/** 切换组合模式：只改模式，成员与行列不动（需求 §2.2）。 */
export function setGroupMode(document: canvas.CanvasDocument, nodeId: string, mode: canvas.GroupMode): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'group') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是组合`);
  }
  if (!isGroupMode(mode)) return refuse(document, 'unknown_kind', nodeId, `未知的组合模式「${String(mode)}」`);
  return edited(replaceNode(document, { ...node, mode }));
}

/** 换方法：方法标识与参数来自题目声明；参数名对得上的接线保留，对不上的丢掉。 */
export function setMethodBlock(document: canvas.CanvasDocument, nodeId: string, block: AuthorBlock): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'method') {
    return refuse(document, 'unknown_kind', nodeId, `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是方法`);
  }
  return edited(replaceNode(document, methodNodeOf(nodeId, block, node)));
}

// ---------------------------------------------------------------------------
// 变量（需求 §3）
// ---------------------------------------------------------------------------

/** 变量名规则：去空白后判空、判长、判重；`exceptId` 是重命名时允许「和自己同名」的那一条。 */
function variableNameIssue(
  document: canvas.CanvasDocument,
  nodeId: string,
  name: string,
  exceptId: string | undefined,
): canvas.CanvasIssue | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return canvas.errorIssue('variable_error', nodeId, '变量名不能为空');
  if (trimmed.length > CANVAS_MAX_VAR_NAME_CHARS) {
    return canvas.errorIssue(
      'variable_error',
      nodeId,
      `变量名「${trimmed}」有 ${trimmed.length} 个字符，超过上限 ${CANVAS_MAX_VAR_NAME_CHARS}`,
    );
  }
  const existing = canvas.variableTableOf(document).byName.get(trimmed);
  if (existing !== undefined && existing.id !== exceptId) {
    return canvas.errorIssue(
      'variable_error',
      nodeId,
      `变量名「${trimmed}」已经被声明「${existing.id}」使用，变量名必须唯一`,
    );
  }
  return undefined;
}

/** 新建变量声明：类型固定、名字唯一，初始状态是「未初始化」（需求 §3.1）。 */
export function createVariable(
  document: canvas.CanvasDocument,
  id: string,
  name: string,
  type: canvas.ValueKind,
): CanvasEdit {
  if (!isValidNodeId(id)) {
    return refuse(document, 'invalid_id', id, `节点 id「${id}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, id)) return refuse(document, 'duplicate_id', id, `节点 id「${id}」已经存在`);
  const nameIssue = variableNameIssue(document, id, name, undefined);
  if (nameIssue !== undefined) return { document, issues: [nameIssue] };
  const count = canvas.variableTableOf(document).declarations.length;
  if (count >= CANVAS_MAX_VARIABLES) {
    return refuse(document, 'variable_error', id, `变量声明数已达上限 ${CANVAS_MAX_VARIABLES}，先删掉不用的变量`);
  }
  const node: canvas.VarDeclNode = { kind: 'var-decl', id, name: name.trim(), type, binding: { mode: 'none' } };
  return edited(withNodes(document, [...document.nodes, node]));
}

/** 重命名：改的是唯一那一声明，引用视图跟着同步（需求 §3.1「重命名同步」）。 */
export function renameVariable(document: canvas.CanvasDocument, declId: string, name: string): CanvasEdit {
  const node = nodeOf(document, declId);
  if (node === undefined) return refuse(document, 'unknown_node', declId, `节点「${declId}」不存在`);
  if (node.kind !== 'var-decl') {
    return refuse(document, 'unknown_kind', declId, `节点「${declId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是变量声明`);
  }
  const nameIssue = variableNameIssue(document, declId, name, declId);
  if (nameIssue !== undefined) return { document, issues: [nameIssue] };
  return edited(replaceNode(document, { ...node, name: name.trim() }));
}

/** 设置初始化关系：允许 `{mode:'none'}` 解绑；绑定表达式必须指向已存在的节点。 */
export function setBinding(
  document: canvas.CanvasDocument,
  declId: string,
  binding: canvas.VariableBinding,
): CanvasEdit {
  const node = nodeOf(document, declId);
  if (node === undefined) return refuse(document, 'unknown_node', declId, `节点「${declId}」不存在`);
  if (node.kind !== 'var-decl') {
    return refuse(document, 'unknown_kind', declId, `节点「${declId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是变量声明`);
  }
  if (binding.mode !== 'none' && !hasNode(document, binding.input)) {
    return refuse(document, 'unknown_node', declId, `绑定表达式引用的节点「${binding.input}」不存在`);
  }
  return edited(replaceNode(document, { ...node, binding }));
}

/**
 * 设置流程赋值的写入目标。
 *
 * `target` 指变量声明而不是数据节点（`assign` 的数据输入是 `value`），所以它不属于接线命令；
 * 允许写空串表示「还没选变量」，这时校验器会报 `unconnected`。
 */
export function setAssignTarget(
  document: canvas.CanvasDocument,
  nodeId: string,
  declId: string,
): CanvasEdit {
  const node = nodeOf(document, nodeId);
  if (node === undefined) return refuse(document, 'unknown_node', nodeId, `节点「${nodeId}」不存在`);
  if (node.kind !== 'assign') {
    return refuse(
      document,
      'unknown_kind',
      nodeId,
      `节点「${nodeId}」是「${canvas.CANVAS_NODE_KIND_LABELS[node.kind]}」，不是流程赋值`,
    );
  }
  if (declId !== canvas.UNCONNECTED) {
    const decl = nodeOf(document, declId);
    if (decl === undefined) return refuse(document, 'unknown_node', declId, `节点「${declId}」不存在`);
    if (decl.kind !== 'var-decl') {
      return refuse(document, 'variable_error', declId, `「${declId}」不是变量声明，赋值只能写进声明`);
    }
  }
  return edited(replaceNode(document, { ...node, target: declId }));
}

/** 生成一个指向声明的新引用视图：同一变量可以摆很多处，身份仍然是那一份声明。 */
export function createReference(
  document: canvas.CanvasDocument,
  declId: string,
  id: string,
  at: canvas.CanvasNodeLayout,
): CanvasEdit {
  const decl = nodeOf(document, declId);
  if (decl === undefined) return refuse(document, 'unknown_node', declId, `节点「${declId}」不存在`);
  if (decl.kind !== 'var-decl') {
    return refuse(document, 'variable_error', declId, `「${declId}」不是变量声明，引用只能指向声明`);
  }
  if (!isValidNodeId(id)) {
    return refuse(document, 'invalid_id', id, `节点 id「${id}」只能是字母、数字、下划线和连字符`);
  }
  if (hasNode(document, id)) return refuse(document, 'duplicate_id', id, `节点 id「${id}」已经存在`);
  const node: canvas.VarRefNode = { kind: 'var-ref', id, decl: declId };
  return edited(withLayout(withNodes(document, [...document.nodes, node]), [{ id, x: at.x, y: at.y }]));
}

// ---------------------------------------------------------------------------
// 对外出口
// ---------------------------------------------------------------------------

export * from './editor-core';
export * from './editor-graph';
export * from './editor-containers';
export * from './editor-convert';
export * from './editor-regions';
export * from './editor-flow-move';
