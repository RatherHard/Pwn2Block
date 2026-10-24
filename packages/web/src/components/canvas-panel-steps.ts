import { html, nothing } from 'lit';
import type { TemplateResult } from 'lit';
import { canvas } from '@pwn2block/shared';
import type { CanvasLayoutView } from '../canvas/view-model';

/**
 * 「步骤与轮次」区（需求 §7「生成后按步骤和循环轮次查看当时的值」，验收表 AT-18 的最后一条）。
 *
 * 数据来自生成器的步骤快照（`canvas.CanvasStep`），不是产物：产物是发给服务端的动作序列，
 * 步骤快照只在前端内存里用（见 `canvas/compile.ts` 的 `compileCanvasWithSteps`）。
 * 这里只做「把快照翻译成一张表」，不重新求值——重算一遍等于给出第二份答案。
 *
 * 每行五格，来源一一对应：
 * - `#步号` ← `step.step`（赋值与方法都算一步，从 0 开始）；
 * - 节点标题 ← 视图模型的盒子标题（`view-model` 里 `titleOfNode` 的结果），不在这里拼 id；
 * - 轮次 ← `step.rounds`，**全部列出**（外→内），显示从 1 起数；
 * - 读入 ← `step.inputs`（这一步读到的数据值），`名字 = 值`；
 * - 之后 ← `step.variables`（这一步执行后已初始化的普通变量），同样是 `名字 = 值`。
 *
 * 值的写法复用共享层的 `canvas.valueSummary`：画布盒子里的预览、侧栏、这里必须是同一句话，
 * 否则同一个值在界面上会有两种长度、两种进制写法。
 *
 * 折叠语义：折叠由**面板**的状态决定（`collapsed`），不是浏览器自己的开合状态。折叠时整张表
 * 不渲染，而不是 `display: none`——省下的 DOM 是真实省下的，也方便测试断言「折叠后没有行」。
 */

/** 节点不在视图里（文档刚变、步骤表还没重算）时的标题；不拿 id 冒充标题。 */
const UNKNOWN_NODE_TITLE = '未知节点';

/** 空格档：读入 / 之后为空时占位，让「没有」与「空字符串」在表里看起来一样明确。 */
const EMPTY_CELL = '—';

/** 多段内容的连接符：轮次用中点、键值对用顿号，和界面其他枚举文案一致。 */
const ROUND_SEPARATOR = ' · ';
const PAIR_SEPARATOR = '、';

/** 渲染这一区需要的全部状态。 */
export interface StepsState {
  /** 生成器给出的步骤快照；编译失败时面板给空数组。 */
  readonly steps: readonly canvas.CanvasStep[];
  /** 当前选中的节点 id：行里命中就反显。 */
  readonly selection: readonly string[];
  /** nodeId → 节点标题，来自视图模型（`nodeTitlesOf`）。 */
  readonly titles: ReadonlyMap<string, string>;
  /** 是否折叠：折叠时不渲染行。 */
  readonly collapsed: boolean;
  /** 点一行：滚到该节点（面板的 `locate`）。 */
  readonly onLocate: (nodeId: string) => void;
  /** 点标题栏的展开 / 收起。 */
  readonly onToggle: () => void;
}

/**
 * 视图模型 → nodeId 到标题的表。
 *
 * 直接抄盒子标题，不重新调 `titleOfNode`：同一份标题只能有一个来源，否则画布上写「方法 emit」、
 * 步骤表里写「方法」这种事迟早会发生。
 */
export function nodeTitlesOf(view: CanvasLayoutView): ReadonlyMap<string, string> {
  const titles = new Map<string, string>();
  for (const box of view.boxes) {
    if (titles.has(box.nodeId)) continue;
    titles.set(box.nodeId, box.title);
  }
  return titles;
}

/** 整块：标题栏 + 表（或空态）。 */
export function renderSteps(state: StepsState): TemplateResult {
  return html`<section class="steps" role="region" aria-label="步骤与轮次">
    <div class="steps-head">
      <h3>步骤（${state.steps.length}）</h3>
      <button
        type="button"
        class="steps-toggle"
        aria-expanded=${state.collapsed ? 'false' : 'true'}
        @click=${state.onToggle}
      >
        ${state.collapsed ? '展开' : '收起'}
      </button>
    </div>
    ${state.collapsed ? nothing : renderBody(state)}
  </section>`;
}

/** 表体：没有步骤时给一句话，有步骤时给表头 + 每步一行。 */
function renderBody(state: StepsState): TemplateResult {
  if (state.steps.length === 0) return html`<p class="steps-empty">还没有可执行的步骤</p>`;
  return html`<div class="steps-body">
    <table class="steps-table">
      <thead>
        <tr>
          <th>步号</th>
          <th>节点</th>
          <th>轮次</th>
          <th>读入</th>
          <th>之后</th>
        </tr>
      </thead>
      <tbody>
        ${state.steps.map((step) => renderRow(step, state))}
      </tbody>
    </table>
  </div>`;
}

/** 一行：五格 + 点击定位 + 选中反显（键盘 Enter / 空格同样能定位）。 */
function renderRow(step: canvas.CanvasStep, state: StepsState): TemplateResult {
  const selected = state.selection.includes(step.nodeId);
  return html`<tr
    class=${selected ? 'step-row is-selected' : 'step-row'}
    data-node=${step.nodeId}
    data-step=${step.step}
    tabindex="0"
    @click=${() => state.onLocate(step.nodeId)}
    @keydown=${(event: KeyboardEvent) => activateOnKey(event, step.nodeId, state.onLocate)}
  >
    <td class="step-index">#${step.step}</td>
    <td class="step-node">${state.titles.get(step.nodeId) ?? UNKNOWN_NODE_TITLE}</td>
    <td class="step-rounds">${roundsTextOf(step.rounds)}</td>
    <td class="step-inputs">${pairsTextOf(step.inputs)}</td>
    <td class="step-variables">${pairsTextOf(step.variables)}</td>
  </tr>`;
}

/**
 * 轮次文案：**每一层都列出来**（外→内），例如两层嵌套就写 `loop1 第 1 轮 · loop2 第 2 轮`。
 *
 * 为什么不全取最内层：内层轮次单独看会重复（外层第 1 轮与第 2 轮里都有内层第 1 轮），
 * 而步骤表正是在解释「同一句代码为什么这一步的值不同」，漏掉外层就等于把差异藏起来。
 * 存储从 0 开始（生成器口径），显示从 1 开始（人读的口径），所以这里 +1。
 */
export function roundsTextOf(rounds: Readonly<Record<string, number>>): string {
  return Object.entries(rounds)
    .map(([loopId, round]) => `${loopId} 第 ${round + 1} 轮`)
    .join(ROUND_SEPARATOR);
}

/** `读入` / `之后` 两格的文案：`名字 = 值`，值复用 `canvas.valueSummary`；空数组给 `—`。 */
export function pairsTextOf(
  pairs: readonly { readonly name: string; readonly value: canvas.Value }[],
): string {
  if (pairs.length === 0) return EMPTY_CELL;
  return pairs.map((pair) => `${pair.name} = ${canvas.valueSummary(pair.value)}`).join(PAIR_SEPARATOR);
}

/** Enter / 空格 = 点击行（行是 `tabindex` 可聚焦的，键盘不该比鼠标少一条路）。 */
function activateOnKey(event: KeyboardEvent, nodeId: string, onLocate: (nodeId: string) => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onLocate(nodeId);
}
