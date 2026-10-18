// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE, ret2winPublic } from '@pwn2block/shared';
import type { Pwn2BlockGraphPanel } from '../src/components/graph-panel';
import '../src/components/graph-panel';
import type { KeyValueStore } from '../src/viewmodel/storage';
import { wfNode, workflow } from './workflow-helpers';

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
  const store = new MemoryStore();
  if (saved !== undefined) {
    store.setItem(`pwn2block.graph.${ret2winPublic.id}`, JSON.stringify(saved));
  }
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

describe('画布面板：工具箱与存档', () => {
  it('工具箱按阶段列出节点，点一下就加进画布', async () => {
    const { panel } = await mount();
    const buttons = panel.shadowRoot?.querySelectorAll('.toolbox button') ?? [];
    expect(buttons.length).toBeGreaterThan(10);
    const fill = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-kind="data.fill"]');
    expect(fill).not.toBeNull();
    fill?.click();
    await settle(panel);
    const canvas = panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
    expect(canvas?.shadowRoot?.querySelector('[data-node="fill"]')).not.toBeNull();
  });

  it('本地存档能恢复，坏存档退回空图而不是崩溃', async () => {
    const { panel } = await mount(feedGraph());
    const canvas = panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
    expect(canvas?.shadowRoot?.querySelector('[data-node="hex"]')).not.toBeNull();

    const broken = await mount({ format: 'pwn2block.workflow', version: 99, nodes: [] });
    const empty = broken.panel.shadowRoot?.querySelector('pwn2block-graph-canvas');
    expect(empty?.shadowRoot?.querySelector('[data-node="start"]')).not.toBeNull();
  });

  it('编辑后写回存档', async () => {
    const { panel, store } = await mount();
    const fill = panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-kind="data.fill"]');
    fill?.click();
    await settle(panel);
    const saved = store.getItem(`pwn2block.graph.${ret2winPublic.id}`);
    expect(saved).not.toBeNull();
    expect(saved ?? '').toContain('data.fill');
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
    panel.shadowRoot?.querySelector<HTMLButtonElement>('button[data-kind="data.fill"]')?.click();
    await settle(panel);
    // 加了节点但没编译：状态行仍写上次结果，另外用红色标记过期。
    const header = panel.shadowRoot?.querySelector('header');
    expect(header?.querySelector('.bad')).not.toBeNull();
  });
});
