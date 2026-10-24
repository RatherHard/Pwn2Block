import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { createNode } from '../src/canvas/catalog';
import {
  FLOW_PORT_GAP,
  layoutCanvas,
  nodeBoxSize,
  rectOfNode,
  relationBoxSize,
} from '../src/canvas/view-model';
import type { CanvasBox, CanvasFlowPortView, CanvasLayoutView } from '../src/canvas/view-model';

/**
 * 视图模型的验收（任务「几何规则必须可测、确定」）。
 *
 * 断言分三类：
 * - **盒子**：十八种节点各是「大白框」还是「关系方框」，标题与配色对不对；
 * - **几何**：端口在盒外、关系方框在中点、包络是并集 +12、流程边只连相邻两步且接在流程连接点——
 *   都写具体数字；
 * - **语义与确定性**：预览、问题分组、`regionOf` 来自共享层，同一个输入两次调用完全相等。
 */

const NODE_ID = 'n1';

function documentWith(
  nodes: readonly canvas.CanvasNode[],
  layout: Readonly<Record<string, canvas.CanvasNodeLayout>> = {},
  main: readonly string[] = [],
): canvas.CanvasDocument {
  return { ...canvas.emptyCanvasDocument(), nodes, layout, main };
}

function boxOf(view: CanvasLayoutView, nodeId: string, kind: 'node' | 'relation' | 'group' | 'envelope'): CanvasBox | undefined {
  return view.boxes.find((box) => box.nodeId === nodeId && box.kind === kind);
}

