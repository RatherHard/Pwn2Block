// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { CANVAS_CATALOG, CANVAS_CATEGORY_LABELS } from '../src/canvas/catalog';
import { canvasV2StorageKey, makeCanvasSave, parseCanvasSave } from '../src/canvas/save';
import type { CanvasStore } from '../src/canvas/save';

/**
 * 画布面板：加载、存档、事件契约、顶栏计数与公开方法。
 *
 * 交互（拖动、接线、就地编辑）的用例在 `canvas-panel-interaction.test.ts`；这里只管
 * 「面板对外说得对不对」——渲染出什么、发什么事件、存什么档。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

class MemoryStore implements CanvasStore {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): boolean {
    this.values.set(key, value);
    return true;
  }

  removeItem(key: string): boolean {
    return this.values.delete(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

const CHALLENGE: PublicChallenge = ret2winPublic;
const KEY = canvasV2StorageKey(CHALLENGE.id);
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };

function documentOf(options: {
  readonly nodes: readonly canvas.CanvasNode[];
  readonly main?: readonly string[];
  readonly layout?: Readonly<Record<string, canvas.CanvasNodeLayout>>;
}): canvas.CanvasDocument {
  return {
    ...canvas.emptyCanvasDocument(),
    nodes: options.nodes,
    layout: options.layout ?? {},
    main: options.main ?? [],
  };
}

function valueNode(id: string, value: canvas.EncodedScalarValue): canvas.ValueNode {
  return { id, kind: 'value', value };
}

function relationNode(id: string, op: canvas.BinaryOperator): canvas.RelationNode {
  return { id, kind: 'relation', op, left: '', right: '' };
}

function createPanel(): CanvasPanelElement {
  const element = document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  return element;
}

async function mount(options: { readonly store?: CanvasStore; readonly doc?: canvas.CanvasDocument } = {}): Promise<CanvasPanelElement> {
  const panel = createPanel();
  panel.challenge = CHALLENGE;
  if (options.store !== undefined) panel.store = options.store;
  if (options.doc !== undefined) panel.document = options.doc;
  document.body.append(panel);
  panels.push(panel);
  await panel.updateComplete;
  return panel;
}

async function settle(panel: CanvasPanelElement): Promise<void> {
  await panel.updateComplete;
  await Promise.resolve();
  await panel.updateComplete;
}

function rootOf(panel: CanvasPanelElement): ShadowRoot {
  const root = panel.shadowRoot;
  if (root === null) throw new Error('面板没有影子根');
  return root;
}

function textOf(panel: CanvasPanelElement, selector: string): string {
  const element = rootOf(panel).querySelector(selector);
  if (element === null) throw new Error(`找不到 ${selector}`);
  return element.textContent?.trim() ?? '';
}

function buttonOf(panel: CanvasPanelElement, selector: string): HTMLButtonElement {
  const element = rootOf(panel).querySelector(selector);
  if (!(element instanceof HTMLButtonElement)) throw new Error(`${selector} 不是按钮`);
  return element;
}

/** 记录某个事件 detail 的序列（不管类型，断言交给 `toMatchObject`）。 */
function record(panel: CanvasPanelElement, name: string): unknown[] {
  const details: unknown[] = [];
  panel.addEventListener(name, (event) => {
    if (event instanceof CustomEvent) details.push(event.detail);
  });
  return details;
}

