// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { nearestLogicSnap } from '../src/canvas/logic-editor';
import type { LogicCanvasElement } from '../src/components/logic-canvas';
import { canvasV2StorageKey, makeCanvasSave, parseCanvasSave, type CanvasStore } from '../src/canvas/save';

const mounted: CanvasPanelElement[] = [];
class Store implements CanvasStore {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
    return true;
  }
  removeItem(key: string) {
    return this.map.delete(key);
  }
}
async function mount(store = new Store()) {
  const panel = new CanvasPanelElement();
  panel.challenge = ret2winPublic;
  panel.store = store;
  document.body.append(panel);
  mounted.push(panel);
  await settle(panel);
  return { panel, store };
}
async function settle(panel: CanvasPanelElement) {
  await panel.updateComplete;
  await panel.updateComplete;
  await child(panel)?.updateComplete;
}
function child(panel: CanvasPanelElement) {
  return panel.shadowRoot?.querySelector<LogicCanvasElement>('pwn2block-logic-canvas');
}
function button(panel: CanvasPanelElement, text: string) {
  const found = [...(child(panel)?.shadowRoot?.querySelectorAll('button') ?? [])].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === text,
  );
  if (!found) throw new Error(`缺少按钮 ${text}`);
  return found;
}
afterEach(() => {
  for (const panel of mounted.splice(0)) panel.remove();
  vi.useRealTimers();
});

describe('逻辑画布面板：应用契约与实际编辑入口', () => {
  it('默认唯一开始，只提供五种常量、变量、转换和流程方法', async () => {
    const { panel } = await mount();
    expect(panel.document?.logic?.nodes.map((n) => n.kind)).toEqual(['start']);
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 常量').click();
    await settle(panel);
    const ui = child(panel)!;
    expect(panel.document?.logic?.nodes).toHaveLength(2);
    expect(
      [...ui.shadowRoot!.querySelectorAll('select[aria-label="数据类型"] option')].map((o) => o.textContent),
    ).toEqual(['int', 'double', 'string', 'bytes', 'bool']);
    expect(ui.shadowRoot!.querySelectorAll('[data-kind="start"]')).toHaveLength(1);
    expect(ui.shadowRoot!.textContent).not.toContain('组成列表');
  });
  it('变量属性只有名称，值类型不再作为预设属性', async () => {
    const { panel } = await mount();
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 变量').click();
    await settle(panel);
    const inspector = child(panel)!.shadowRoot!.querySelector('.inspector')!;
    expect(inspector.querySelector('[aria-label="名称"]')).not.toBeNull();
    expect(inspector.querySelector('[aria-label="数据类型"]')).toBeNull();
  });
  it('连接小框选中后在右栏切换运算符，撤销/重做整条修改', async () => {
    const { panel } = await mount();
    const doc = canvas.newLogicDocument();
    panel.setDocument({
      ...doc,
      logic: {
        version: 1,
        nodes: [
          ...doc.logic!.nodes,
          { id: 'a', kind: 'constant', value: { type: 'int', text: '2' }, x: 50, y: 200 },
          { id: 'b', kind: 'constant', value: { type: 'int', text: '3' }, x: 298, y: 200 },
        ],
        edges: [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }],
      },
    });
    await settle(panel);
    const root = child(panel)!.shadowRoot!;
    root.querySelector('.relation')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await child(panel)!.updateComplete;
    const select = root.querySelector<HTMLSelectElement>('[aria-label="关系"]')!;
    expect(select.value).toBe('+');
    select.value = '*';
    select.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document!.logic!.edges[0]).toMatchObject({ op: '*' });
    button(panel, '撤销').click();
    await settle(panel);
    expect(panel.document!.logic!.edges[0]).toMatchObject({ op: '+' });
    expect(select.value).toBe('+');
    button(panel, '重做').click();
    await settle(panel);
    expect(panel.document!.logic!.edges[0]).toMatchObject({ op: '*' });
  });
  it('更改、编译与运行沿用外壳事件，导出可校验并恢复', async () => {
    const { panel } = await mount();
    const changed = vi.fn(),
      compiled = vi.fn(),
      run = vi.fn();
    panel.addEventListener('p2b-canvas-changed', changed);
    panel.addEventListener('p2b-canvas-compiled', compiled);
    panel.addEventListener('p2b-canvas-run', run);
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 常量').click();
    await settle(panel);
    button(panel, '运行').click();
    expect(changed).toHaveBeenCalledOnce();
    expect(compiled).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    expect(parseCanvasSave(JSON.parse(panel.exportSave()), ret2winPublic.id)).toMatchObject({
      ok: true,
      save: { document: panel.document },
    });
  });
  it('错误阻止运行且可定位到节点或连接', async () => {
    const { panel } = await mount();
    const doc = canvas.newLogicDocument();
    panel.setDocument({
      ...doc,
      logic: {
        version: 1,
        nodes: [...doc.logic!.nodes, { id: 'branch', kind: 'branch', x: 300, y: 100 }],
        edges: [{ id: 'go', kind: 'flow', from: 'start', to: 'branch', outlet: 'next' }],
      },
    });
    await settle(panel);
    expect(button(panel, '运行').disabled).toBe(true);
    expect(panel.focusIssue()).toBe(true);
    await child(panel)!.updateComplete;
    expect(
      child(panel)!.shadowRoot!.querySelector('[data-node="branch"]')?.classList.contains('selected'),
    ).toBe(true);
  });
  it('旧模型原文不被新模型自动覆盖', async () => {
    const store = new Store(),
      raw = JSON.stringify(makeCanvasSave(ret2winPublic.id, canvas.emptyCanvasDocument()));
    store.setItem(canvasV2StorageKey(ret2winPublic.id), raw);
    const { panel } = await mount(store);
    expect(panel.shadowRoot?.textContent).toContain('原文已保留');
    expect(child(panel)).toBeNull();
    panel.remove();
    expect(store.getItem(canvasV2StorageKey(ret2winPublic.id))).toBe(raw);
    expect(panel.exportSave()).toBe(raw);
  });
  it('自动保存与切题互不串档，切换前先保存原题', async () => {
    const { panel, store } = await mount();
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 常量').click();
    await settle(panel);
    const old = panel.document;
    panel.challenge = { ...ret2winPublic, id: 'other' };
    await settle(panel);
    expect(JSON.parse(store.getItem(canvasV2StorageKey(ret2winPublic.id))!).document).toEqual(old);
    expect(panel.document?.logic?.nodes).toHaveLength(1);
    panel.remove();
    expect(JSON.parse(store.getItem(canvasV2StorageKey('other'))!).document.logic.nodes).toHaveLength(1);
  });
});

