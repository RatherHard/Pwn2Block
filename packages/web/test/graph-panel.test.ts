// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE, ret2winPublic } from '@pwn2block/shared';
import type { Pwn2BlockGraphPanel } from '../src/components/graph-panel';
import '../src/components/graph-panel';
import type { KeyValueStore } from '../src/viewmodel/storage';
import { graphStorageKey } from '../src/graph/storage';
import { wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 画布面板（07 §P2/P3）：从工具箱加节点、恢复本地存档、编译并显示动作数与问题。
 *
 * 编译是本地纯计算，所以这里不需要后端：注入一份存档，点「编译」，断言状态行与问题列表。
 */

const panels: Pwn2BlockGraphPanel[] = [];

class MemoryStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function mount(saved?: unknown): Promise<{ panel: Pwn2BlockGraphPanel; store: MemoryStore }> {
  return mountWith(saved === undefined ? {} : { interim: JSON.stringify(saved) });
}

async function mountWith(
  raw: { readonly current?: string; readonly interim?: string },
): Promise<{ panel: Pwn2BlockGraphPanel; store: MemoryStore }> {
  const store = new MemoryStore();
  if (raw.current !== undefined) store.setItem(graphStorageKey(ret2winPublic.id), raw.current);
  if (raw.interim !== undefined) store.setItem(`pwn2block.graph.${ret2winPublic.id}`, raw.interim);
  const panel = document.createElement('pwn2block-graph-panel') as Pwn2BlockGraphPanel;
  panel.challenge = ret2winPublic;
  panel.store = store;
  document.body.append(panel);
  await panel.updateComplete;
  panels.push(panel);
  return { panel, store };
}

async function settle(panel: Pwn2BlockGraphPanel): Promise<void> {
  await Promise.resolve();
  await panel.updateComplete;
  await Promise.resolve();
  await panel.updateComplete;
}

/** 节点库与属性面板各自有影子根：跨一层的查询单独收在这里，测试里只看行为。 */
function libraryButton(panel: Pwn2BlockGraphPanel, kind: string): HTMLButtonElement | null {
  const library = panel.shadowRoot?.querySelector('pwn2block-node-library');
  return library?.shadowRoot?.querySelector<HTMLButtonElement>(`button[data-kind="${kind}"]`) ?? null;
}

function inspectorInput(panel: Pwn2BlockGraphPanel, id: string): HTMLInputElement | null {
  const inspector = panel.shadowRoot?.querySelector('pwn2block-node-inspector');
  return inspector?.shadowRoot?.querySelector<HTMLInputElement>(`input#${id}`) ?? null;
}

function canvasOf(panel: Pwn2BlockGraphPanel) {
  return panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
}

afterEach(() => {
  for (const panel of panels.splice(0)) panel.remove();
});

/**
 * ret2win 只允许 step/run/undo/reset（见 fixtures），所以合法动作选「运行」；
 * 数据节点放在执行序列里会被求值，正好用来断言预览。
 */
function feedGraph(): unknown {
  return workflow({
    nodes: [wfNode('hex', NODE.hex, { hex: '41414141' }), wfNode('run', NODE.run, { maxSteps: 100 })],
    edges: [],
    main: ['hex', 'run'],
  });
}

describe('画布面板：Python 能力', () => {
  it('服务端报隔离运行器不可用时，面板写清原因', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ python: { available: false, backend: 'none', isolated: false, reason: '未配置隔离后端' } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    try {
      const { panel } = await mount();
      await vi.waitFor(() => {
        expect(panel.shadowRoot?.textContent ?? '').toContain('Python：不可用');
      });
      expect(panel.shadowRoot?.textContent ?? '').toContain('未配置隔离后端');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('隔离后端可用时显示后端与「已隔离」', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ python: { available: true, backend: 'docker', isolated: true } }), {
        status: 200,
      })) as unknown as typeof fetch;
    try {
      const { panel } = await mount();
      await vi.waitFor(() => {
        expect(panel.shadowRoot?.textContent ?? '').toContain('Python：docker · 已隔离');
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('画布面板：工具箱与存档', () => {
  it('节点库按分类列出节点，点一下就加进画布', async () => {
    const { panel } = await mount();
    const library = panel.shadowRoot?.querySelector('pwn2block-node-library');
    const entries = library?.shadowRoot?.querySelectorAll('button[data-kind]') ?? [];
    expect(entries.length).toBeGreaterThan(10);
    const fill = libraryButton(panel, 'data.fill');
    expect(fill).not.toBeNull();
    fill?.click();
    await settle(panel);
    expect(canvasOf(panel)?.shadowRoot?.querySelector('[data-node="fill"]')).not.toBeNull();
  });

  it('本地存档能恢复；坏存档显示提示并保持空画布', async () => {
    const { panel } = await mount(feedGraph());
    expect(canvasOf(panel)?.shadowRoot?.querySelector('[data-node="hex"]')).not.toBeNull();

    const broken = await mount({ format: 'pwn2block.workflow', version: 99, nodes: [] });
    const empty = canvasOf(broken.panel);
    // 10 §5：读不出来时画布是空的（不预置开始节点），并给出可解释的提示与「从空白开始」出口。
    expect(empty?.shadowRoot?.querySelector('[data-node]')).toBeNull();
    expect(broken.panel.shadowRoot?.textContent ?? '').toContain('导出原文');
    expect(broken.panel.shadowRoot?.textContent ?? '').toContain('从空白画布开始');
  });

  it('编辑后写回存档', async () => {
    const { panel, store } = await mount();
    libraryButton(panel, 'data.fill')?.click();
    await settle(panel);
    const saved = store.getItem(graphStorageKey(ret2winPublic.id));
    expect(saved).not.toBeNull();
    expect(saved ?? '').toContain('data.fill');
    expect(saved ?? '').toContain('pwn2block.graph-save');
  });
});

describe('画布面板：运行入口与存档失败', () => {
  it('运行/终止按钮复用控制器的门禁模型，点击只派发命令', async () => {
    const { panel } = await mount();
    panel.controls = {
      run: { id: 'run-all', label: '运行', hint: '从头执行', enabled: true },
      abort: { id: 'abort', label: '终止', hint: '停止后续分片', enabled: false, disabledReason: '没有正在运行的任务' },
    };
    await settle(panel);
    const events: string[] = [];
    panel.addEventListener('p2b-graph-run', (event) => events.push((event as CustomEvent<string>).detail));
    const run = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-run="run-all"]');
    expect(run?.disabled).toBe(false);
    run?.click();
    expect(events).toEqual(['run-all']);
    expect(panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-run="abort"]')?.disabled).toBe(true);
  });

  it('当前存档损坏时显示原因并可导出原文，不偷偷回退旧存档', async () => {
    const broken = await mountWith({
      current: '{"format":"pwn2block.graph-save","version":99}',
      interim: JSON.stringify(feedGraph()),
    });
    await settle(broken.panel);
    const text = broken.panel.shadowRoot?.textContent ?? '';
    expect(text).toContain('导出原文');
    expect(text).toContain('从空白画布开始');
    expect(canvasOf(broken.panel)?.shadowRoot?.querySelector('[data-node="run"]')).toBeNull();
  });
});

describe('画布面板：编译轨迹', () => {
  it('显示分支选择，点一条可定位回容器节点', async () => {
    const graph = workflow({
      nodes: [
        wfNode('if', NODE.if, { branches: 0 }, { then: ['step'] }),
        wfNode('cond', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        wfNode('step', NODE.step, { count: 1 }),
      ],
      edges: [wfEdge('cond', 'if', 'cond')],
      main: ['if'],
    });
    const { panel } = await mount(graph);
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[part="compile"]')?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.textContent ?? '').toContain('编译轨迹');
    });
    const traceButton = panel.shadowRoot?.querySelector<HTMLButtonElement>('details.trace button.link');
    expect(traceButton).not.toBeNull();
    traceButton?.click();
    await settle(panel);
    expect(panel.shadowRoot?.querySelector('header')?.textContent ?? '').toContain('主图');
  });
});

describe('画布面板：编译', () => {
  it('编译成功显示动作数，并把预览交给画布', async () => {
    const { panel } = await mount(feedGraph());
    const compile = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[part="compile"]');
    expect(compile).not.toBeNull();
    compile?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.textContent ?? '').toContain('编译成功：1 个动作');
    });
    const canvas = panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
    expect(canvas?.shadowRoot?.textContent ?? '').toContain('41414141');
  });

  it('编译失败列出问题节点，不显示动作数', async () => {
    const broken = workflow({
      nodes: [wfNode('write', NODE.write)],
      edges: [],
      main: ['write'],
    });
    const { panel } = await mount(broken);
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[part="compile"]')?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.textContent ?? '').toContain('编译失败');
    });
    const text = panel.shadowRoot?.textContent ?? '';
    expect(text).toContain('编译失败');
    expect(text).toContain('本题不允许动作');
    expect(text).toContain('write');
  });

  it('改图后状态提示需要重新编译', async () => {
    const { panel } = await mount(feedGraph());
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[part="compile"]')?.click();
    await vi.waitFor(() => {
      expect(panel.shadowRoot?.textContent ?? '').toContain('编译成功');
    });
    libraryButton(panel, 'data.fill')?.click();
    await settle(panel);
    // 加了节点但没编译：状态行仍写上次结果，另外用红色标记过期。
    const header = panel.shadowRoot?.querySelector('header');
    expect(header?.querySelector('.bad')).not.toBeNull();
  });
});

