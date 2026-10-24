// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'lit';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import type { PublicChallenge } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import { pairsTextOf, renderSteps, roundsTextOf } from '../src/components/canvas-panel-steps';
import type { StepsState } from '../src/components/canvas-panel-steps';
import type { CanvasStore } from '../src/canvas/save';

/**
 * 「步骤与轮次」区（验收表 AT-18：「生成后按步骤/轮次查看当时的值」）。
 *
 * 两层断言：
 * - 纯渲染：`renderSteps` 是纯函数，这里用 `lit` 的 `render` 直接把它挂进一个普通容器，
 *   既测表结构与文案，也测点击 / 选中 / 折叠这些只在 DOM 上看得出来的行为；
 * - 面板级：挂真的 `<pwn2block-canvas-panel>`，证明「编译成功后步骤表真的出现在界面上」，
 *   并且「编译失败后不再显示上一轮的步骤」。
 *
 * 值的文案一律与 `canvas.valueSummary` 逐字比对：界面里同一个值只能有一种写法，
 * 一旦有人另写一套格式化，这里会直接红。
 */

const CHALLENGE: PublicChallenge = ret2winPublic;
const panels: CanvasPanelElement[] = [];
const containers: HTMLElement[] = [];

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface StepOptions {
  readonly step: number;
  readonly nodeId: string;
  readonly kind?: 'assign' | 'action';
  readonly rounds?: Readonly<Record<string, number>>;
  readonly inputs?: readonly canvas.CanvasInputView[];
  readonly variables?: readonly canvas.CanvasVariableView[];
}

function stepOf(options: StepOptions): canvas.CanvasStep {
  const kind = options.kind ?? 'action';
  return {
    step: options.step,
    nodeId: options.nodeId,
    kind,
    actionIndex: kind === 'assign' ? null : options.step,
    rounds: options.rounds ?? {},
    inputs: options.inputs ?? [],
    variables: options.variables ?? [],
  };
}

function stateOf(overrides: Partial<StepsState> = {}): StepsState {
  return {
    steps: [],
    selection: [],
    titles: new Map([
      ['set-v', '设置变量'],
      ['m1', '方法 gets'],
    ]),
    collapsed: false,
    onLocate: () => undefined,
    onToggle: () => undefined,
    ...overrides,
  };
}

/** 只有一步的状态：多数用例只关心一格，省掉一层嵌套。 */
function oneStepState(step: canvas.CanvasStep, overrides: Partial<StepsState> = {}): StepsState {
  return stateOf({ ...overrides, steps: [step] });
}

/** 把纯模板挂进 DOM：`lit` 的 `render` 是同步的，返回后即可查询。 */
function mountSteps(state: StepsState): HTMLElement {
  const container = window.document.createElement('div');
  window.document.body.append(container);
  containers.push(container);
  render(renderSteps(state), container);
  return container;
}

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function cellTexts(container: HTMLElement, selector: string): readonly string[] {
  return [...container.querySelectorAll(selector)].map((element) => textOf(element));
}

function requireElement(container: HTMLElement, selector: string): HTMLElement {
  const found = container.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`找不到 ${selector}`);
  return found;
}

// ---------------------------------------------------------------------------
// 纯渲染
// ---------------------------------------------------------------------------

