// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { compileCanvas } from '../src/canvas/compile';
import { layoutCanvas } from '../src/canvas/view-model';
import type { CanvasLayoutView } from '../src/canvas/view-model';

/**
 * 字面值种类切换（侧栏下拉）的验收。
 *
 * 这条链路的判据是「一个入口、一份文档」：侧栏换种类与框里改内容最后都走 `editor.setValue`，
 * 文档一变，行文本、副标题与预览由视图模型重算，界面里没有第二处手写文案。
 *
 * 断言落在两处：
 * - `panel.document`：真正写进存档的形状（`{ kind: 'byte', hex: '' }` 这类）；
 * - `layoutCanvas(panel.document)`：用户看得见的那几行（「值」「预览」行与盒子副标题）。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];

const START: canvas.StartNode = { id: 'start', kind: 'start' };
const NODE_ID = 'v1';

function documentWith(value: canvas.EncodedScalarValue): canvas.CanvasDocument {
  return {
    ...canvas.emptyCanvasDocument(),
    nodes: [START, { id: NODE_ID, kind: 'value', value }],
    layout: { [NODE_ID]: { x: 40, y: 40 } },
    main: ['start'],
  };
}

async function mount(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const element = document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = CHALLENGE;
  element.document = doc;
  document.body.append(element);
  panels.push(element);
  await element.updateComplete;
  return element;
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

function currentDocument(panel: CanvasPanelElement): canvas.CanvasDocument {
  const current = panel.document;
  if (current === undefined) throw new Error('面板没有文档');
  return current;
}

/** 文档里那个字面值节点；种类不对时显式失败，不硬转。 */
function literalOf(panel: CanvasPanelElement): canvas.ValueNode {
  const node = currentDocument(panel).nodes.find((item) => item.id === NODE_ID);
  if (node === undefined || node.kind !== 'value') throw new Error('文档里没有字面值节点');
  return node;
}

function viewOf(panel: CanvasPanelElement): CanvasLayoutView {
  return layoutCanvas({ document: currentDocument(panel) });
}

/** 盒子里的某个行文本（「值」「预览」这类标签）。 */
function rowTextOf(view: CanvasLayoutView, label: string): string {
  const row = (view.rowsByNode.get(NODE_ID) ?? []).find((item) => item.label === label);
  if (row === undefined) throw new Error(`没有「${label}」行`);
  return row.value;
}

/** 盒子副标题：字面值节点的副标题就是当前种类的中文名。 */
function subtitleOf(view: CanvasLayoutView): string | undefined {
  return view.boxes.find((box) => box.nodeId === NODE_ID)?.subtitle;
}

function clickNode(panel: CanvasPanelElement): void {
  const found = rootOf(panel).querySelector(`.node-box[data-node="${NODE_ID}"]`);
  if (!(found instanceof HTMLElement)) throw new Error('找不到字面值节点');
  found.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0, bubbles: true, button: 0 }));
  window.dispatchEvent(new MouseEvent('pointerup', { clientX: 0, clientY: 0, bubbles: true, button: 0 }));
}

/** 侧栏里的种类下拉：改值后发 `change`，与用户操作同一条路径。 */
function kindSelect(panel: CanvasPanelElement): HTMLSelectElement {
  const found = rootOf(panel).querySelector('.field-kind');
  if (!(found instanceof HTMLSelectElement)) throw new Error('侧栏没有种类下拉');
  return found;
}

async function switchKind(panel: CanvasPanelElement, kind: canvas.ScalarKind): Promise<void> {
  const select = kindSelect(panel);
  select.value = kind;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(panel);
}

/** 通过侧栏编辑字面值。 */
async function editRow(panel: CanvasPanelElement, _label: string, text: string): Promise<void> {
  clickNode(panel);
  await settle(panel);
  const input = rootOf(panel).querySelector('.field-value');
  if (!(input instanceof HTMLInputElement)) throw new Error('侧栏没有值输入框');
  input.value = text;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await settle(panel);
}