describe('画布面板：把产物交给运行链路', () => {
  it('编译成功后派发 p2b-graph-compiled，来源用节点 id', async () => {
    const { panel } = await mount(feedGraph());
    const events: { actions: readonly { type: string }[]; origins: readonly { index: number; blockId: string }[] }[] = [];
    panel.addEventListener('p2b-graph-compiled', (event) =>
      events.push((event as CustomEvent<(typeof events)[number]>).detail),
    );
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[part="compile"]')?.click();
    await vi.waitFor(() => {
      expect(events.length).toBe(1);
    });
    expect(events[0]?.actions).toEqual([{ type: 'run', maxSteps: 100 }]);
    expect(events[0]?.origins[0]?.blockId).toBe('run');
  });

  it('语义编辑派发 p2b-graph-edited，纯布局编辑不派发', async () => {
    const { panel } = await mount();
    let edited = 0;
    panel.addEventListener('p2b-graph-edited', () => {
      edited += 1;
    });
    libraryButton(panel, 'data.fill')?.click();
    await settle(panel);
    expect(edited).toBe(1);
  });
});

describe('画布面板：模块列表', () => {
  const moduleDoc = {
    ...workflow({ nodes: [wfNode('run', NODE.run, { maxSteps: 10 })], edges: [], main: ['run'] }),
    modules: [
      {
        id: 'inc',
        name: '自增',
        summary: '',
        kind: 'data',
        version: 2,
        inputs: [{ name: 'a', type: 'int' }],
        output: { name: 'out', type: 'int' },
        nodes: [wfNode('get', NODE.varGet, { name: 'a', type: 'int' })],
        connections: [],
        main: ['get'],
        layout: {},
      },
    ],
  };

  it('列出已定义模块的版本与调用入口，点一下插入调用节点', async () => {
    const { panel } = await mount(moduleDoc);
    const button = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-module="inc"]');
    expect(button?.textContent ?? '').toContain('自增 v2');
    button?.click();
    await settle(panel);
    expect(canvasOf(panel)?.shadowRoot?.querySelector('[data-node="data"]')).not.toBeNull();
  });

  it('来源定位自动切进模块视图并选中节点', async () => {
    const { panel } = await mount(moduleDoc);
    panel.locate({ nodeId: 'get', modules: ['inc@2'] });
    await settle(panel);
    expect(panel.shadowRoot?.querySelector('header')?.textContent ?? '').toContain('自增 v2');
    expect(canvasOf(panel)?.shadowRoot?.querySelector('[data-node="get"]')).not.toBeNull();
    expect(canvasOf(panel)?.shadowRoot?.querySelector('.selected')?.getAttribute('data-node')).toBe('get');
  });

  it('进入模块体：面包屑显示模块名，编辑写回主图，返回后主图恢复', async () => {
    const { panel, store } = await mount(moduleDoc);
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-edit-module="inc"]')?.click();
    await settle(panel);
    const header = panel.shadowRoot?.querySelector('header');
    expect(header?.textContent ?? '').toContain('主图');
    expect(header?.textContent ?? '').toContain('自增 v2');

    const bodyCanvas = panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
    expect(bodyCanvas?.shadowRoot?.querySelector('[data-node="get"]')).not.toBeNull();
    expect(bodyCanvas?.shadowRoot?.querySelector('[data-node="run"]')).toBeNull();

    libraryButton(panel, 'data.fill')?.click();
    await settle(panel);
    const saved = JSON.parse(store.getItem(graphStorageKey(ret2winPublic.id)) ?? '{}') as {
      document?: { modules?: { nodes?: { kind: string }[] }[] };
    };
    expect(saved.document?.modules?.[0]?.nodes?.some((node) => node.kind === 'data.fill')).toBe(true);

    panel.shadowRoot?.querySelector<HTMLButtonElement>('button.crumb')?.click();
    await settle(panel);
    expect(canvasOf(panel)?.shadowRoot?.querySelector('[data-node="run"]')).not.toBeNull();
  });
});