function textOf(view: CanvasLayoutView, nodeId: string): readonly string[] {
  return (view.rowsByNode.get(nodeId) ?? []).map((row) => row.label);
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** 某个节点的流程连接点（正常是 `in`、`out` 各一条）。 */
function flowPortsOf(view: CanvasLayoutView, nodeId: string): readonly CanvasFlowPortView[] {
  return view.flowPorts.filter((port) => port.nodeId === nodeId);
}

/** 某个节点某个方向的流程连接点是否接上了流程线；没有这个节点就返回 `undefined`。 */
function flowConnectedOf(
  view: CanvasLayoutView,
  nodeId: string,
  direction: 'in' | 'out',
): boolean | undefined {
  return flowPortsOf(view, nodeId).find((port) => port.direction === direction)?.connected;
}

/** 把视图（含 Map）压成可比较的字符串：两次布局必须逐字节相同。 */
function snapshot(view: CanvasLayoutView): string {
  return JSON.stringify({
    boxes: view.boxes,
    rows: sortedEntries(view.rowsByNode),
    ports: view.ports,
    flowPorts: view.flowPorts,
    edges: view.edges,
    previews: sortedEntries(view.previews),
    issues: sortedEntries(view.issuesByNode),
    regions: sortedEntries(view.regionOf),
  });
}

const intValue = (id: string, value = '7'): canvas.CanvasNode => ({ id, kind: 'value', value: { kind: 'int', value } });
const relationNode = (id: string, left: string, right: string): canvas.CanvasNode => ({
  id,
  kind: 'relation',
  op: 'int.add',
  left,
  right,
});
const indexNode = (id: string, target: string, index: string): canvas.CanvasNode => ({
  id,
  kind: 'index',
  target,
  index,
});

const UN = canvas.UNCONNECTED;

/** 十八种节点：种类、期望标题、期望配色、期望盒子种类（关系方框 vs 大白框）。 */
const KIND_CASES = [
  ['value', '值', 'data', 'node'],
  ['group', '组合', 'data', 'node'],
  ['dict', '字典', 'data', 'node'],
  ['index', '按索引取元素', 'data', 'node'],
  ['lookup', '按键取值', 'data', 'node'],
  ['slice', '切片', 'data', 'node'],
  ['repeat', '重复', 'data', 'node'],
  ['relation', '整数加', 'data', 'relation'],
  ['unary', '长度', 'data', 'relation'],
  ['convert', '整数转字节串', 'convert', 'relation'],
  ['var-decl', '变量声明 a', 'variable', 'node'],
  ['var-ref', '变量引用', 'variable', 'node'],
  ['loop-index', '循环索引', 'variable', 'node'],
  ['start', '开始', 'flow', 'node'],
  ['if', '条件分支', 'flow', 'node'],
  ['loop', '次数循环', 'flow', 'node'],
  ['method', '方法', 'method', 'node'],
  ['assign', '设置变量', 'flow', 'node'],
] as const;

describe('十八种节点的盒子', () => {
  for (const [kind, title, tone, boxKind] of KIND_CASES) {
    it(`${kind} 出${boxKind === 'relation' ? '关系方框' : '大白框'}，标题「${title}」，配色 ${tone}`, () => {
      const view = layoutCanvas({ document: documentWith([createNode(kind, NODE_ID)]) });
      const kinds = view.boxes.filter((box) => box.nodeId === NODE_ID).map((box) => box.kind);
      expect(kinds).toContain(boxKind);
      // 运算类不准同时出大白框：需求把它们画成中小方框。
      if (boxKind === 'relation') expect(kinds).not.toContain('node');
      const box = boxOf(view, NODE_ID, boxKind);
      expect(box?.title).toBe(title);
      expect(box?.tone).toBe(tone);
    });
  }
});

describe('端口', () => {
  it('落在盒子外侧，第 i 个端口 y 递增 22', () => {
    const repeat: canvas.CanvasNode = { id: 'rp', kind: 'repeat', target: UN, count: UN };
    const view = layoutCanvas({ document: documentWith([repeat], { rp: { x: 200, y: 200 } }) });
    const box = boxOf(view, 'rp', 'node');
    const ports = view.ports.filter((port) => port.nodeId === 'rp');
    expect(ports).toHaveLength(2);
    expect(ports[0].x).toBe((box?.x ?? 0) - 6);
    expect(ports[0].y).toBe((box?.y ?? 0) + 24);
    expect(ports[1].y).toBe((box?.y ?? 0) + 46);
    expect(ports[0].connected).toBe(false);
  });
});

describe('连线', () => {
  it('数量等于已接线的输入数，from/to 是两端的端口点', () => {
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), intValue('v2'), indexNode('ix', 'v1', 'v2')], {
        v1: { x: 0, y: 0 },
        v2: { x: 0, y: 200 },
        ix: { x: 300, y: 300 },
      }),
    });
    expect(view.edges).toHaveLength(2);
    const edge = view.edges.find((item) => item.to.nodeId === 'ix' && item.to.y === 324);
    expect(edge?.from).toEqual({ nodeId: 'v1', x: 186, y: 47 });
    expect(edge?.to).toEqual({ nodeId: 'ix', x: 294, y: 324 });
    expect(edge?.viaRect).toBeUndefined();
    expect(edge?.kind).toBe('data');
  });
});