describe('步骤与轮次：空态与折叠', () => {
  it('没有步骤时标题写「步骤（0）」并给出「还没有可执行的步骤」', () => {
    const container = mountSteps(stateOf());
    expect(textOf(container.querySelector('h3'))).toBe('步骤（0）');
    expect(textOf(container.querySelector('.steps-empty'))).toBe('还没有可执行的步骤');
    expect(container.querySelectorAll('.step-row')).toHaveLength(0);
  });

  it('折叠后不渲染行：标题仍报条数，表与空态都不在 DOM 里', () => {
    const container = mountSteps(
      stateOf({ steps: [stepOf({ step: 0, nodeId: 'set-v', kind: 'assign' })], collapsed: true }),
    );
    expect(textOf(container.querySelector('h3'))).toBe('步骤（1）');
    expect(container.querySelectorAll('.step-row')).toHaveLength(0);
    expect(container.querySelector('.steps-table')).toBeNull();
    expect(container.querySelector('.steps-empty')).toBeNull();
    const toggle = requireElement(container, '.steps-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('展开时按钮的 aria-expanded 为 true，且区域带 aria-label', () => {
    const container = mountSteps(stateOf({ steps: [stepOf({ step: 0, nodeId: 'm1' })] }));
    expect(requireElement(container, '.steps-toggle').getAttribute('aria-expanded')).toBe('true');
    const region = container.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('步骤与轮次');
  });
});

describe('步骤与轮次：一行五格', () => {
  it('赋值 + 方法各一行：步号从 #0 起，节点标题取自传入的视图模型标题', () => {
    const container = mountSteps(
      stateOf({
        steps: [
          stepOf({ step: 0, nodeId: 'set-v', kind: 'assign' }),
          stepOf({ step: 1, nodeId: 'm1' }),
        ],
      }),
    );
    expect(container.querySelectorAll('.step-row')).toHaveLength(2);
    expect(cellTexts(container, '.step-index')).toEqual(['#0', '#1']);
    expect(cellTexts(container, '.step-node')).toEqual(['设置变量', '方法 gets']);
    // 表头一行，列顺序与格子一致。
    expect(cellTexts(container, '.steps-table thead th')).toEqual(['步号', '节点', '轮次', '读入', '之后']);
  });

  it('节点不在视图里时给「未知节点」，不拿 id 冒充标题', () => {
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'ghost' })));
    expect(cellTexts(container, '.step-node')).toEqual(['未知节点']);
  });

  it('读入与之后都为空时两格都是 —', () => {
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'm1' })));
    expect(cellTexts(container, '.step-inputs')).toEqual(['—']);
    expect(cellTexts(container, '.step-variables')).toEqual(['—']);
  });

  it('读入与之后都非空时按「名字 = 值」并用顿号连接多组', () => {
    const left = canvas.intValue(1n);
    const right = canvas.intValue(2n);
    const sum = canvas.intValue(3n);
    const container = mountSteps(
      oneStepState(
        stepOf({
          step: 0,
          nodeId: 'm1',
          inputs: [
            { name: 'left', value: left },
            { name: 'right', value: right },
          ],
          variables: [{ name: 'v', value: sum }],
        }),
      ),
    );
    expect(cellTexts(container, '.step-inputs')).toEqual([
      `left = ${canvas.valueSummary(left)}、right = ${canvas.valueSummary(right)}`,
    ]);
    expect(cellTexts(container, '.step-variables')).toEqual([`v = ${canvas.valueSummary(sum)}`]);
  });
});

describe('步骤与轮次：轮次显示口径（所有层全列出，外→内）', () => {
  it('单层循环写「loop1 第 2 轮」：存储从 0 起、显示从 1 起', () => {
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'm1', rounds: { loop1: 1 } })));
    expect(cellTexts(container, '.step-rounds')).toEqual(['loop1 第 2 轮']);
  });

  it('两层嵌套循环全部列出（外→内），不只取最内层', () => {
    const container = mountSteps(
      oneStepState(stepOf({ step: 0, nodeId: 'm1', rounds: { loop1: 0, loop2: 2 } })),
    );
    expect(cellTexts(container, '.step-rounds')).toEqual(['loop1 第 1 轮 · loop2 第 3 轮']);
  });

  it('不在任何循环里时轮次这一格不显示文字', () => {
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'm1' })));
    expect(cellTexts(container, '.step-rounds')).toEqual(['']);
  });

  it('roundsTextOf 是这一口径的唯一实现，空表给空串', () => {
    expect(roundsTextOf({})).toBe('');
    expect(roundsTextOf({ loop9: 0 })).toBe('loop9 第 1 轮');
  });
});