describe('画布面板：来源定位后的编辑与动态参数', () => {
  it('定位主图节点后再编辑，改动写回当前图（不会卡在模块视图的主图副本上）', async () => {
    const { panel } = await mount(feedGraph());
    panel.locate({ nodeId: 'hex' });
    await settle(panel);
    const input = inspectorInput(panel, 'hex-hex');
    expect(input).not.toBeNull();
    input!.value = '42';
    input!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);
    expect(panel.currentDocument().nodes.find((node) => node.id === 'hex')?.params.hex).toBe('42');
    expect(panel.shadowRoot?.querySelector('header')?.textContent ?? '').not.toContain(' / ');
  });

  it('题目积木的动态输入在检查器里可手填，且按字节串保存（全数字也仍是十六进制）', async () => {
    const { panel } = await mount();
    libraryButton(panel, 'action.author')?.click();
    await settle(panel);
    const id = panel.currentDocument().nodes.find((node) => node.kind === 'action.author')?.id;
    if (id === undefined) throw new Error('没有 author 节点');

    const block = inspectorInput(panel, `${id}-id`);
    expect(block).not.toBeNull();
    block!.value = 'gets';
    block!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);

    const data = inspectorInput(panel, `${id}-data`);
    expect(data).not.toBeNull();
    data!.value = '4141';
    data!.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);

    const params = panel.currentDocument().nodes.find((node) => node.id === id)?.params;
    expect(params).toMatchObject({ id: 'gets', data: '4141', dataMode: 'inline' });
  });
});
