// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { layoutCanvas } from '../src/canvas/view-model';

/**
 * 左侧节点库：标签页、搜索、翻页、预览、题目方法与拖放。
 *
 * jsdom 没有 `DragEvent`，拖放用同名的 `MouseEvent` 代替（面板只读坐标，`dataTransfer` 缺席时照样工作）；
 * 矩形全为 0，所以客户端坐标 = 画布坐标。
 */

const START: canvas.StartNode = { id: 'start', kind: 'start' };
const panels: CanvasPanelElement[] = [];

async function mount(doc?: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const element = document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = ret2winPublic;
  element.document = doc ?? { ...canvas.emptyCanvasDocument(), nodes: [START], layout: { start: { x: 64, y: 64 } }, main: ['start'] };
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

function requireElement(panel: CanvasPanelElement, selector: string): HTMLElement {
  const found = rootOf(panel).querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`找不到 ${selector}`);
  return found;
}

/** 当前没被隐藏的目录按钮种类，按 DOM 顺序。 */
function shownKinds(panel: CanvasPanelElement): readonly (string | null)[] {
  return [...rootOf(panel).querySelectorAll<HTMLElement>('.tool[data-kind]')]
    .filter((element) => !element.hidden && element.closest('[hidden]') === null)
    .map((element) => element.getAttribute('data-kind'));
}

async function typeQuery(panel: CanvasPanelElement, text: string): Promise<HTMLInputElement> {
  const input = requireElement(panel, '.library-query');
  if (!(input instanceof HTMLInputElement)) throw new Error('搜索框不是输入框');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle(panel);
  return input;
}

function dragOnto(panel: CanvasPanelElement, source: HTMLElement, point: { x: number; y: number }): void {
  source.dispatchEvent(new MouseEvent('dragstart', { bubbles: true, cancelable: true }));
  const stage = requireElement(panel, '.stage');
  stage.dispatchEvent(new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
  stage.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y }));
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

describe('节点库：分页分级', () => {
  it('默认「全部」：十八种都可见，分类下按小类分段', async () => {
    const panel = await mount();
    expect(shownKinds(panel)).toHaveLength(18);
    const tiers = [...rootOf(panel).querySelectorAll('.toolbox-group[data-category="collection"] .tier-label')];
    expect(tiers.map((element) => element.textContent)).toEqual(['组装', '取用', '变换']);
  });

  it('切到「集合」只留那一组，翻到第二页是剩下的一项', async () => {
    const panel = await mount();
    requireElement(panel, '.library-tab[data-tab="collection"]').click();
    await settle(panel);
    expect(shownKinds(panel)).toEqual(['group', 'dict', 'index', 'lookup', 'slice']);
    expect(requireElement(panel, '.page-of').textContent?.trim()).toBe('第 1/2 页');
    requireElement(panel, '.btn-page-next').click();
    await settle(panel);
    expect(shownKinds(panel)).toEqual(['repeat']);
    expect(requireElement(panel, '.btn-page-next').hasAttribute('disabled')).toBe(true);
  });

  it('换页只加 hidden：十八个按钮始终都在 DOM 里', async () => {
    const panel = await mount();
    requireElement(panel, '.library-tab[data-tab="flow"]').click();
    await settle(panel);
    expect(rootOf(panel).querySelectorAll('.tool[data-kind]')).toHaveLength(18);
  });

  it('搜索即时筛选；Enter 放第一项，Esc 清空', async () => {
    const panel = await mount();
    const input = await typeQuery(panel, '切片');
    expect(shownKinds(panel)).toEqual(['slice']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.kind)).toEqual(['start', 'slice']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
    await settle(panel);
    expect(shownKinds(panel)).toHaveLength(18);
  });

  it('搜不到时给一句说明', async () => {
    const panel = await mount();
    await typeQuery(panel, 'zzz');
    expect(requireElement(panel, '.library-empty').textContent).toContain('zzz');
  });

  it('在搜索框里按退格不会删掉选中的节点', async () => {
    const panel = await mount();
    requireElement(panel, '.tool[data-kind="value"]').click();
    await settle(panel);
    const input = await typeQuery(panel, 'ab');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true }));
    await settle(panel);
    expect(panel.document?.nodes).toHaveLength(2);
  });
});

