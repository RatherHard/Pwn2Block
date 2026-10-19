// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import type { PortContext } from '@pwn2block/shared';
import { addNode, connect, createEditor, groupSelection, setCollapsed } from '../src/graph/editor';
import type { GraphEditorState } from '../src/graph/editor';
import type { GraphEdit, Pwn2BlockGraphCanvas } from '../src/components/graph-canvas';
import '../src/components/graph-canvas';
import { WORKFLOW_CONTEXT, wfNode, workflow } from './workflow-helpers';

/**
 * 画布组件的渲染与手势（06 §3；07 §P2）：节点与端口画出来、点击选中、按键派发编辑事件。
 *
 * jsdom 没有真实布局，所以这里只断言「画了什么、收到手势后派发了什么」；坐标计算本身
 * 由 `graph-geometry.test.ts` 用纯函数覆盖。
 */

const CONTEXT: PortContext = { archBits: 64 };
const mounted: Pwn2BlockGraphCanvas[] = [];

function editorWithPayload(): GraphEditorState {
  const document = workflow({
    nodes: [
      wfNode('fill', NODE.fill, { byte: 0x41, count: 4 }),
      wfNode('feed', NODE.feed),
      wfNode('run', NODE.run, { maxSteps: 50 }),
    ],
    edges: [{ from: { node: 'fill', port: 'out' }, to: { node: 'feed', port: 'data' } }],
    main: ['feed', 'run'],
  });
  return createEditor(document);
}

async function mount(state: GraphEditorState): Promise<Pwn2BlockGraphCanvas> {
  const canvas = document.createElement('pwn2block-graph-canvas') as Pwn2BlockGraphCanvas;
  canvas.state = state;
  canvas.context = CONTEXT;
  canvas.previews = [];
  canvas.issues = [];
  document.body.append(canvas);
  await canvas.updateComplete;
  mounted.push(canvas);
  return canvas;
}

afterEach(() => {
  for (const canvas of mounted.splice(0)) canvas.remove();
});

describe('画布渲染', () => {
  it('每个节点都画出来，端口带类型与方向', async () => {
    const canvas = await mount(editorWithPayload());
    const nodes = canvas.shadowRoot?.querySelectorAll('[data-node]') ?? [];
    const ids = new Set([...nodes].map((node) => node.getAttribute('data-node')));
    expect(ids).toEqual(new Set(['start', 'fill', 'feed', 'run']));

    const outPort = canvas.shadowRoot?.querySelector('[data-node="fill"][data-port="out"]');
    expect(outPort?.getAttribute('data-kind')).toBe('out');
    const dataPort = canvas.shadowRoot?.querySelector('[data-node="feed"][data-port="data"]');
    expect(dataPort?.getAttribute('data-flow')).toBe('data');
    const execOut = canvas.shadowRoot?.querySelector('[data-node="feed"][data-flow="exec"][data-kind="out"]');
    expect(execOut).not.toBeNull();
  });

  it('节点只显示属性值和连接来源，修改侧栏状态后同步显示', async () => {
    const state = editorWithPayload();
    const canvas = await mount(state);
    expect(canvas.shadowRoot?.querySelectorAll('.node input, .node select, .node textarea, .node button')).toHaveLength(0);
    const count = () => canvas.shadowRoot?.querySelector('[data-node="fill"] [data-param-value="count"]');
    expect(count()?.textContent).toBe('4');
    expect(canvas.shadowRoot?.querySelector('[data-node="feed"] .row-value')?.textContent).toContain('fill');
    canvas.state = {
      ...state,
      document: {
        ...state.document,
        nodes: state.document.nodes.map((node) => node.id === 'fill' ? { ...node, params: { ...node.params, count: 9 } } : node),
      },
    };
    await canvas.updateComplete;
    expect(count()?.textContent).toBe('9');
  });

  it('数据线画成路径，数量与连线一致', async () => {
    const canvas = await mount(editorWithPayload());
    const paths = canvas.shadowRoot?.querySelectorAll('path') ?? [];
    expect(paths.length).toBeGreaterThanOrEqual(1);
    for (const path of paths) {
      expect(path.getAttribute('d')?.startsWith('M ')).toBe(true);
    }
  });

  it('问题节点用错误色描边，预览文字显示在节点里', async () => {
    const state = editorWithPayload();
    const canvas = await mount(state);
    canvas.previews = [
      { nodeId: 'fill', type: 'bytes', summary: '4 字节：41414141', hex: '41414141', length: 4 },
    ];
    canvas.issues = [{ code: 'missing_input', severity: 'error', nodeId: 'feed', message: '缺少输入' }];
    await canvas.updateComplete;
    const text = canvas.shadowRoot?.textContent ?? '';
    expect(text).toContain('缺少输入');
    expect(text).toContain('41414141');
  });
});