/** 校验结果的快照：只留「哪个节点、哪个 code」，切种类不该让这份快照变长。 */
function errorKeysOf(doc: canvas.CanvasDocument): readonly string[] {
  return canvas
    .validateCanvasDocument(doc)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => `${issue.nodeId}:${issue.code}`);
}

// ---------------------------------------------------------------------------
// 接线：种类换完以后还要能接到方法参数上
// ---------------------------------------------------------------------------

const CALL_ID = 'call';

/** 「开始 → gets(data)」加一个整数字面值：链路从这两块积木起步。 */
function methodDocument(): canvas.CanvasDocument {
  return {
    ...canvas.emptyCanvasDocument(),
    nodes: [
      START,
      { id: CALL_ID, kind: 'method', block: 'gets', args: { data: canvas.UNCONNECTED } },
      { id: NODE_ID, kind: 'value', value: { kind: 'int', value: '0' } },
    ],
    layout: { [NODE_ID]: { x: 40, y: 40 }, [CALL_ID]: { x: 40, y: 240 } },
    main: ['start', CALL_ID],
  };
}


afterEach(() => {
  vi.restoreAllMocks();
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// 一个入口：侧栏换种类 → 文档 → 视图模型
// ---------------------------------------------------------------------------

describe('画布面板：字面值切换种类', () => {
  it('选中字面值后侧栏给种类下拉，当前项就是整数', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '0' }));
    clickNode(panel);
    await settle(panel);
    const select = kindSelect(panel);
    expect(select.value).toBe('int');
    expect([...select.options].map((option) => option.textContent?.trim())).toEqual([
      '字节串',
      '整数',
      '浮点数',
      '文本',
      '布尔',
    ]);
  });

  it('整数切到字节串：文档变空字节串，行文本与预览跟着变', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '0' }));
    clickNode(panel);
    await settle(panel);
    const before = viewOf(panel);
    expect(rowTextOf(before, '值')).toBe('0');
    expect(subtitleOf(before)).toBe('整数');

    await switchKind(panel, 'byte');

    expect(literalOf(panel).value).toEqual({ kind: 'byte', hex: '' });
    const after = viewOf(panel);
    expect(rowTextOf(after, '值')).toBe('空字节串');
    expect(rowTextOf(after, '预览')).toBe('0 字节（空）');
    expect(subtitleOf(after)).toBe('字节串');
    expect(after.previews.get(NODE_ID)).toBe('0 字节（空）');
  });

  it('切到文本：文档是空文本，行文本加引号、预览是空串', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '7' }));
    clickNode(panel);
    await settle(panel);
    await switchKind(panel, 'string');

    expect(literalOf(panel).value).toEqual({ kind: 'string', value: '' });
    const view = viewOf(panel);
    expect(rowTextOf(view, '值')).toBe('「」');
    expect(rowTextOf(view, '预览')).toBe('""');
    expect(subtitleOf(view)).toBe('文本');
  });

  it('切到布尔：文档是假，行文本与预览都给「假」', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '1' }));
    clickNode(panel);
    await settle(panel);
    await switchKind(panel, 'bool');

    expect(literalOf(panel).value).toEqual({ kind: 'bool', value: false });
    const view = viewOf(panel);
    expect(rowTextOf(view, '值')).toBe('假');
    expect(rowTextOf(view, '预览')).toBe('假');
    expect(subtitleOf(view)).toBe('布尔');
  });

  it('切到浮点：文档是 0，副标题变浮点数', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '9' }));
    clickNode(panel);
    await settle(panel);
    await switchKind(panel, 'double');

    expect(literalOf(panel).value).toEqual({ kind: 'double', value: 0 });
    const view = viewOf(panel);
    expect(rowTextOf(view, '值')).toBe('0');
    expect(subtitleOf(view)).toBe('浮点数');
  });

  it('切换后校验不多出 error：空字节串与空文本都是合法字面值', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '0' }));
    clickNode(panel);
    await settle(panel);
    const before = errorKeysOf(currentDocument(panel));

    await switchKind(panel, 'byte');
    expect(errorKeysOf(currentDocument(panel))).toEqual(before);
    expect(canvas.decodeScalarValue(literalOf(panel).value).ok).toBe(true);

    await switchKind(panel, 'string');
    expect(errorKeysOf(currentDocument(panel))).toEqual(before);
    expect(canvas.decodeScalarValue(literalOf(panel).value).ok).toBe(true);
  });

  it('选项旁边写着「切换会重置当前值」，而且不弹模态确认框', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const panel = await mount(documentWith({ kind: 'int', value: '3' }));
    clickNode(panel);
    await settle(panel);

    const note = rootOf(panel).querySelector('.field-kind-note');
    expect(note?.textContent ?? '').toContain('切换会重置当前值');

    await switchKind(panel, 'byte');

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(rootOf(panel).querySelector('dialog')).toBeNull();
    expect(literalOf(panel).value).toEqual({ kind: 'byte', hex: '' });
  });

  it('两个入口落到同一处：切到字节串后侧栏编辑写 hex，再切回整数被重置', async () => {
    const panel = await mount(documentWith({ kind: 'int', value: '0' }));
    clickNode(panel);
    await settle(panel);
    await switchKind(panel, 'byte');
    await editRow(panel, '值', '4141');
    expect(literalOf(panel).value).toEqual({ kind: 'byte', hex: '4141' });

    // 覆盖式重建：切回整数不背上一类的 hex，而是整数零值。
    await switchKind(panel, 'int');
    expect(literalOf(panel).value).toEqual({ kind: 'int', value: '0' });
  });
});