function constantDocument(id: string): canvas.CanvasDocument {
  const doc = canvas.newLogicDocument();
  return {
    ...doc,
    logic: {
      ...doc.logic!,
      nodes: [
        ...doc.logic!.nodes,
        { id, kind: 'constant', value: { type: 'int', text: '42' }, x: 400, y: 300 },
      ],
    },
  };
}
function selectOf(panel: CanvasPanelElement, label: string): HTMLSelectElement {
  const select = child(panel)!.shadowRoot!.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!select) throw new Error(`缺少下拉框 ${label}`);
  return select;
}
function pendingImport(panel: CanvasPanelElement) {
  let resolve!: (raw: string) => void;
  let reject!: (error: Error) => void;
  const read = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const file = new File(['{}'], 'canvas.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: () => read });
  const input = panel.shadowRoot!.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  input.dispatchEvent(new Event('change'));
  return {
    async complete(raw: unknown) {
      resolve(JSON.stringify(raw));
      await Promise.resolve();
      await settle(panel);
    },
    async fail() {
      reject(new Error('读取失败'));
      await Promise.resolve();
      await settle(panel);
    },
  };
}

describe('属性选项与文档同步', () => {
  it('新建转换显示 bytes 和 8，修改与撤销同步选项', async () => {
    const { panel } = await mount();
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 类型转换').click();
    await settle(panel);
    const target = selectOf(panel, '转换为'),
      width = selectOf(panel, '字节宽度');
    expect(target.value).toBe('bytes');
    expect(width.value).toBe('8');
    target.value = 'int';
    target.dispatchEvent(new Event('change'));
    await settle(panel);
    width.value = '1';
    width.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document!.logic!.nodes.find((n) => n.kind === 'convert')).toMatchObject({
      target: 'int',
      width: '1',
    });
    button(panel, '撤销').click();
    await settle(panel);
    expect(width.value).toBe('8');
    button(panel, '撤销').click();
    await settle(panel);
    expect(target.value).toBe('bytes');
  });
  it('选中存档中的非首项类型时显示真实类型', async () => {
    const { panel } = await mount();
    const doc = canvas.newLogicDocument();
    panel.setDocument({
      ...doc,
      logic: {
        ...doc.logic!,
        nodes: [
          ...doc.logic!.nodes,
          { id: 'text', kind: 'constant', value: { type: 'string', text: 'hello' }, x: 400, y: 300 },
        ],
      },
    });
    await settle(panel);
    panel.locate('text');
    await settle(panel);
    expect(selectOf(panel, '数据类型').value).toBe('string');
  });
  it('引用端口首次显示第二个参数，撤销后恢复该端口', async () => {
    const { panel } = await mount();
    const doc = constantDocument('value');
    panel.challenge = {
      ...ret2winPublic,
      authorBlocks: [
        {
          id: 'two_params',
          label: '两个参数',
          params: [
            { name: 'first', type: 'int' },
            { name: 'second', type: 'int' },
          ],
          expand: [{ type: 'step', count: 1 }],
        },
      ],
    };
    panel.setDocument({
      ...doc,
      logic: {
        ...doc.logic!,
        nodes: [...doc.logic!.nodes, { id: 'method', kind: 'method', method: 'two_params', x: 700, y: 300 }],
        edges: [{ id: 'ref', kind: 'reference', from: 'value', to: 'method', port: 'second' }],
      },
    });
    await settle(panel);
    panel.locate('ref');
    await settle(panel);
    const select = selectOf(panel, '引用端口');
    expect(select.value).toBe('second');
    select.value = 'first';
    select.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document!.logic!.edges[0]).toMatchObject({ port: 'first' });
    button(panel, '撤销').click();
    await settle(panel);
    expect(select.value).toBe('second');
  });
  it('连接目标在属性栏重建后仍显示，选中目标本身时禁用连接', async () => {
    const { panel } = await mount();
    const doc = constantDocument('a');
    panel.setDocument({
      ...doc,
      logic: {
        ...doc.logic!,
        nodes: [
          ...doc.logic!.nodes,
          { id: 'b', kind: 'constant', value: { type: 'int', text: '2' }, x: 650, y: 300 },
        ],
        edges: [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }],
      },
    });
    await settle(panel);
    panel.locate('a');
    await settle(panel);
    const target = selectOf(panel, '连接到');
    target.value = 'b';
    target.dispatchEvent(new Event('change'));
    await settle(panel);
    panel.locate('ab');
    await settle(panel);
    panel.locate('a');
    await settle(panel);
    expect(selectOf(panel, '连接到').value).toBe('b');
    panel.locate('b');
    await settle(panel);
    expect(selectOf(panel, '连接到').value).toBe('');
    expect(button(panel, '建立连接').disabled).toBe(true);
  });
});