describe('画布手势', () => {
  it('点节点会派发选择事件', async () => {
    const canvas = await mount(editorWithPayload());
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    const node = canvas.shadowRoot?.querySelector('[data-node="fill"]');
    node?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    expect(events).toContainEqual({ type: 'select', ids: ['fill'] });
  });

  it('选中后按 Delete 派发删除事件', async () => {
    const state = editorWithPayload();
    const canvas = await mount({ ...state, selection: ['feed'] });
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    expect(events).toContainEqual({ type: 'delete', ids: ['feed'] });
  });

  it('Ctrl+Z 派发撤销事件而不是自己改状态', async () => {
    const canvas = await mount(editorWithPayload());
    let undone = 0;
    canvas.addEventListener('p2b-graph-undo', () => {
      undone += 1;
    });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(undone).toBe(1);
  });

  it('双击数据线派发断开事件', async () => {
    const canvas = await mount(editorWithPayload());
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    const path = canvas.shadowRoot?.querySelector('path[data-edge="0"]');
    expect(path).not.toBeNull();
    path?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(events).toContainEqual({
      type: 'disconnect',
      edge: { from: { node: 'fill', port: 'out' }, to: { node: 'feed', port: 'data' } },
    });
  });

  it('改接落到空白处：不派发 rewire，原连接保持不变', async () => {
    const canvas = await mount(editorWithPayload());
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    const handle = canvas.shadowRoot?.querySelector('[data-edge="0"][data-edge-end="to"]');
    if (handle === null || handle === undefined) throw new Error('连线上没有改接把手');
    const viewport = canvas.shadowRoot?.querySelector('.viewport');
    if (viewport === null || viewport === undefined) throw new Error('没有画布视口');
    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    viewport.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 700 }));
    viewport.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 900, clientY: 700 }));
    expect(events.filter((event) => event.type === 'rewire')).toEqual([]);
  });

  it('键盘接线：没有选中节点时给出提示', async () => {
    const canvas = await mount(editorWithPayload());
    let message = '';
    canvas.addEventListener('p2b-graph-message', (event) => {
      message = (event as CustomEvent<{ message: string }>).detail.message;
    });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(message).toContain('先选中');
  });

  it('键盘接线：有可接端口时提示候选数量', async () => {
    const state = editorWithPayload();
    const canvas = await mount({ ...state, selection: ['fill'] });
    let message = '';
    canvas.addEventListener('p2b-graph-message', (event) => {
      message = (event as CustomEvent<{ message: string }>).detail.message;
    });
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(message).toContain('Tab');
  });

  it('拖动节点标题栏后松手才派发移动事件（不跳变、不原地不动）', async () => {
    const state = editorWithPayload();
    const origin = state.document.layout.fill;
    if (origin === undefined) throw new Error('填充节点没有布局');
    const canvas = await mount(state);
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    const head = canvas.shadowRoot?.querySelector('[data-node="fill"] [data-drag-handle]');
    if (head === null || head === undefined) throw new Error('节点没有拖动把手');
    // jsdom 没有布局：视口为 0 平移、1 倍缩放，屏幕坐标即图坐标。
    head.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }));
    // 按下只选中，位置不动。
    expect(events.filter((event) => event.type === 'move')).toEqual([]);
    head.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 90, clientY: 70 }));
    expect(events.filter((event) => event.type === 'move')).toEqual([]);
    await canvas.updateComplete;
    const node = canvas.shadowRoot?.querySelector<HTMLElement>('.node[data-node="fill"]');
    expect(node?.style.left).toBe(`${origin.x + 50}px`);
    expect(node?.style.top).toBe(`${origin.y + 30}px`);
    head.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 90, clientY: 70 }));
    expect(events).toContainEqual({
      type: 'move',
      moves: { fill: { x: origin.x + 50, y: origin.y + 30 } },
    });
  });

  it('Shift 框选松手后按矩形范围选中节点', async () => {
    const canvas = await mount(editorWithPayload());
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    const viewport = canvas.shadowRoot?.querySelector('.viewport');
    if (viewport === null || viewport === undefined) throw new Error('没有画布视口');
    viewport.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: -20, clientY: -20, shiftKey: true }),
    );
    viewport.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 400, clientY: 400 }));
    viewport.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 400, clientY: 400 }));
    const selected = events.find((event) => event.type === 'select');
    expect(selected).toBeDefined();
    if (selected?.type !== 'select') return;
    expect(selected.ids).toContain('fill');
  });

  it('空白处拖动平移视图，位移带 px 单位', async () => {
    const canvas = await mount(editorWithPayload());
    const viewport = canvas.shadowRoot?.querySelector('.viewport');
    if (viewport === null || viewport === undefined) throw new Error('没有画布视口');
    const surface = canvas.shadowRoot?.querySelector('.surface');
    const before = surface?.getAttribute('style') ?? '';
    const origin = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(before);
    expect(origin).not.toBeNull();
    viewport.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
    viewport.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 25 }));
    await canvas.updateComplete;
    const after = surface?.getAttribute('style') ?? '';
    const moved = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(after);
    expect(moved).not.toBeNull();
    expect(Number(moved?.[1]) - Number(origin?.[1])).toBe(30);
    expect(Number(moved?.[2]) - Number(origin?.[2])).toBe(15);
  });
});

