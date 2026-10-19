import { html, nothing } from 'lit';
import type { ParamSpec, ParamValue } from '@pwn2block/shared';
import { checkParam } from '../workflow/params';
import './code-editor';

/**
 * 参数控件（10 §2.2「节点内编辑与属性面板」）。
 *
 * 节点内和属性面板**同一个渲染器、同一份校验**：值、模式（手填 / 接线）、错误文案都来自
 * 这里的 `checkParam` 与 `portModeOf`，两处不会给出不同判断。差异只有布局：
 * `compact` 给节点内的窄行，其余给右侧常驻面板。
 *
 * 组件不持状态：值来自文档，修改通过回调派发，由面板落到 `graph/editor` 的编辑命令，
 * 因此同一次修改只形成一条撤销记录。
 */

export interface ParamFieldOptions {
  readonly nodeId: string;
  readonly param: ParamSpec;
  readonly value: ParamValue | undefined;
  /** 有效来源模式（手填 / 接线），由 `portModeOf` 算出。 */
  readonly mode: 'inline' | 'port';
  /** 上游节点 id（接线时）。 */
  readonly source?: string;
  /** 节点内紧凑布局：不重复画参数名与完整错误文案。 */
  readonly compact?: boolean;
  readonly onValue: (value: ParamValue) => void;
  readonly onMode?: (mode: 'inline' | 'port') => void;
  /** 复杂参数（代码、命名输入）在节点内只给入口，完整编辑在属性面板。 */
  readonly onConfigure?: () => void;
  /** 代码编辑器是否处于扩大状态（由属性面板持有，退出后保留内容）。 */
  readonly expanded?: boolean;
  readonly onExpand?: (expanded: boolean) => void;
}

/** 参数控件的 DOM id：节点内与面板内共用，测试与 `aria-labelledby` 都靠它。 */
export function paramIdOf(nodeId: string, name: string): string {
  return `${nodeId}-${name}`;
}

/** 输入框里的字符串按参数类型转换；转换不了就原样交给校验器报错。 */
export function coerceParam(param: ParamSpec, raw: string): ParamValue {
  if (param.kind === 'int') {
    const trimmed = raw.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
    if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
    return raw;
  }
  // `hex` 是字节串（`4141`），不是数字：全数字的字节串不能按十进制吞掉。
  if (param.kind === 'hex') return raw.trim();
  return raw;
}

