import type { canvas } from '@pwn2block/shared';
import { structureChildren } from './structure';
import type { BoxLayout } from './view-model-boxes';
import type { CanvasBox, Rect } from './view-model-types';
import { unionRects, relationBoxSize } from './view-model-geometry';

interface StructureLayoutContext {
  readonly nodes: ReadonlyMap<string, canvas.CanvasNode>;
  readonly layout: BoxLayout;
  readonly rects: Map<string, Rect>;
  readonly frames: CanvasBox[];
  readonly attached: Map<string, CanvasBox>;
  readonly visiting: Set<string>;
}

function attachControl(context: StructureLayoutContext, node: canvas.LoopNode | canvas.IfNode | canvas.ConvertNode, inner: Rect): Rect | undefined {
  const { layout, frames, attached, rects } = context;
  const box = [...layout.nodeBoxes, ...layout.relationBoxes].find((item) => item.nodeId === node.id);
  if (box === undefined) return rects.get(node.id);
  const height = node.kind === 'convert' ? 30 : box.height;
  const header: CanvasBox = { ...box, x: inner.x + inner.width + 24, y: inner.y, height };
  const bounds = unionRects([inner, header])!;
  const frame: CanvasBox = { id: `envelope:${node.id}`, nodeId: node.id, kind: 'envelope', x: bounds.x - 12, y: bounds.y - 12, width: bounds.width + 24, height: bounds.height + 24, title: '', tone: box.tone };
  const old = frames.findIndex((item) => item.nodeId === node.id);
  if (old >= 0) frames.splice(old, 1);
  frames.push(frame);
  attached.set(node.id, header);
  rects.set(node.id, header);
  return frame;
}

/** 从内部向外计算边界，保证外层包络包含已附着的控制框。 */
function attachStructure(context: StructureLayoutContext, id: string): Rect | undefined {
  const { nodes, rects, frames, attached, visiting } = context;
  if (attached.has(id)) return frames.find((box) => box.nodeId === id);
  if (visiting.has(id)) return rects.get(id);
  const node = nodes.get(id);
  if (node === undefined) return rects.get(id);
  if (!['relation', 'unary', 'group', 'loop', 'if', 'convert'].includes(node.kind)) return rects.get(id);
  visiting.add(id);
  const inner = unionRects(structureChildren(node).flatMap((child) => attachStructure(context, child) ?? []));
  visiting.delete(id);
  if (node.kind === 'relation' || node.kind === 'unary') return unionRects([rects.get(id), inner].flatMap((rect) => rect ?? []));
  if (node.kind === 'group') {
    const frame = frames.find((box) => box.nodeId === id);
    if (frame === undefined || inner === undefined) return frame ?? rects.get(id);
    const bounds = { ...frame, x: inner.x - 12, y: inner.y - 12, width: inner.width + 24, height: inner.height + 24 };
    frames[frames.indexOf(frame)] = bounds;
    rects.set(id, bounds);
    return bounds;
  }
  if (inner === undefined || (node.kind !== 'loop' && node.kind !== 'if' && node.kind !== 'convert')) return rects.get(id);
  return attachControl(context, node, inner);
}

function groupRelations(context: StructureLayoutContext): readonly CanvasBox[] {
  const boxes: CanvasBox[] = [];
  for (const node of context.nodes.values()) {
    if (node.kind !== 'group') continue;
    for (const row of node.rows) {
      row.slice(1).forEach((id, index) => {
        const left = attachStructure(context, row[index]);
        const right = attachStructure(context, id);
        if (left === undefined || right === undefined) return;
        const title = node.mode === 'list' ? '组成列表' : '连接串';
        const size = relationBoxSize(title);
        const x = (left.x + left.width + right.x - size.width) / 2;
        const y = (left.y + left.height / 2 + right.y + right.height / 2 - size.height) / 2;
        boxes.push({ id: `relation:${node.id}:${index}:${id}`, nodeId: node.id, kind: 'relation', x, y, ...size, title, tone: 'data' });
      });
    }
  }
  return boxes;
}

function bindingRelations(context: StructureLayoutContext): readonly CanvasBox[] {
  const boxes: CanvasBox[] = [];
  for (const node of context.nodes.values()) {
    if (node.kind !== 'var-decl' || node.binding.mode === 'none') continue;
    const source = context.rects.get(node.binding.input);
    const target = context.rects.get(node.id);
    if (source === undefined || target === undefined) continue;
    const title = node.binding.mode === 'initial' ? '=' : ':=';
    const size = relationBoxSize(title);
    boxes.push({ id: `binding:${node.id}`, nodeId: node.id, kind: 'relation',
      x: (source.x + source.width + target.x - size.width) / 2,
      y: (source.y + source.height / 2 + target.y + target.height / 2 - size.height) / 2,
      ...size, title, tone: 'variable' });
  }
  return boxes;
}

/** 组合关系属于连接层；控制节点附着在包络边缘，内部内容仍然是独立节点。 */
export function structureLayout(nodes: ReadonlyMap<string, canvas.CanvasNode>, layout: BoxLayout, envelopes: readonly CanvasBox[]): { readonly layout: BoxLayout; readonly envelopes: readonly CanvasBox[] } {
  const context: StructureLayoutContext = { nodes, layout, rects: new Map(layout.rectOf), frames: [...envelopes], attached: new Map(), visiting: new Set() };
  for (const node of nodes.values()) attachStructure(context, node.id);
  const extra = [...groupRelations(context), ...bindingRelations(context)];
  return {
    layout: {
      ...layout, rectOf: context.rects,
      nodeBoxes: layout.nodeBoxes.filter((box) => nodes.get(box.nodeId)?.kind !== 'group').map((box) => context.attached.get(box.nodeId) ?? box),
      relationBoxes: [...layout.relationBoxes.map((box) => context.attached.get(box.nodeId) ?? box), ...extra],
    },
    envelopes: context.frames.sort((a, b) => b.width * b.height - a.width * a.height),
  };
}
