import { html, nothing } from 'lit';
import type { ParamSpec, ParamValue } from '@pwn2block/shared';
import { checkParam } from '../workflow/params';

/**
 * 属性面板的参数控件：统一负责值、手填/接线模式和校验提示。
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
  readonly onValue: (value: ParamValue) => void;
  readonly onMode?: (mode: 'inline' | 'port') => void;
}

/** 属性面板参数控件的 DOM id。 */
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

/** 参数值是否「接了线」：接了线时属性面板输入框只读，避免误改导致断线。 */
export function isBoundToPort(options: ParamFieldOptions): boolean {
  return options.param.port !== undefined && options.mode === 'port' && options.source !== undefined;
}

export function renderParamField(options: ParamFieldOptions): unknown {
  const { param, value } = options;
  const id = paramIdOf(options.nodeId, param.name);
  const reason = checkParam(param, value === undefined ? param.default : value);
  const bound = isBoundToPort(options);
  const error = reason === undefined
    ? nothing
    : html`<span class="bad param-error" role="alert">${reason}</span>`;
  return html`<div class="param-field full" data-param=${param.name}>
    <label for=${id}>${param.label}</label>
    <div class="param-line">
      ${renderControl(options, id, reason, bound)}
    </div>
    ${error}
    ${param.port === undefined ? nothing : renderModeSwitch(options)}
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

  if (param.kind === 'portList') {
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