describe('异步导入的所属文档', () => {
  it.each(['bare', 'save'])('未切换上下文时正常导入并保存：%s', async (format) => {
    const { panel, store } = await mount(),
      doc = constantDocument('imported');
    await pendingImport(panel).complete(format === 'bare' ? doc : makeCanvasSave(ret2winPublic.id, doc));
    expect(panel.document).toEqual(doc);
    expect(JSON.parse(store.getItem(canvasV2StorageKey(ret2winPublic.id))!).document).toEqual(doc);
  });
  it('裸文档读取期间切题，不覆盖新题文档及其存档', async () => {
    const store = new Store(),
      other = constantDocument('saved-other');
    store.setItem(canvasV2StorageKey('other'), JSON.stringify(makeCanvasSave('other', other)));
    const { panel } = await mount(store),
      pending = pendingImport(panel);
    panel.challenge = { ...ret2winPublic, id: 'other' };
    await settle(panel);
    await pending.complete(constantDocument('imported-for-first'));
    expect(panel.document).toEqual(other);
    expect(JSON.parse(store.getItem(canvasV2StorageKey('other'))!).document).toEqual(other);
  });
  it('读取期间发生编辑，不覆盖后续编辑', async () => {
    const { panel } = await mount(),
      pending = pendingImport(panel);
    child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')?.click();
    await settle(panel);
    button(panel, '+ 变量').click();
    await settle(panel);
    const edited = panel.document;
    await pending.complete(constantDocument('stale'));
    expect(panel.document).toEqual(edited);
  });
  it.each(['旧请求先完成', '新请求先完成'])('重新导入使前一次读取失效：%s', async (order) => {
    const { panel } = await mount(),
      first = pendingImport(panel),
      second = pendingImport(panel);
    const original = panel.document,
      latest = constantDocument('latest');
    if (order === '旧请求先完成') {
      await first.complete(constantDocument('stale'));
      expect(panel.document).toEqual(original);
      await second.complete(latest);
    } else {
      await second.complete(latest);
      expect(panel.document).toEqual(latest);
      await first.complete(constantDocument('stale'));
    }
    expect(panel.document).toEqual(latest);
  });
  it('面板卸载后，读取完成不会写入存档', async () => {
    const { panel, store } = await mount(),
      pending = pendingImport(panel);
    panel.remove();
    const saved = store.getItem(canvasV2StorageKey(ret2winPublic.id));
    await pending.complete(constantDocument('stale'));
    expect(store.getItem(canvasV2StorageKey(ret2winPublic.id))).toBe(saved);
  });
  it('切题后旧读取失败，不向新题显示错误', async () => {
    const { panel } = await mount(),
      pending = pendingImport(panel);
    panel.challenge = { ...ret2winPublic, id: 'other' };
    await settle(panel);
    await pending.fail();
    expect(panel.shadowRoot!.querySelector('.notice')).toBeNull();
  });
});

