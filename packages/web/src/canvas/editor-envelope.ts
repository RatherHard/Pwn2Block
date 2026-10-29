import { canvas } from '@pwn2block/shared';
import { edited, nodeOf, unwrapBranch, unwrapLoop, type CanvasEdit } from './editor';
import { rewireInputs } from './editor-convert-wiring';

/** 解除包络及附着转换；内部内容保留，多成员整体的消费者明确断开。 */
export function dissolveEnvelope(document: canvas.CanvasDocument, id: string): CanvasEdit {
  const node = nodeOf(document, id);
  if (node === undefined) return edited(document);
  if (node.kind === 'loop') return unwrapLoop(document, id);
  if (node.kind === 'if') return unwrapBranch(document, id);
  if (node.kind !== 'group' && node.kind !== 'convert') return edited(document);
  let base = node;
  const removals = new Set<string>();
  while (base.kind === 'convert' && !removals.has(base.id)) {
    removals.add(base.id);
    const input = nodeOf(document, base.input);
    if (input?.kind !== 'group' && input?.kind !== 'convert') break;
    base = input;
  }
  removals.add(base.id);
  // 从内层组合的标题解除也应删除附着在它外面的转换。
  for (let pass = 0; pass < document.nodes.length; pass += 1) {
    const before = removals.size;
    for (const candidate of document.nodes) {
      if (candidate.kind === 'convert' && removals.has(candidate.input)) removals.add(candidate.id);
    }
    if (before === removals.size) break;
  }
  const children = base.kind === 'group' ? canvas.groupMembers(base) : [base.input].filter(canvas.isConnected);
  const replacement = children.length === 1 ? children[0] : undefined;
  let next = document;
  for (const removed of removals) next = rewireInputs(next, removed, replacement);
  const layout = { ...next.layout };
  for (const removed of removals) delete layout[removed];
  return edited({ ...next, layout, nodes: next.nodes.filter((item) => !removals.has(item.id)).map((item) => item.kind === 'group'
    ? { ...item, rows: item.rows.map((row) => row.flatMap((member) => removals.has(member) ? children : [member])) } : item) });
}
