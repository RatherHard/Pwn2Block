// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel-legacy-view';

/**
 * 流程连接点的渲染断言（需求 §6.1「外置流程连接点」，AT-21 最后一条）。
 *
 * 面板挂一份三步主线：首步只有出口、中间一步进出都有、末步只有入口，所以页面里正好 4 个
 * `.flow-port`。三条口径在这里锁住：
 * - 只画已接线的那一端（`connected: false` 的不画，否则每步都会多出悬空小方框）；
 * - 小方框带 `data-node` / `data-flow`，但没有 `data-port`——它是只读装饰，拉不出线；
 * - 流程边的起点/终点就是小方框中心（样式里的 `left/top` 即中心，方框用 translate 对齐）。
 */

const CHALLENGE = ret2winPublic;
const panels: CanvasPanelElement[] = [];

/** 三步主线：s1 → s2 → s3。三个都是「开始」节点，没有数据端口干扰断言。 */
function threeStepDocument(): canvas.CanvasDocument {
  const nodes: readonly canvas.CanvasNode[] = [
    { id: 's1', kind: 'start' },
    { id: 's2', kind: 'start' },
    { id: 's3', kind: 'start' },
  ];
  return { ...canvas.emptyCanvasDocument(), nodes, layout: {}, main: ['s1', 's2', 's3'] };
}

async function mount(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const panel = document.createElement('pwn2block-legacy-canvas-panel');
  if (!(panel instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  panel.challenge = CHALLENGE;
  panel.document = doc;
  document.body.append(panel);
  panels.push(panel);
  await panel.updateComplete;
  return panel;
}

function rootOf(panel: CanvasPanelElement): ShadowRoot {
  const root = panel.shadowRoot;
  if (root === null) throw new Error('面板没有影子根');
  return root;
}

/** 某个流程连接点的中心坐标：`left/top` 就是中心（方框用 translate(-50%, -50%) 对齐）。 */
function centerOf(
  root: ShadowRoot,
  nodeId: string,
  direction: 'in' | 'out',
): { readonly x: number; readonly y: number } {
  const element = root.querySelector(`.flow-port[data-node="${nodeId}"][data-flow="${direction}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`找不到 ${nodeId} 的 ${direction} 流程连接点`);
  return { x: Number.parseFloat(element.style.left), y: Number.parseFloat(element.style.top) };
}

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  document.body.innerHTML = '';
});

describe('流程连接点的渲染', () => {
  it('三步主线正好 4 个流程连接点：首步只有出口、中间进出都有、末步只有入口', async () => {
    const root = rootOf(await mount(threeStepDocument()));
    const ports = [...root.querySelectorAll('.flow-port')];
    expect(ports).toHaveLength(4);
    const shape = ports.map(
      (element) => `${element.getAttribute('data-node')}:${element.getAttribute('data-flow')}`,
    );
    expect(shape.sort()).toEqual(['s1:out', 's2:in', 's2:out', 's3:in']);
  });

  it('悬空的那一端不画，且流程连接点不能拉线（没有 data-port）', async () => {
    const root = rootOf(await mount(threeStepDocument()));
    expect(root.querySelector('.flow-port[data-node="s1"][data-flow="in"]')).toBeNull();
    expect(root.querySelector('.flow-port[data-node="s3"][data-flow="out"]')).toBeNull();
    for (const element of root.querySelectorAll('.flow-port')) {
      expect(element.classList.contains('port')).toBe(true);
      expect(element.hasAttribute('data-port')).toBe(false);
    }
  });

  it('流程边的起点与终点就落在小方框中心', async () => {
    const root = rootOf(await mount(threeStepDocument()));
    const paths = [...root.querySelectorAll('path.edge-flow')].map((element) => element.getAttribute('d') ?? '');
    expect(paths).toHaveLength(2);
    const tail = centerOf(root, 's1', 'out');
    const head = centerOf(root, 's3', 'in');
    expect(paths[0].startsWith(`M ${tail.x} ${tail.y}`)).toBe(true);
    expect(paths[1].endsWith(` ${head.x} ${head.y}`)).toBe(true);
  });
});