describe('属性栏和吸附共用附着规则', () => {
  it.each(['convert', 'loop'] as const)('已有无关错误仍允许合法附着、解除和撤销：%s', async (kind) => {
    const { panel } = await mount(),
      doc = canvas.newLogicDocument();
    const constant = (id: string, x: number, y: number): canvas.LogicNode => ({
      id,
      kind: 'constant',
      value: { type: 'int', text: '2' },
      x,
      y,
    });
    const attachment: canvas.LogicNode =
      kind === 'convert'
        ? {
            id: 'attach',
            kind,
            value: { type: 'int', text: '0' },
            target: 'bytes',
            width: '8',
            endian: 'little',
            signed: false,
            x: 730,
            y: 600,
          }
        : { id: 'attach', kind, count: '1', x: 730, y: 600 };
    panel.setDocument({
      ...doc,
      logic: {
        version: 1,
        nodes: [
          ...doc.logic!.nodes,
          constant('a', 100, 250),
          constant('b', 350, 250),
          kind === 'convert'
            ? constant('member', 500, 600)
            : { id: 'member', kind: 'method', method: 'm', x: 500, y: 600 },
          {
            id: 'env',
            kind: 'envelope',
            category: kind === 'convert' ? 'data' : 'flow',
            title: '包络',
            members: ['member'],
            x: 500,
            y: 600,
          },
          attachment,
        ],
        edges: [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: 'assign' }],
      },
    });
    await settle(panel);
    const graph = panel.document!.logic!,
      snap = nearestLogicSnap(graph, 'attach', []);
    expect(snap?.attachment).toBe('attach');
    panel.locate('attach');
    await settle(panel);
    const select = selectOf(panel, '附着包络');
    select.value = 'env';
    select.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document!.logic).toEqual(snap!.graph);
    expect(select.value).toBe('env');
    expect(canvas.validateLogicGraph(panel.document!.logic!)).toEqual(canvas.validateLogicGraph(graph));
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document!.logic).toEqual(graph);
    button(panel, '撤销').click();
    await settle(panel);
    expect(selectOf(panel, '附着包络').value).toBe('env');
  });
});