describe('步骤与轮次：值格式化复用 canvas.valueSummary', () => {
  it('字节串：与 canvas.valueSummary 逐字相等', () => {
    const value = canvas.byteValue(new Uint8Array([0x41, 0x42]));
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'm1', inputs: [{ name: 'data', value }] })));
    expect(cellTexts(container, '.step-inputs')).toEqual([`data = ${canvas.valueSummary(value)}`]);
    expect(textOf(container.querySelector('.step-inputs'))).toContain('2 字节：4142');
  });

  it('整数：与 canvas.valueSummary 逐字相等', () => {
    const value = canvas.intValue(0x1234n);
    const container = mountSteps(
      oneStepState(stepOf({ step: 0, nodeId: 'set-v', kind: 'assign', variables: [{ name: 'v', value }] })),
    );
    expect(cellTexts(container, '.step-variables')).toEqual([`v = ${canvas.valueSummary(value)}`]);
    expect(textOf(container.querySelector('.step-variables'))).toContain('4660（0x1234）');
  });

  it('文本：与 canvas.valueSummary 逐字相等（值里的引号由共享层加）', () => {
    const value = canvas.stringValue('ab');
    const container = mountSteps(oneStepState(stepOf({ step: 0, nodeId: 'm1', inputs: [{ name: 'text', value }] })));
    expect(cellTexts(container, '.step-inputs')).toEqual([`text = ${canvas.valueSummary(value)}`]);
    expect(textOf(container.querySelector('.step-inputs'))).toBe('text = "ab"');
  });

  it('pairsTextOf 空数组给 —，非空按「名字 = 值」拼', () => {
    expect(pairsTextOf([])).toBe('—');
    expect(pairsTextOf([{ name: 'v', value: canvas.boolValue(true) }])).toBe('v = 真');
  });
});