describe('关系方框', () => {
  it('两个已接线输入时落在最右来源右侧 32 处，竖直对齐来源中心', () => {
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), intValue('v2'), relationNode('r', 'v1', 'v2')], {
        v1: { x: 0, y: 0 },
        v2: { x: 300, y: 0 },
        r: { x: 0, y: 200 },
      }),
    });
    const box = boxOf(view, 'r', 'relation');
    // 白框 180×94（值 + 预览两行），最右来源右边缘 480，再 +32；中心 47 − 方框半高 14。
    expect(box).toMatchObject({ x: 512, y: 33, width: 58, height: 28 });
  });

  it('来源上下排时方框不压在两个白框之间', () => {
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), intValue('v2'), relationNode('r', 'v1', 'v2')], {
        v1: { x: 0, y: 0 },
        v2: { x: 0, y: 120 },
        r: { x: 0, y: 400 },
      }),
    });
    // 两个中心 47 与 167 的平均 107，方框顶 93；x 在来源右侧 212。
    expect(boxOf(view, 'r', 'relation')).toMatchObject({ x: 212, y: 93, width: 58, height: 28 });
  });

  it('首选位置被白框占住时按固定顺序避让，并留出 12 的空隙', () => {
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), relationNode('r', 'v1', UN), intValue('blocker')], {
        v1: { x: 0, y: 0 },
        r: { x: 0, y: 400 },
        blocker: { x: 220, y: 0 },
      }),
    });
    const box = boxOf(view, 'r', 'relation');
    // 首选 (212, 33) 撞上 blocker（220..400 × 0..94）。每档 28 + 12 = 40，按 0、+1、−1、+2 试：
    // y=33、73、−7 外扩 12 后都与 blocker 相交，y=113 外扩后顶在 101，第一个不撞。
    expect(box).toMatchObject({ x: 212, y: 113 });
    expect(box!.y - 12).toBeGreaterThan(94);
  });

  it('输入都没接线时放在自己锚点上方 40 处', () => {
    const view = layoutCanvas({ document: documentWith([relationNode('r', UN, UN)], { r: { x: 100, y: 100 } }) });
    expect(boxOf(view, 'r', 'relation')).toMatchObject({ x: 100, y: 32, width: 58, height: 28 });
  });

  it('进出的边都带上关系方框矩形，端口在其外 6px', () => {
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), relationNode('r', 'v1', UN), indexNode('ix', 'r', UN)], {
        v1: { x: 0, y: 0 },
        r: { x: 0, y: 200 },
        ix: { x: 400, y: 300 },
      }),
    });
    const rect = boxOf(view, 'r', 'relation');
    const incoming = view.edges.find((edge) => edge.from.nodeId === 'v1');
    const outgoing = view.edges.find((edge) => edge.from.nodeId === 'r');
    expect(incoming?.to).toEqual({ nodeId: 'r', x: 206, y: 42 });
    expect(incoming?.viaRect).toMatchObject({ x: rect?.x, y: rect?.y, width: 58, height: 28 });
    expect(outgoing?.from).toEqual({ nodeId: 'r', x: 276, y: 47 });
    expect(outgoing?.viaRect).toMatchObject({ x: rect?.x, y: rect?.y, width: 58, height: 28 });
  });
});

describe('包络', () => {
  it('组合是成员并集各边 +12，并画在节点之前', () => {
    const group: canvas.CanvasNode = { id: 'g1', kind: 'group', mode: 'list', rows: [['v1', 'v2']] };
    const view = layoutCanvas({
      document: documentWith([group, intValue('v1'), intValue('v2')], {
        g1: { x: 0, y: 300 },
        v1: { x: 0, y: 0 },
        v2: { x: 300, y: 0 },
      }),
    });
    expect(boxOf(view, 'g1', 'group')).toMatchObject({ x: -12, y: -12, width: 504, height: 118 });
    expect(view.boxes[0].kind).toBe('group');
  });

  it('空成员用自身 layout 给 160×80', () => {
    const group: canvas.CanvasNode = { id: 'g1', kind: 'group', mode: 'list', rows: [] };
    const view = layoutCanvas({ document: documentWith([group], { g1: { x: 50, y: 60 } }) });
    expect(boxOf(view, 'g1', 'group')).toMatchObject({ x: 50, y: 60, width: 160, height: 80 });
  });

  it('嵌套两层：内层 +12，外层再 +12', () => {
    const inner: canvas.CanvasNode = { id: 'gi', kind: 'group', mode: 'list', rows: [['v1']] };
    const outer: canvas.CanvasNode = { id: 'go', kind: 'group', mode: 'list', rows: [['gi']] };
    const view = layoutCanvas({
      document: documentWith([inner, outer, intValue('v1')], {
        gi: { x: 0, y: 300 },
        go: { x: 0, y: 500 },
        v1: { x: 100, y: 100 },
      }),
    });
    expect(boxOf(view, 'gi', 'group')).toMatchObject({ x: 88, y: 88, width: 204, height: 118 });
    expect(boxOf(view, 'go', 'group')).toMatchObject({ x: 76, y: 76, width: 228, height: 142 });
  });

  it('转换包络是输入结构各边 +16', () => {
    const convert: canvas.CanvasNode = {
      id: 'c1',
      kind: 'convert',
      spec: { kind: 'int-to-bytes', width: 4, endian: 'little', signed: false },
      input: 'v1',
    };
    const view = layoutCanvas({
      document: documentWith([intValue('v1'), convert], { v1: { x: 100, y: 100 }, c1: { x: 500, y: 300 } }),
    });
    expect(boxOf(view, 'c1', 'envelope')).toMatchObject({ x: 84, y: 84, width: 212, height: 126 });
    expect(boxOf(view, 'c1', 'relation')?.title).toBe('整数转字节串');
  });
});