describe('图替换后的选择状态', () => {
  it.each(['节点', '连接'])('外部导入移除所选%s后清空属性提示和删除状态', async (kind) => {
    const { panel } = await mount(),
      doc = constantDocument('a');
    panel.setDocument({
      ...doc,
      logic: {
        ...doc.logic!,
        nodes: [
          ...doc.logic!.nodes,
          { id: 'b', kind: 'constant', value: { type: 'int', text: '1' }, x: 700, y: 300 },
        ],
        edges: [{ id: 'ab', kind: 'data', from: 'a', to: 'b', op: '+' }],
      },
    });
    await settle(panel);
    panel.locate(kind === '节点' ? 'a' : 'ab');
    await settle(panel);
    expect(button(panel, '删除').disabled).toBe(false);
    await pendingImport(panel).complete(canvas.newLogicDocument());
    expect(child(panel)!.shadowRoot!.querySelector('.inspector')!.textContent).toContain(
      '点击节点或连接编辑属性',
    );
    expect(button(panel, '删除').disabled).toBe(true);
  });
});

describe('非法附着保留原图和表单值', () => {
  it.each(['convert', 'loop'] as const)('重复附着被拒绝，选择恢复为未附着：%s', async (kind) => {
    const { panel } = await mount(),
      doc = canvas.newLogicDocument();
    const attachment: canvas.LogicNode =
      kind === 'convert'
        ? {
            id: 'attach',
            kind,
            value: { type: 'int', text: '0' },
            target: 'bytes',
            width: '8',
            endian: 'little',
            signed: false,
            x: 730,
            y: 600,
          }
        : { id: 'attach', kind, count: '1', x: 730, y: 600 };
    panel.setDocument({
      ...doc,
      logic: {
        version: 1,
        nodes: [
          ...doc.logic!.nodes,
          kind === 'convert'
            ? { id: 'member', kind: 'constant', value: { type: 'int', text: '1' }, x: 500, y: 600 }
            : { id: 'member', kind: 'method', method: 'm', x: 500, y: 600 },
          {
            id: 'env',
            kind: 'envelope',
            category: kind === 'convert' ? 'data' : 'flow',
            title: '包络',
            members: ['member'],
            x: 500,
            y: 600,
          },
          attachment,
          attachment.kind === 'convert'
            ? { ...attachment, id: 'occupied', input: 'env', x: 1400 }
            : { ...attachment, id: 'occupied', body: 'env', x: 1400 },
        ],
        edges: [],
      },
    });
    await settle(panel);
    panel.locate('attach');
    await settle(panel);
    const original = panel.document,
      graph = original!.logic!;
    expect(nearestLogicSnap(graph, 'attach', [])?.attachment).toBeUndefined();
    const select = selectOf(panel, '附着包络');
    select.value = 'env';
    select.dispatchEvent(new Event('change'));
    await settle(panel);
    expect(panel.document).toBe(original);
    expect(select.value).toBe('');
    expect(child(panel)!.shadowRoot!.querySelector('[role="status"]')!.textContent).toContain(
      '附着修改会产生新的结构错误',
    );
  });
});

it.each(['string', 'bytes'] as const)('selecting * repeats a %s fragment and survives undo/save', async (type) => {
  const { panel } = await mount();
  const doc = canvas.newLogicDocument();
  panel.setDocument({ ...doc, logic: { version: 1, nodes: [
    ...doc.logic!.nodes,
    { id: 'fragment', kind: 'constant', value: { type, text: 'ab' }, x: 50, y: 200 },
    { id: 'count', kind: 'constant', value: { type: 'int', text: '3' }, x: 298, y: 200 },
  ], edges: [{ id: 'repeat', kind: 'data', from: 'fragment', to: 'count', op: '+' }] } });
  await settle(panel);
  const root = child(panel)!.shadowRoot!;
  root.querySelector('.relation')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await child(panel)!.updateComplete;
  const select = root.querySelector<HTMLSelectElement>('[aria-label="关系"]')!;
  expect(select.querySelector('option[value="*"]')!.textContent).toContain('重复');
  select.value = '*';
  select.dispatchEvent(new Event('change'));
  await settle(panel);
  const expected = type === 'string' ? { kind: 'string', value: 'ababab' }
    : { kind: 'byte', bytes: new Uint8Array([0xab, 0xab, 0xab]) };
  expect(canvas.previewLogicGraph(panel.document!.logic!).get('count')).toEqual(expected);
  button(panel, '撤销').click();
  await settle(panel);
  expect(panel.document!.logic!.edges[0]).toMatchObject({ op: '+' });
  button(panel, '重做').click();
  await settle(panel);
  const loaded = parseCanvasSave(JSON.parse(panel.exportSave()), ret2winPublic.id);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error('save failed');
  expect(canvas.previewLogicGraph(loaded.save.document.logic!).get('count')).toEqual(expected);
});

