import { html } from 'lit';
import type { TemplateResult } from 'lit';
import { outputEntries } from '../viewmodel/output';
import { statusMarker, type PageMode } from '../viewmodel/session';
import type { ControllerState } from '../viewmodel/controller';

/**
 * 页面壳里三段**纯渲染**（从 `app-shell.ts` 拆出来，把外壳压回 800 行以内）。
 *
 * 拆出来的唯一理由是文件长度：这三段都是「状态进、模板出」，不持有状态、不订阅事件、
 * 不碰控制器——按钮要做什么由调用方以回调传入（外壳负责把它们接到控制器上）。
 * 于是这里的每个函数都是纯的，也就能脱离浏览器断言结构。
 */

/** 提示条的两个出口：外壳把它们接到 `controller.restart()` / `controller.retry()`。 */
export interface NoticeHandlers {
  readonly restart: () => void;
  readonly retry: () => void;
}

/**
 * 顶部提示条（09 §2）：没有提示时返回空串，让外壳的模板保持同一分支结构。
 * `tone` 决定语义：`error` 用 `role="alert"`，其余用 `status`，屏幕阅读器的播报强度跟着变。
 */
export function renderNotice(state: ControllerState, handlers: NoticeHandlers): TemplateResult | '' {
  const notice = state.notice;
  if (notice === undefined) return '';
  return html`
    <p
      class="notice ${notice.tone}"
      role=${notice.tone === 'error' ? 'alert' : 'status'}
      aria-live=${notice.tone === 'error' ? 'assertive' : 'polite'}
    >
      <span aria-hidden="true">${statusMarker(notice.tone)}</span>
      <span>${notice.text}</span>
      ${notice.action === 'restart'
        ? html`<button type="button" @click=${handlers.restart}>重新开始</button>`
        : ''}
      ${notice.action === 'retry'
        ? html`<button type="button" @click=${handlers.retry}>重试</button>`
        : ''}
    </p>
  `;
}

/** 判题结果面板的三类事件：回调试、选录像帧、点某一步定位节点。 */
export interface VerdictHandlers {
  readonly backToDebug: () => void;
  readonly position: (position: number) => void;
  readonly blockSelect: (blockId: string) => void;
}

/** 判题结果横幅：只在判题模式渲染，数据源与控制器的 `state` 同源（05 §1）。 */
export function renderVerdict(state: ControllerState, handlers: VerdictHandlers): TemplateResult {
  return html`
    <pwn2block-verdict-panel
      .state=${state}
      @p2b-back-to-debug=${handlers.backToDebug}
      @p2b-position=${(event: CustomEvent<{ readonly position: number }>) => handlers.position(event.detail.position)}
      @p2b-block-select=${(event: CustomEvent<{ readonly blockId: string }>) =>
        handlers.blockSelect(event.detail.blockId)}
    ></pwn2block-verdict-panel>
  `;
}

/**
 * 输出区（05 §6）：数据来自 `outputEntries`（纯函数），条目里的「定位节点」回调交给外壳。
 * 判题结果模式下顶部加一行说明：下面列的是调试实例的历史结果。
 */
export function renderOutput(state: ControllerState, blockSelect: (blockId: string) => void): TemplateResult {
  const { artifact, errors, stale } = state.artifact;
  const mode: PageMode = state.page?.mode ?? 'debug';
  return html`
    <section class="output box" aria-label="输出区">
      <h2 class="box-title">输出</h2>
      ${mode === 'verdict'
        ? html`<p class="mode-hint">下面是调试实例的历史结果；这一轮判题的结论见上方横幅。</p>`
        : ''}
      <pwn2block-output-view
        .entries=${outputEntries({
          artifact,
          errors,
          stale,
          results: state.results,
          cursor: state.cursor,
          ...(state.page === undefined ? {} : { projection: state.page.projection }),
        })}
        @p2b-block-select=${(event: CustomEvent<{ readonly blockId: string }>) =>
          blockSelect(event.detail.blockId)}
      ></pwn2block-output-view>
    </section>
  `;
}