describe('流程', () => {
  const start: canvas.CanvasNode = { id: 's', kind: 'start' };
  const branch: canvas.CanvasNode = { id: 'if1', kind: 'if', cond: 'v1', then: ['a1'], else: [] };
  const loop: canvas.CanvasNode = { id: 'lp', kind: 'loop', count: 'v1', body: ['a2'] };
  const assign = (id: string): canvas.CanvasNode => ({ id, kind: 'assign', target: 'd1', value: UN });
  const decl: canvas.CanvasNode = { id: 'd1', kind: 'var-decl', name: 'a', type: 'int', binding: { mode: 'none' } };
  const flowDocument = documentWith(
    [start, branch, loop, assign('a1'), assign('a2'), assign('a3'), intValue('v1'), decl],
    {},
    ['s', 'if1', 'lp', 'a3'],
  );

  it('流程边只连相邻两步，数量是 Σ(序列长度 − 1)', () => {
    const view = layoutCanvas({ document: flowDocument });
    const flow = view.edges.filter((edge) => edge.kind === 'flow');
    expect(flow).toHaveLength(3);
    expect(view.edges.filter((edge) => edge.kind === 'data')).toHaveLength(2);
    expect(flow.map((edge) => edge.from.nodeId)).toEqual(['s', 'if1', 'lp']);
    expect(flow.map((edge) => edge.to.nodeId)).toEqual(['if1', 'lp', 'a3']);
  });

  it('区域归属直接来自 analyzeFlow', () => {
    const view = layoutCanvas({ document: flowDocument });
    expect(sortedEntries(view.regionOf)).toEqual(sortedEntries(canvas.analyzeFlow(flowDocument).regionOf));
    expect(view.regionOf.get('a1')).toEqual({ ownerId: 'if1', kind: 'then' });
    expect(view.regionOf.get('a2')).toEqual({ ownerId: 'lp', kind: 'body' });
  });

  /** 三步主线 + 显式坐标：几何断言要确定的盒子矩形。 */
  const threeStep = documentWith(
    [start, branch, assign('a1'), assign('a3'), decl],
    { s: { x: 0, y: 0 }, if1: { x: 0, y: 200 }, a3: { x: 0, y: 400 } },
    ['s', 'if1', 'a3'],
  );

  it('main 三步：首节点只有出口、末节点只有入口，中间节点进出都接上', () => {
    const view = layoutCanvas({ document: threeStep });
    expect(flowConnectedOf(view, 's', 'in')).toBe(false);
    expect(flowConnectedOf(view, 's', 'out')).toBe(true);
    expect(flowConnectedOf(view, 'if1', 'in')).toBe(true);
    expect(flowConnectedOf(view, 'if1', 'out')).toBe(true);
    expect(flowConnectedOf(view, 'a3', 'in')).toBe(true);
    expect(flowConnectedOf(view, 'a3', 'out')).toBe(false);
  });

  it('流程连接点坐标在盒子外侧：出口在盒底下方 10、入口在盒顶上方 10', () => {
    const view = layoutCanvas({ document: threeStep });
    const box = boxOf(view, 'if1', 'node');
    if (box === undefined) throw new Error('if1 没有大白框');
    const out = flowPortsOf(view, 'if1').find((port) => port.direction === 'out');
    const entry = flowPortsOf(view, 'if1').find((port) => port.direction === 'in');
    expect(FLOW_PORT_GAP).toBe(10);
    expect(out).toMatchObject({ x: box.x + box.width / 2, y: box.y + box.height + FLOW_PORT_GAP });
    expect(entry).toMatchObject({ x: box.x + box.width / 2, y: box.y - FLOW_PORT_GAP });
    // 与 `rectOf` 同口径比较：出口严格在盒底之下、入口严格在盒顶之上，不是裸边。
    expect(out?.y).toBeGreaterThan(box.y + box.height);
    expect(entry?.y).toBeLessThan(box.y);
  });

  it('流程边两端接在小方框中心（不是盒子裸边）', () => {
    const view = layoutCanvas({ document: threeStep });
    const box = boxOf(view, 'if1', 'node');
    if (box === undefined) throw new Error('if1 没有大白框');
    const flow = view.edges.filter((edge) => edge.kind === 'flow');
    expect(flow).toHaveLength(2);
    const sOut = flowPortsOf(view, 's').find((port) => port.direction === 'out');
    const entry = flowPortsOf(view, 'if1').find((port) => port.direction === 'in');
    expect(flow[0].from).toEqual({ nodeId: 's', x: sOut?.x, y: sOut?.y });
    // 终点就是那个小方框的中心：比盒顶再高 `FLOW_PORT_GAP`。
    expect(flow[0].to).toEqual({ nodeId: 'if1', x: box.x + box.width / 2, y: box.y - FLOW_PORT_GAP });
    expect(entry?.y).toBe(flow[0].to.y);
    expect(flow[1].from.y).toBe(box.y + box.height + FLOW_PORT_GAP);
  });

  it('loop.body 里的节点也有流程端口（区域序列同样算）', () => {
    const view = layoutCanvas({ document: flowDocument });
    const body = flowPortsOf(view, 'a2');
    expect(body.map((port) => port.direction)).toEqual(['in', 'out']);
    // a2 是 body 里唯一一步：既是第一个也是最后一个，所以两端都空。
    expect(body.map((port) => port.connected)).toEqual([false, false]);
  });

  it('同一节点不会出现两条同方向端口，非流程节点不出流程端口', () => {
    const view = layoutCanvas({ document: flowDocument });
    for (const nodeId of ['s', 'if1', 'lp', 'a3', 'a1', 'a2']) {
      expect(flowPortsOf(view, nodeId).map((port) => port.direction)).toEqual(['in', 'out']);
    }
    expect(view.flowPorts).toHaveLength(12);
    expect(flowPortsOf(view, 'v1')).toHaveLength(0);
    expect(flowPortsOf(view, 'd1')).toHaveLength(0);
  });
});