it('shows a bytes literal independently from the connected expression result', async () => {
  const { panel } = await mount();
  const doc = canvas.newLogicDocument();
  panel.setDocument({ ...doc, logic: { version: 1, nodes: [
    ...doc.logic!.nodes,
    { id: 'prefix', kind: 'constant', value: { type: 'bytes', text: '2f62696e2f7368' }, x: 50, y: 200 },
    { id: 'zero', kind: 'constant', value: { type: 'bytes', text: '00' }, x: 318, y: 200 },
  ], edges: [{ id: 'concat', kind: 'data', from: 'prefix', to: 'zero', op: '+' }] } });
  await settle(panel);
  panel.locate('zero');
  await settle(panel);
  const root = child(panel)!.shadowRoot!;
  expect(root.querySelector<HTMLTextAreaElement>('textarea[aria-label="值"]')!.value).toBe('00');
  expect(root.querySelector('[data-node="zero"] .node-summary')!.textContent).toBe('bytes 00');
  expect(root.querySelector('.inspector')!.textContent).toContain('2f 62 69 6e 2f 73 68 00');
});

it('wheel zoom keeps the world point beneath the cursor stationary without changing the graph', async () => {
  const { panel } = await mount();
  const root = child(panel)!.shadowRoot!, stage = root.querySelector('.stage')!;
  const original = panel.document;
  const transformPattern = /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/;
  const initialMatch = transformPattern.exec((root.querySelector('.surface') as HTMLElement).style.transform);
  expect(initialMatch).not.toBeNull();
  const initialX = Number(initialMatch![1]), initialY = Number(initialMatch![2]), initialScale = Number(initialMatch![3]);
  const worldX = (200 - initialX) / initialScale, worldY = (150 - initialY) / initialScale;
  stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 200, clientY: 150, bubbles: true, cancelable: true }));
  await settle(panel);
  const transform = (root.querySelector('.surface') as HTMLElement).style.transform;
  const match = transformPattern.exec(transform);
  expect(match).not.toBeNull();
  const [, x, y, scale] = match!;
  expect(Number(scale)).toBeGreaterThan(initialScale);
  expect(Number(x) + worldX * Number(scale)).toBeCloseTo(200);
  expect(Number(y) + worldY * Number(scale)).toBeCloseTo(150);
  expect(panel.document).toBe(original);
});

it('new envelopes display their unique name and support rename, undo and save', async () => {
  const { panel } = await mount();
  child(panel)!.shadowRoot!.querySelector<HTMLButtonElement>('[data-category="data"]')!.click();
  await settle(panel);
  button(panel, '+ 常量').click();
  await settle(panel);
  button(panel, '包络').click();
  await settle(panel);
  const envelope = panel.document!.logic!.nodes.find((n) => n.kind === 'envelope')!;
  expect(envelope).toMatchObject({ title: envelope.id });
  panel.locate(envelope.id);
  await settle(panel);
  const root = child(panel)!.shadowRoot!;
  expect(root.querySelector('.envelope-title')!.textContent).toContain(envelope.id);
  const input = root.querySelector<HTMLInputElement>('[aria-label="包络名称"]')!;
  input.value = 'payload';
  input.dispatchEvent(new Event('change'));
  await settle(panel);
  expect(root.querySelector('.envelope-title')!.textContent).toContain('payload');
  button(panel, '撤销').click();
  await settle(panel);
  expect(input.value).toBe(envelope.id);
  button(panel, '重做').click();
  await settle(panel);
  expect(parseCanvasSave(JSON.parse(panel.exportSave()), ret2winPublic.id)).toMatchObject({ ok: true,
    save: { document: { logic: { nodes: expect.arrayContaining([expect.objectContaining({ id: envelope.id, title: 'payload' })]) } } } });
});