afterEach(() => {
  vi.useRealTimers();
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

describe('画布面板：加载', () => {
  it('没有存档时给一份只有开始节点的文档', async () => {
    const panel = await mount();
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start']);
    expect(rootOf(panel).querySelectorAll('.node-box')).toHaveLength(1);
    expect(textOf(panel, '.node-box .title')).toBe('开始');
  });

  it('读到存档就用存档里的文档，不覆盖它', async () => {
    const store = new MemoryStore();
    const saved = documentOf({
      nodes: [START, valueNode('v1', { kind: 'int', value: '7' })],
      main: ['start'],
      layout: { v1: { x: 40, y: 40 } },
    });
    store.setItem(KEY, JSON.stringify(makeCanvasSave(CHALLENGE.id, saved)));
    const panel = await mount({ store });
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start', 'v1']);
    expect(rootOf(panel).querySelectorAll('.node-box')).toHaveLength(2);
  });

  it('存档坏掉时退回新文档，且不谎报旧存档', async () => {
    const store = new MemoryStore();
    store.setItem(KEY, '{ 这不是 JSON');
    const panel = createPanel();
    panel.challenge = CHALLENGE;
    panel.store = store;
    const legacy: unknown[] = [];
    panel.addEventListener('p2b-canvas-legacy', (event) => {
      if (event instanceof CustomEvent) legacy.push(event.detail);
    });
    document.body.append(panel);
    panels.push(panel);
    await panel.updateComplete;
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start']);
    expect(legacy).toHaveLength(0);
  });

  it('读到旧工作流存档时发 p2b-canvas-legacy，并保留原文', async () => {
    const store = new MemoryStore();
    const raw = JSON.stringify({ format: canvas.LEGACY_WORKFLOW_FORMAT, version: 1, challengeId: CHALLENGE.id, graph: {} });
    store.setItem(KEY, raw);
    const panel = createPanel();
    panel.challenge = CHALLENGE;
    panel.store = store;
    const legacy = record(panel, 'p2b-canvas-legacy');
    document.body.append(panel);
    panels.push(panel);
    await panel.updateComplete;
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ legacy: { reason: 'legacy', raw: expect.stringContaining('pwn2block.workflow') } });
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it('加载就发一次 changed，修订号从 1 开始', async () => {
    const panel = createPanel();
    panel.challenge = CHALLENGE;
    const changed = record(panel, 'p2b-canvas-changed');
    document.body.append(panel);
    panels.push(panel);
    await panel.updateComplete;
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ revision: 1 });
    expect(panel.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 工具箱与顶栏
// ---------------------------------------------------------------------------

describe('画布面板：工具箱与计数', () => {
  it('工具箱顺序与目录一致，一个不差', async () => {
    const panel = await mount();
    const kinds = [...rootOf(panel).querySelectorAll('.tool')].map((element) => element.getAttribute('data-kind'));
    expect(kinds).toEqual(CANVAS_CATALOG.map((spec) => spec.kind));
  });

  it('工具箱按分类分组，组序是分类第一次出现的顺序', async () => {
    const panel = await mount();
    const categories = [...rootOf(panel).querySelectorAll('.toolbox-group')].map((element) =>
      element.getAttribute('data-category'),
    );
    expect(categories).toEqual([...new Set(CANVAS_CATALOG.map((spec) => spec.category))]);
    const first = rootOf(panel).querySelector('.toolbox-group h3');
    expect(first?.textContent).toBe(CANVAS_CATEGORY_LABELS[CANVAS_CATALOG[0].category]);
  });

  it('点工具箱里的「值」会加一个节点并发 changed', async () => {
    const panel = await mount();
    const changed = record(panel, 'p2b-canvas-changed');
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    expect(changed).toHaveLength(1);
    expect(panel.document?.nodes).toHaveLength(2);
    expect(panel.revision).toBe(2);
    expect(changed[0]).toMatchObject({ revision: 2 });
  });

  it('未接线不算错误，单独计数', async () => {
    const panel = await mount({
      doc: documentOf({ nodes: [START, relationNode('r1', 'int.add')], main: ['start'] }),
    });
    expect(textOf(panel, '.status-error')).toBe('错误 0');
    expect(textOf(panel, '.status-unconnected')).toBe('未接线 2 处');
    expect(textOf(panel, '.status-revision')).toBe('修订 1');
  });

  it('未接线时运行只报失败，不发 run', async () => {
    const panel = await mount({
      doc: documentOf({ nodes: [START, relationNode('r1', 'int.add')], main: ['start'] }),
    });
    const runs = record(panel, 'p2b-canvas-run');
    const failures = record(panel, 'p2b-canvas-compile-failed');
    buttonOf(panel, '.btn-run').click();
    await settle(panel);
    expect(runs).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      errors: [{ code: 'missing_input', nodeId: 'r1' }, { code: 'missing_input', nodeId: 'r1' }],
    });
    expect(textOf(panel, '.message')).toContain('修好');
  });

  it('文档合法时运行发 p2b-canvas-run 并带上产物', async () => {
    const panel = await mount();
    const runs = record(panel, 'p2b-canvas-run');
    buttonOf(panel, '.btn-run').click();
    await settle(panel);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ artifact: { actions: expect.any(Array) } });
  });

  it('刚开始没有可撤销的东西，撤销按钮是禁用的', async () => {
    const panel = await mount();
    expect(buttonOf(panel, '.btn-undo').disabled).toBe(true);
    expect(buttonOf(panel, '.btn-redo').disabled).toBe(true);
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    expect(buttonOf(panel, '.btn-undo').disabled).toBe(false);
  });

  it('点关系方框换到下一种运算，方框文字跟着变', async () => {
    const panel = await mount({
      doc: documentOf({ nodes: [START, relationNode('r1', 'int.add')], main: ['start'] }),
    });
    const box = rootOf(panel).querySelector('[data-relation="r1"]');
    if (!(box instanceof HTMLElement)) throw new Error('没有关系方框');
    expect(box.textContent?.trim()).toBe(canvas.binaryOperatorSpec('int.add').symbol);
    box.click();
    await settle(panel);
    const node = panel.document?.nodes.find((item) => item.id === 'r1');
    expect(node?.kind).toBe('relation');
    if (node?.kind !== 'relation') throw new Error('r1 不是关系节点');
    expect(node.op).not.toBe('int.add');
    expect(box.textContent?.trim()).toBe(canvas.binaryOperatorSpec(node.op).symbol);
  });
});

// ---------------------------------------------------------------------------
// 存档
// ---------------------------------------------------------------------------

describe('画布面板：存档', () => {
  it('改动防抖 400ms 后才写一次存档', async () => {
    const store = new MemoryStore();
    const panel = await mount({ store });
    vi.useFakeTimers();
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    expect(store.has(KEY)).toBe(false);
    vi.advanceTimersByTime(399);
    expect(store.has(KEY)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(store.has(KEY)).toBe(true);
  });

  it('卸载时立刻保存，不等防抖', async () => {
    const store = new MemoryStore();
    const panel = await mount({ store });
    vi.useFakeTimers();
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    panel.remove();
    panels.pop();
    expect(store.has(KEY)).toBe(true);
  });

  it('exportSave 的结果能被 parseCanvasSave 读回', async () => {
    const panel = await mount();
    const parsed = parseCanvasSave(JSON.parse(panel.exportSave()), CHALLENGE.id);
    if (!parsed.ok) throw new Error(`存档读不回来：${parsed.message}`);
    expect(parsed.save.challengeId).toBe(CHALLENGE.id);
    expect(parsed.save.document.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it('setDocument 换文档、清历史、马上落盘', async () => {
    const store = new MemoryStore();
    const panel = await mount({ store });
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    expect(buttonOf(panel, '.btn-undo').disabled).toBe(false);
    const next = documentOf({
      nodes: [START, valueNode('v2', { kind: 'string', value: 'hi' })],
      main: ['start'],
      layout: { v2: { x: 40, y: 40 } },
    });
    panel.setDocument(next);
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start', 'v2']);
    expect(buttonOf(panel, '.btn-undo').disabled).toBe(true);
    expect(store.getItem(KEY)).toContain('"v2"');
    expect(panel.revision).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 公开方法
// ---------------------------------------------------------------------------

describe('画布面板：公开方法', () => {
  it('locate 给目标节点加高亮类', async () => {
    const panel = await mount();
    panel.locate('start');
    await settle(panel);
    expect(rootOf(panel).querySelectorAll('.node-box.selected')).toHaveLength(1);
  });

  it('locate 找不到节点就静默返回', async () => {
    const panel = await mount();
    expect(() => panel.locate('没有这个节点')).not.toThrow();
    await settle(panel);
    expect(rootOf(panel).querySelectorAll('.node-box.selected')).toHaveLength(0);
  });

  it('focusIssue 命中时跳到问题节点并高亮，未命中返回 false', async () => {
    const panel = await mount({
      doc: documentOf({ nodes: [START, relationNode('r1', 'int.add')], main: ['start'] }),
    });
    expect(panel.focusIssue('missing_input')).toBe(true);
    await settle(panel);
    expect(rootOf(panel).querySelector('[data-relation="r1"]')?.classList.contains('selected')).toBe(true);
    expect(panel.focusIssue('duplicate_id')).toBe(false);
  });

  it('没有问题时 focusIssue 返回 false', async () => {
    const panel = await mount();
    expect(panel.focusIssue()).toBe(false);
  });

  it('父组件直接替换 document 也算一次变化，历史随之作废', async () => {
    const panel = await mount();
    buttonOf(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    const before = panel.revision;
    const changes: unknown[] = [];
    panel.addEventListener('p2b-canvas-changed', (event) => changes.push(event));
    panel.document = documentOf({
      nodes: [START, valueNode('v9', { kind: 'int', value: '9' })],
      main: ['start'],
      layout: { v9: { x: 40, y: 40 } },
    });
    await settle(panel);
    expect(panel.revision).toBe(before + 1);
    expect(changes).toHaveLength(1);
    expect(buttonOf(panel, '.btn-undo').disabled).toBe(true);
  });
});