describe('节点库：预览', () => {
  it('悬停白框节点：标题、行与输入端口来自同一份视图模型', async () => {
    const panel = await mount();
    requireElement(panel, '.tool[data-kind="slice"]').dispatchEvent(new MouseEvent('mouseenter'));
    await settle(panel);
    const preview = requireElement(panel, '.library-preview');
    expect(preview.dataset['preview']).toBe('node:slice');
    expect(preview.querySelector('.preview-title')?.textContent).toBe('切片');
    expect([...preview.querySelectorAll('.preview-row .row-label')].map((element) => element.textContent)).toEqual([
      '起点',
      '终点',
      '步长',
      '预览',
    ]);
    expect(preview.querySelectorAll('.preview-ports li').length).toBeGreaterThan(0);
    expect(preview.querySelector('.preview-usage')?.textContent).toContain('数据');
  });

  it('运算类预览成带标号的小方框，聚焦同样触发', async () => {
    const panel = await mount();
    requireElement(panel, '.tool[data-kind="relation"]').dispatchEvent(new FocusEvent('focus'));
    await settle(panel);
    const box = requireElement(panel, '.preview-relation');
    expect(box.textContent?.trim()).toBe(canvas.binaryOperatorSpec('int.add').symbol);
    expect(box.classList.contains('cat-arith')).toBe(true);
  });

  it('流程语句的用法提示说「排进步骤」', async () => {
    const panel = await mount();
    requireElement(panel, '.tool[data-kind="loop"]').dispatchEvent(new MouseEvent('mouseenter'));
    await settle(panel);
    expect(requireElement(panel, '.preview-usage').textContent).toContain('流程语句');
  });
});

describe('节点库：题目方法', () => {
  it('「方法」下列出本题方法，点一下得到选好方法、参数齐全的节点并选中它', async () => {
    const panel = await mount();
    const block = requireElement(panel, '.toolbox-group[data-category="method"] .tool-block[data-block="gets"]');
    expect(block.textContent?.trim()).toBe('gets(buf)');
    block.click();
    await settle(panel);
    const added = panel.document?.nodes.find((node) => node.kind === 'method');
    expect(added).toMatchObject({ id: 'gets1', block: 'gets', args: { data: canvas.UNCONNECTED } });
    expect(requireElement(panel, '.inspector-id').textContent?.trim()).toBe('gets1');
  });

  it('题目方法不计入 .tool[data-kind]', async () => {
    const panel = await mount();
    expect(rootOf(panel).querySelectorAll('.tool[data-kind]')).toHaveLength(18);
    expect(rootOf(panel).querySelectorAll('.tool-block')).toHaveLength(1);
  });
});

describe('节点库：拖到画布', () => {
  it('拖到空白：放在松手处（对齐 8px 网格），不进流程', async () => {
    const panel = await mount();
    dragOnto(panel, requireElement(panel, '.tool[data-kind="value"]'), { x: 503, y: 405 });
    await settle(panel);
    const added = panel.document?.nodes.find((node) => node.kind === 'value');
    if (added === undefined) throw new Error('没有放出节点');
    expect(panel.document?.layout[added.id]).toEqual({ x: 480, y: 392 });
    expect(panel.document?.main).toEqual(['start']);
  });

  it('把本题方法拖到开始节点正下方：一次编辑里放好并排进第 2 步', async () => {
    const panel = await mount();
    const doc = panel.document;
    if (doc === undefined) throw new Error('面板没有文档');
    const start = layoutCanvas({ document: doc }).boxes.find((box) => box.nodeId === 'start');
    if (start === undefined) throw new Error('没有开始节点');
    const revision = panel.revision;
    dragOnto(panel, requireElement(panel, '.tool-block[data-block="gets"]'), {
      x: Math.round(start.x + start.width / 2),
      y: Math.round(start.y + start.height + 30),
    });
    await settle(panel);
    expect(panel.document?.main).toEqual(['start', 'gets1']);
    expect(panel.revision).toBe(revision + 1);
    expect(requireElement(panel, '.message').textContent).toContain('插入第 2 步');
    // 撤销一次就全退回：节点和流程位置是同一次编辑。
    requireElement(panel, '.btn-undo').click();
    await settle(panel);
    expect(panel.document?.nodes.map((node) => node.id)).toEqual(['start']);
  });

  it('没有从节点库开始拖动时，画布不接收 drop', async () => {
    const panel = await mount();
    const stage = requireElement(panel, '.stage');
    stage.dispatchEvent(new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    await settle(panel);
    expect(panel.document?.nodes).toHaveLength(1);
  });
});