describe('画布面板：整数字面值 → 字节串字面值 → 接到方法参数', () => {
  it('换种类、写 hex、侧栏接到 gets(data)，编译出的动作参数就是这段 hex', async () => {
    const panel = await mount(methodDocument());

    // 1. 侧栏把字面值换成字节串（覆盖式重建，值变成空字节串）。
    clickNode(panel);
    await settle(panel);
    await switchKind(panel, 'byte');
    expect(literalOf(panel).value).toEqual({ kind: 'byte', hex: '' });

    // 2. 在框里写 hex：侧栏编辑走的是同一个 `setValue`。
    await editRow(panel, '值', '4141');
    expect(literalOf(panel).value).toEqual({ kind: 'byte', hex: '4141' });

    // 3. 在侧栏选择方法参数的数据来源。
    const method = rootOf(panel).querySelector(`.node-box[data-node="${CALL_ID}"]`);
    if (!(method instanceof HTMLElement)) throw new Error('没有方法节点');
    method.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    await settle(panel);
    const param = rootOf(panel).querySelector('.field-param-data');
    if (!(param instanceof HTMLSelectElement)) throw new Error('没有参数选项');
    param.value = NODE_ID;
    param.dispatchEvent(new Event('change', { bubbles: true }));
    await settle(panel);

    const call = currentDocument(panel).nodes.find((node) => node.id === CALL_ID);
    if (call === undefined || call.kind !== 'method') throw new Error('文档里没有方法节点');
    expect(call.args['data']).toBe(NODE_ID);

    // 4. 接上以后既没有类型问题，也能编出动作：参数值就是那段 hex。
    expect(errorKeysOf(currentDocument(panel)).filter((key) => key.startsWith(`${CALL_ID}:`))).toEqual([]);
    const authorBlocks = CHALLENGE.authorBlocks;
    const outcome = compileCanvas({
      document: currentDocument(panel),
      ...(authorBlocks === undefined ? {} : { authorBlocks }),
      documentRevision: 0,
    });
    if (!outcome.ok) throw new Error(`编译失败：${outcome.issues.map((issue) => issue.message).join('；')}`);
    expect(outcome.artifact.actions).toEqual([{ type: 'block', id: 'gets', args: { data: '4141' } }]);
  });
});