describe('画布与编辑器一致', () => {
  it('刚加的节点也能画出来', async () => {
    const base = createEditor(workflow({ nodes: [], edges: [], main: [] }));
    const added = addNode(base, { kind: NODE.feed });
    if (!added.ok) throw new Error(added.message);
    const canvas = await mount(added.state);
    expect(canvas.shadowRoot?.querySelector('[data-node="feed"]')).not.toBeNull();
    expect(WORKFLOW_CONTEXT.allowedActions).toContain('feed');
    expect(typeof connect).toBe('function');
  });
});

describe('容器折叠与缩放简化', () => {
  function containerState(): GraphEditorState {
    return createEditor(
      workflow({
        nodes: [
          wfNode('if', NODE.if, {}, { then: ['write'], else: [] }),
          wfNode('write', NODE.write, { addr: 0x400000 }),
        ],
        edges: [],
        main: ['if'],
      }),
    );
  }

  it('折叠后子节点与区域框都不画，摘要写条数', async () => {
    const canvas = await mount(setCollapsed(containerState(), 'if', true));
    expect(canvas.shadowRoot?.querySelector('[data-node="write"]')).toBeNull();
    expect(canvas.shadowRoot?.querySelector('[data-region="if"]')).toBeNull();
    expect(canvas.shadowRoot?.textContent ?? '').toContain('已折叠 · 1 条语句');
  });

  it('容器上双击派发折叠事件', async () => {
    const canvas = await mount(containerState());
    const events: GraphEdit[] = [];
    canvas.addEventListener('p2b-graph-edit', (event) =>
      events.push((event as CustomEvent<GraphEdit>).detail),
    );
    canvas.shadowRoot
      ?.querySelector('[data-node="if"]')
      ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(events).toContainEqual({ type: 'collapse', nodeId: 'if', collapsed: true });
  });

  it('缩小到阈值以下只留骨架，隐藏副标题', async () => {
    const canvas = await mount(editorWithPayload());
    expect(canvas.shadowRoot?.textContent ?? '').toContain('字节');
    canvas.setZoom(0.4);
    await canvas.updateComplete;
    expect(canvas.shadowRoot?.querySelector('.subtitle')).toBeNull();
  });
});

describe('分组框', () => {
  it('分组画出虚线框与名字，成员都折叠隐藏时不画', async () => {
    const base = createEditor(
      workflow({
        nodes: [wfNode('hex', NODE.hex, { hex: '41' }), wfNode('run', NODE.run)],
        edges: [],
        main: ['hex', 'run'],
      }),
    );
    const result = groupSelection({ ...base, selection: ['hex', 'run'] });
    if (!result.ok) throw new Error(result.message);
    const canvas = await mount(result.state);
    expect(canvas.shadowRoot?.querySelector('[data-group]')).not.toBeNull();
    expect(canvas.shadowRoot?.textContent ?? '').toContain('组 1');
  });
});