describe('预览与问题', () => {
  it('未接线的节点在 issuesByNode 里有「还没接线」，整块行标红', () => {
    const view = layoutCanvas({ document: documentWith([relationNode('r', UN, UN)]) });
    const lines = view.issuesByNode.get('r') ?? [];
    expect(lines.some((line) => line.includes('还没接线'))).toBe(true);
    expect(view.rowsByNode.get('r')?.every((row) => row.severity === 'error')).toBe(true);
  });

  it('待执行的变量引用预览是「待执行」', () => {
    const view = layoutCanvas({
      document: documentWith(
        [
          { id: 'd1', kind: 'var-decl', name: 'a', type: 'int', binding: { mode: 'none' } },
          { id: 'r1', kind: 'var-ref', decl: 'd1' },
          { id: 's1', kind: 'assign', target: 'd1', value: 'v1' },
          intValue('v1'),
        ],
        {},
        ['s1'],
      ),
    });
    expect(view.previews.get('r1')).toBe('待执行');
  });

  it('字面值的预览是它的值摘要，「值」行可就地编辑', () => {
    const view = layoutCanvas({ document: documentWith([intValue('v1')]) });
    expect(view.previews.get('v1')).toContain('7');
    const rows = view.rowsByNode.get('v1') ?? [];
    expect(rows.map((row) => row.label)).toEqual(['值', '预览']);
    expect(rows[0].editable).toBe(true);
    expect(rows[1].editable).toBe(false);
  });
});