export function splitPorts(raw: string): readonly string[] {
  return raw
    .split(/[,，\s]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** 参数值是否「接了线」：接了线时节点内的输入框只读，避免误改导致断线。 */
export function isBoundToPort(options: ParamFieldOptions): boolean {
  return options.param.port !== undefined && options.mode === 'port' && options.source !== undefined;
}

export function renderParamField(options: ParamFieldOptions): unknown {
  const { param, value, compact } = options;
  const id = paramIdOf(options.nodeId, param.name);
  const reason = checkParam(param, value === undefined ? param.default : value);
  const bound = isBoundToPort(options);
  const error = compact || reason === undefined
    ? nothing
    : html`<span class="bad param-error" role="alert">${reason}</span>`;
  const badge = compact === true ? renderCompactBadge(options) : nothing;
  return html`<div class="param-field ${compact === true ? 'compact' : 'full'}" data-param=${param.name}>
    ${compact === true ? nothing : html`<label for=${id}>${param.label}</label>`}
    <div class="param-line">
      ${renderControl(options, id, reason, bound)}
      ${badge}
    </div>
    ${error}
    ${compact === true || param.port === undefined ? nothing : renderModeSwitch(options)}
  </div>`;
}

function renderControl(
  options: ParamFieldOptions,
  id: string,
  reason: string | undefined,
  bound: boolean,
): unknown {
  const { param, value } = options;
  const current = value === undefined ? param.default : value;
  const invalid = reason !== undefined;
  const disabled = bound;
  const title = bound ? `由上游 ${options.source ?? ''} 提供；切回「手填」才能直接改` : (reason ?? param.help ?? '');

  if (param.kind === 'select' || param.kind === 'type') {
    const selected = Array.isArray(current) ? '' : String(current);
    return html`<select
      id=${id}
      data-param-control=${param.name}
      ?disabled=${disabled}
      title=${title}
      @change=${(event: Event) => options.onValue((event.target as HTMLSelectElement).value)}
    >
      ${(param.options ?? []).map(
        (option) => html`<option value=${option.value} ?selected=${selected === option.value}>${option.label}</option>`,
      )}
    </select>`;
  }

  if (param.kind === 'code' || param.kind === 'portList') {
    if (options.compact === true) {
      const summary = param.kind === 'code'
        ? `${typeof current === 'string' ? current.split('\n').length : 0} 行代码`
        : Array.isArray(current) ? `${current.length} 个命名输入` : '未配置';
      return html`<span class="param-summary">${summary}</span>`;
    }
    if (param.kind === 'code') {
      return html`<pwn2block-code-editor
        id=${id}
        .label=${param.label}
        .value=${typeof current === 'string' ? current : ''}
        .expanded=${options.expanded === true}
        .rows=${10}
        @p2b-code-change=${(event: CustomEvent<{ value: string }>) => options.onValue(event.detail.value)}
        @p2b-code-expand=${(event: CustomEvent<{ expanded: boolean }>) => options.onExpand?.(event.detail.expanded)}
      ></pwn2block-code-editor>`;
    }
    const text = Array.isArray(current) ? current.join(', ') : String(current);
    return html`<textarea
      id=${id}
      data-param-control=${param.name}
      .value=${text}
      title=${title}
      @change=${(event: Event) => options.onValue(splitPorts((event.target as HTMLTextAreaElement).value))}
    ></textarea>`;
  }

  return html`<input
    id=${id}
    type="text"
    data-param-control=${param.name}
    data-invalid=${String(invalid)}
    .value=${Array.isArray(current) ? current.join(', ') : String(current)}
    ?disabled=${disabled}
    title=${title}
    aria-invalid=${String(invalid)}
    @change=${(event: Event) => options.onValue(coerceParam(param, (event.target as HTMLInputElement).value))}
  />`;
}

/** 节点内的模式标记：手填 / 接线自上游；点击切换模式。 */
function renderCompactBadge(options: ParamFieldOptions): unknown {
  const { param, mode, source } = options;
  if (param.port === undefined) return nothing;
  const label = mode === 'port' ? (source === undefined ? '接线中' : `← ${shorten(source)}`) : '手填';
  return html`<button
    type="button"
    class="mode-badge ${mode}"
    data-mode=${mode}
    title=${mode === 'port' ? '这个参数当前由连线提供；点一下改成手填' : '这个参数当前是手填；点一下改成接线'}
    @click=${() => options.onMode?.(mode === 'port' ? 'inline' : 'port')}
  >${label}</button>`;
}

/** 属性面板里的模式切换：两个按钮，当前模式反显禁用。 */
function renderModeSwitch(options: ParamFieldOptions): unknown {
  const { mode, source } = options;
  const note = mode === 'port'
    ? source === undefined ? '接线：还没有连上，编译时会提示缺少输入' : `接线自 ${source}`
    : '手填值';
  return html`<div class="param-mode">
    <span class="hint">${note}</span>
    <button
      type="button"
      data-mode="inline"
      ?disabled=${mode === 'inline'}
      @click=${() => options.onMode?.('inline')}
    >手填</button>
    <button
      type="button"
      data-mode="port"
      ?disabled=${mode === 'port'}
      @click=${() => options.onMode?.('port')}
    >接线</button>
  </div>`;
}

function shorten(text: string): string {
  return text.length <= 12 ? text : `${text.slice(0, 11)}…`;
}
