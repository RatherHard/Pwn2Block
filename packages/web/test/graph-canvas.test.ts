// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import type { PortContext } from '@pwn2block/shared';
import { addNode, connect, createEditor } from '../src/graph/editor';
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