describe('行', () => {
  it('切片给起点/终点/步长，未接线时说「默认」，末尾补预览行', () => {
    const slice: canvas.CanvasNode = { id: 'sl', kind: 'slice', target: UN };
    const view = layoutCanvas({ document: documentWith([slice]) });
    expect(textOf(view, 'sl')).toEqual(['起点', '终点', '步长', '预览']);
    expect(view.rowsByNode.get('sl')?.[0].value).toBe('默认');
  });

  it('变量声明给名称/类型/绑定，只有名称可就地改', () => {
    const decl: canvas.CanvasNode = { id: 'd1', kind: 'var-decl', name: 'a', type: 'int', binding: { mode: 'none' } };
    const view = layoutCanvas({ document: documentWith([decl]) });
    const rows = view.rowsByNode.get('d1') ?? [];
    expect(rows.map((row) => row.label)).toEqual(['名称', '类型', '绑定']);
    expect(rows.map((row) => row.editable)).toEqual([true, false, false]);
    expect(rows[1].value).toBe('整数');
  });

  it('转换给转换名加参数，参数不可就地改', () => {
    const convert: canvas.CanvasNode = {
      id: 'c1',
      kind: 'convert',
      spec: { kind: 'int-to-bytes', width: 4, endian: 'little', signed: false },
      input: UN,
    };
    const view = layoutCanvas({ document: documentWith([convert]) });
    const rows = view.rowsByNode.get('c1') ?? [];
    expect(rows.map((row) => row.label)).toEqual(['转换', '宽度', '字节序', '有符号', '预览']);
    expect(rows.every((row) => !row.editable)).toBe(true);
  });

  it('方法给方法名加每个参数，参数可就地改', () => {
    const method: canvas.CanvasNode = { id: 'm1', kind: 'method', block: 'write', args: { addr: UN, data: UN } };
    const view = layoutCanvas({
      document: documentWith([method]),
      methods: [{ id: 'write', label: '写入内存', params: [{ name: 'addr', type: 'addr' }, { name: 'data', type: 'bytes' }], actionCount: 1 }],
    });
    const rows = view.rowsByNode.get('m1') ?? [];
    expect(rows.map((row) => row.label)).toEqual(['方法', 'addr', 'data']);
    expect(rows[0].value).toBe('写入内存');
    expect(rows.slice(1).every((row) => row.editable)).toBe(true);
    expect(boxOf(view, 'm1', 'node')?.title).toBe('写入内存');
  });
});

describe('尺寸工具与布局锚框', () => {
  it('关系方框最小 44×28、最大 120×36', () => {
    expect(relationBoxSize('a')).toEqual({ width: 44, height: 28 });
    expect(relationBoxSize('字节串列表转字节串')).toEqual({ width: 120, height: 36 });
  });

  it('节点方框最小 180×72，每多一行 +22 高，长文本会加宽', () => {
    expect(nodeBoxSize([], '值')).toEqual({ width: 180, height: 72 });
    const rows = [
      { nodeId: 'x', label: '值', value: '1', editable: true },
      { nodeId: 'x', label: '预览', value: '1（0x1）', editable: false },
    ];
    expect(nodeBoxSize(rows, '值').height).toBe(94);
    const wide = [{ nodeId: 'x', label: '值', value: 'x'.repeat(30), editable: true }];
    expect(nodeBoxSize(wide, '值').width).toBeGreaterThan(180);
  });

  it('rectOfNode 用 layout；没有 layout 时按 id 排序填网格且两次一致', () => {
    const document = documentWith([intValue('b'), intValue('a')], { b: { x: 10, y: 20 } });
    expect(rectOfNode(document, 'b')).toEqual({ x: 10, y: 20, width: 180, height: 72 });
    expect(rectOfNode(document, 'a')).toEqual({ x: 40, y: 40, width: 180, height: 72 });
    expect(rectOfNode(document, 'missing')).toBeUndefined();
    expect(rectOfNode(document, 'a')).toEqual(rectOfNode(document, 'a'));
  });
});

describe('确定性', () => {
  it('同一个输入两次布局完全相等（含所有 Map）', () => {
    const document = documentWith(
      [
        { id: 'g1', kind: 'group', mode: 'merge', rows: [['v1', 'r1']] },
        intValue('v1'),
        relationNode('r1', 'v1', 'v2'),
        intValue('v2'),
        { id: 's', kind: 'start' },
        { id: 'lp', kind: 'loop', count: 'v1', body: ['s'] },
      ],
      { v1: { x: 0, y: 0 }, v2: { x: 300, y: 0 }, r1: { x: 0, y: 200 } },
      ['s'],
    );
    expect(snapshot(layoutCanvas({ document }))).toBe(snapshot(layoutCanvas({ document })));
  });
});
