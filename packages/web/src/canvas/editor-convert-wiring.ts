import { canvas } from '@pwn2block/shared';
import { clearPort, withPortValue } from './editor-core';

/**
 * 引用改接与断开（转换包络的接线那一半，需求 §4.1）。
 *
 * 「包络为转换」要把原来接整体结果的连接改接到新转换上，「解除转换」要把它们接回去；
 * 两件事是同一个操作的正反两面，所以只有一条实现：**一次遍历**把所有指向某个 id 的数据输入
 * 改接走（或断开），节点表按原顺序扫一遍，每个节点内部再按端口顺序收拢。
 *
 * 三条边界：
 * 1. **组合的成员不是引用**：`group.rows` 是结构归属，不是取值的输入，所以整类跳过——
 *    「解除转换后内部结构原样保留」靠的就是这一条。
 * 2. **认所有数据输入形状**：方法参数、赋值右值、关系 / 附属操作 / 下标 / 按键 / 切片 / 重复 /
 *    转换 / 条件 / 循环走 `inputRefsOf` + `withPortValue`；字典条目与变量绑定的输入不是普通端口，
 *    各自单独重写——漏一种就会留下一条还读着旧节点的线。
 * 3. **断开也要合法**：必填端口写回 `UNCONNECTED`，可选端口整条删掉，变量绑定退回未初始化
 *    （存档里没有「空的绑定输入」这种形状）。
 */

/** 转换节点的输入端口名（`ConvertNode.input`）：变量绑定用同一个端口名表示来源表达式。 */
const CONVERT_INPUT = 'input';

/** 把一个节点的某个端口改指向 `toId`；端口名认不得时返回 `undefined`（调用方保留原节点）。 */
function rewiredPort(node: canvas.CanvasNode, portName: string, toId: string): canvas.CanvasNode | undefined {
  if (node.kind === 'var-decl' && portName === CONVERT_INPUT) return withBindingInput(node, toId);
  if (node.kind === 'dict') return withDictEntry(node, portName, toId);
  return withPortValue(node, portName, toId);
}

/** 变量绑定的输入不是普通端口（`setBinding` 才写它），所以单独重写；没绑定时原样返回。 */
function withBindingInput(node: canvas.VarDeclNode, input: string): canvas.VarDeclNode {
  const binding = node.binding;
  if (binding.mode === 'initial') return { ...node, binding: { mode: 'initial', input } };
  if (binding.mode === 'derived') return { ...node, binding: { mode: 'derived', input } };
  return node;
}

/**
 * 断开一个端口：必填端口写回 `UNCONNECTED`，可选端口（切片的起点/终点/步长）整条删掉；
 * 变量绑定没有「空输入」这种存档形状，所以退回未初始化（`binding.mode = 'none'`）。
 */
function disconnectedPort(node: canvas.CanvasNode, portName: string): canvas.CanvasNode | undefined {
  if (node.kind === 'var-decl' && portName === CONVERT_INPUT) {
    return node.binding.mode === 'none' ? node : { ...node, binding: { mode: 'none' } };
  }
  if (node.kind === 'dict') return withDictEntry(node, portName, undefined);
  return clearPort(node, portName);
}

/**
 * 字典条目的值：`withPortValue` 不写结构端口（条目由 `setDictEntries` 维护），
 * 而这里的改接也绕不开它——不处理的话「字典还读着旧节点」会成一条漏改的引用。
 */
function withDictEntry(
  node: canvas.DictNode,
  portName: string,
  toId: string | undefined,
): canvas.CanvasNode | undefined {
  const index = canvas.inputRefsOf(node).findIndex((ref) => ref.name === portName);
  if (index === -1) return undefined;
  const entries = node.entries.map((entry, entryIndex) =>
    entryIndex === index ? { ...entry, value: toId ?? canvas.UNCONNECTED } : entry,
  );
  return { ...node, entries };
}

/** 一个节点指向 `fromId` 的端口（可能有多个，例如关系方框的左右两边）。 */
function portsPointingAt(node: canvas.CanvasNode, fromId: string): readonly canvas.InputRef[] {
  if (node.kind === 'group') return [];
  return canvas.inputRefsOf(node).filter((ref) => ref.id === fromId);
}

/** 改接一个节点：`toId` 有值就写新 id，没值就断开。没有端口指向 `fromId` 时原样返回。 */
function rewiredNode(node: canvas.CanvasNode, fromId: string, toId: string | undefined): canvas.CanvasNode {
  const ports = portsPointingAt(node, fromId);
  if (ports.length === 0) return node;
  return ports.reduce<canvas.CanvasNode>(
    (current, port) =>
      (toId === undefined ? disconnectedPort(current, port.name) : rewiredPort(current, port.name, toId)) ?? current,
    node,
  );
}

/**
 * 把**所有**指向 `fromId` 的数据输入改接走：`toId` 是 id 就改接，是 `undefined` 就断开。
 *
 * 一次遍历完成，且没有端口命中时返回原文档（不产生多余的新对象）。
 */
export function rewireInputs(
  document: canvas.CanvasDocument,
  fromId: string,
  toId: string | undefined,
): canvas.CanvasDocument {
  const nodes = document.nodes.map((node) => rewiredNode(node, fromId, toId));
  const unchanged = nodes.every((node, index) => node === document.nodes[index]);
  return unchanged ? document : { ...document, nodes };
}