describe('步骤与轮次：点行定位与选中反显', () => {
  it('点一行调用 onLocate 并传该行的 nodeId', () => {
    const located: string[] = [];
    const container = mountSteps(
      stateOf({
        steps: [
          stepOf({ step: 0, nodeId: 'set-v', kind: 'assign' }),
          stepOf({ step: 1, nodeId: 'm1' }),
        ],
        onLocate: (nodeId) => located.push(nodeId),
      }),
    );
    const rows = [...container.querySelectorAll('.step-row')];
    rows[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(located).toEqual(['m1']);
  });

  it('键盘 Enter 与空格同样定位（行可聚焦）', () => {
    const located: string[] = [];
    const container = mountSteps(
      oneStepState(stepOf({ step: 0, nodeId: 'm1' }), { onLocate: (nodeId) => located.push(nodeId) }),
    );
    const row = requireElement(container, '.step-row');
    expect(row.getAttribute('tabindex')).toBe('0');
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    expect(located).toEqual(['m1', 'm1']);
  });

  it('选中集包含该 nodeId 时行加 is-selected，另一行不加', () => {
    const container = mountSteps(
      stateOf({
        steps: [
          stepOf({ step: 0, nodeId: 'set-v', kind: 'assign' }),
          stepOf({ step: 1, nodeId: 'm1' }),
        ],
        selection: ['set-v'],
      }),
    );
    const rows = [...container.querySelectorAll('.step-row')];
    expect(rows[0]?.classList.contains('is-selected')).toBe(true);
    expect(rows[1]?.classList.contains('is-selected')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 面板级：编译成功后有表，失败后清空
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

function documentOf(nodes: readonly canvas.CanvasNode[], main: readonly string[]): canvas.CanvasDocument {
  const layout: Record<string, canvas.CanvasNodeLayout> = {};
  nodes.forEach((node, index) => {
    layout[node.id] = { x: 40 + index * 20, y: 40 + index * 20 };
  });
  return { ...canvas.emptyCanvasDocument(), nodes, layout, main };
}

/** 「赋值 + 方法」：`set-v` 把 int 7 写进变量 v，`m1` 调题目的 `gets`。两步都该进步骤表。 */
function assignAndMethod(): canvas.CanvasDocument {
  return documentOf(
    [
      { id: 'start', kind: 'start' },
      { id: 'lit', kind: 'value', value: { kind: 'int', value: '7' } },
      { id: 'v', kind: 'var-decl', name: 'v', type: 'int', binding: { mode: 'none' } },
      { id: 'set-v', kind: 'assign', target: 'v', value: 'lit' },
      { id: 'bytes', kind: 'value', value: { kind: 'byte', hex: '4142' } },
      { id: 'm1', kind: 'method', block: 'gets', args: { data: 'bytes' } },
    ],
    ['start', 'set-v', 'm1'],
  );
}

/** 编译必定失败：题目没声明方法 `nope`（失败不发布部分动作）。 */
function brokenDocument(): canvas.CanvasDocument {
  return documentOf(
    [
      { id: 'start', kind: 'start' },
      { id: 'm2', kind: 'method', block: 'nope', args: {} },
    ],
    ['start', 'm2'],
  );
}

async function mountPanel(doc: canvas.CanvasDocument): Promise<CanvasPanelElement> {
  const element = window.document.createElement('pwn2block-canvas-panel');
  if (!(element instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
  element.challenge = CHALLENGE;
  element.document = doc;
  element.store = new MemoryStore();
  window.document.body.append(element);
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

afterEach(() => {
  while (panels.length > 0) panels.pop()?.remove();
  while (containers.length > 0) containers.pop()?.remove();
  window.document.body.innerHTML = '';
});

describe('画布面板：步骤与轮次区', () => {
  it('挂上「赋值 + 方法」文档后，.steps 出现 2 行且第一行含 #0', async () => {
    const panel = await mountPanel(assignAndMethod());
    const root = rootOf(panel);

    const steps = root.querySelector('.steps');
    expect(steps).not.toBeNull();
    expect(textOf(root.querySelector('.steps h3'))).toBe('步骤（2）');

    const rows = [...root.querySelectorAll('.step-row')];
    expect(rows).toHaveLength(2);
    expect(textOf(rows[0])).toContain('#0');
    // 第一行是赋值步骤，标题来自视图模型（「设置变量」），不是节点 id「set-v」。
    expect(textOf(rows[0])).toContain('设置变量');
    expect(textOf(rows[1])).toContain('#1');
    expect(textOf(rows[0])).not.toContain('set-v');
  });

  it('编译失败后不再显示上一轮步骤：行清空、标题回到「步骤（0）」', async () => {
    const panel = await mountPanel(assignAndMethod());
    expect(rootOf(panel).querySelectorAll('.step-row')).toHaveLength(2);

    panel.setDocument(brokenDocument());
    await settle(panel);

    const root = rootOf(panel);
    expect(root.querySelectorAll('.step-row')).toHaveLength(0);
    expect(textOf(root.querySelector('.steps h3'))).toBe('步骤（0）');
    expect(textOf(root.querySelector('.steps-empty'))).toBe('还没有可执行的步骤');
  });

  it('步骤表不进 p2b-canvas-compiled 的 payload（产物契约不动）', async () => {
    const details: unknown[] = [];
    const panel = window.document.createElement('pwn2block-canvas-panel');
    if (!(panel instanceof CanvasPanelElement)) throw new Error('自定义元素没有注册');
    panel.addEventListener('p2b-canvas-compiled', (event) => {
      if (event instanceof CustomEvent) details.push(event.detail);
    });
    panel.challenge = CHALLENGE;
    panel.document = assignAndMethod();
    panel.store = new MemoryStore();
    window.document.body.append(panel);
    panels.push(panel);
    await panel.updateComplete;

    expect(details).toHaveLength(1);
    const detail = details[0];
    expect(detail).toMatchObject({ artifact: { originsVersion: 1 } });
    // 产物里没有 steps 字段，事件 detail 里也没有第二份。
    if (typeof detail !== 'object' || detail === null) throw new Error('detail 不是对象');
    expect(Object.hasOwn(detail, 'steps')).toBe(false);
    expect(Object.hasOwn(detail, 'artifact')).toBe(true);
  });
});
