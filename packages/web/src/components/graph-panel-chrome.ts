import { html, nothing } from 'lit';
import type {
  GraphDocument,
  GraphModule,
  ParamValue,
  PythonCapability,
  PythonTemplate,
  WorkflowIssue,
} from '@pwn2block/shared';
import { PYTHON_TEMPLATES } from '@pwn2block/shared';
import type { PayloadControlsModel } from '../viewmodel/toolbar';

/**
 * 画布面板的外围小部件（10 §2.1、§5、§6）：工具栏的运行按钮、Python 状态、节点库下方的
 * 模板/模块/分组入口，以及问题与存档提示。
 *
 * 全是**纯渲染**：只接收数据与回调，不持有状态、不读存储、不发请求。面板因此只剩装配逻辑，
 * 这些片段也能被单独测试与复用（例如以后的独立调试页）。
 */

export interface ChromeHandlers {
  /** 运行/终止：`run-all` 与 `abort` 由面板转成 `p2b-graph-run` 事件。 */
  readonly onCommand: (command: 'run-all' | 'abort') => void;
  /** 定位节点：问题列表、编译轨迹共用。 */
  readonly onLocate: (nodeId: string, extra?: { path?: readonly string[]; rounds?: Readonly<Record<string, number>> }) => void;
  readonly onTemplate: (template: PythonTemplate) => void;
  readonly onAddModule: (moduleId: string) => void;
  readonly onEditModule: (moduleId: string) => void;
  readonly onExportModule: (moduleId: string) => void;
  readonly onUngroup: (groupId: string) => void;
  readonly onDownloadRaw: (raw: string) => void;
  readonly onDiscardArchive: () => void;
}

export interface LoadFailureView {
  readonly reason: string;
  readonly raw: string;
  readonly issues?: readonly string[];
}

/** 运行/终止按钮：可用性与禁用原因全部来自控制器给的模型。 */
export function renderRunControls(controls: PayloadControlsModel | undefined, handlers: ChromeHandlers): unknown {
  if (controls === undefined) return nothing;
  return html`<span class="run-controls">
    <button
      data-run="run-all"
      ?disabled=${!controls.run.enabled}
      title=${controls.run.hint}
      aria-describedby="run-reason"
      @click=${() => handlers.onCommand('run-all')}
    >${controls.run.label}</button>
    <button
      data-run="abort"
      ?disabled=${!controls.abort.enabled}
      title=${controls.abort.disabledReason ?? controls.abort.hint}
      @click=${() => handlers.onCommand('abort')}
    >${controls.abort.label}</button>
    <span id="run-reason" class="hint">${controls.run.enabled ? '' : controls.run.hint}</span>
  </span>`;
}

/** Python 能力：不可用时写清原因，避免学习者以为节点坏了（06 §6）。 */
export function renderPythonStatus(capability: PythonCapability | undefined): unknown {
  if (capability === undefined) return html`<span class="bad">Python：未知</span>`;
  if (!capability.available) {
    return html`<span class="bad"
      >Python：不可用${capability.reason === undefined ? '' : `（${capability.reason}）`}</span
    >`;
  }
  const isolation = capability.isolated ? '已隔离' : '未隔离，仅开发';
  return html`<span class="ok">Python：${capability.backend} · ${isolation}</span>`;
}

/** Python 代码模板：一键新建 Python 节点并把模板代码填进去（10 §4.1、§6）。 */
export function renderTemplates(handlers: ChromeHandlers): unknown {
  return html`<section class="extras">
    <h3>Python 模板</h3>
    ${PYTHON_TEMPLATES.map(
      (template) => html`<button
        data-template=${template.id}
        title=${template.summary}
        @click=${() => handlers.onTemplate(template)}
      >${template.name}</button>`,
    )}
  </section>`;
}

/** 已定义的模块：显示种类/版本/被调用次数，并可插入调用节点（模块体在提取时生成）。 */
export function renderModules(document: GraphDocument, handlers: ChromeHandlers): unknown {
  const modules = document.modules ?? [];
  if (modules.length === 0) return nothing;
  const usage = new Map<string, number>();
  for (const node of document.nodes) {
    const id = typeof node.params.moduleId === 'string' ? node.params.moduleId : '';
    if (id !== '') usage.set(id, (usage.get(id) ?? 0) + 1);
  }
  return html`<section class="extras">
    <h3>模块</h3>
    ${modules.map(
      (module) => html`<div class="module-row">
        <button
          title="${module.kind === 'flow' ? '流程模块' : '数据模块'} · ${usage.get(module.id) ?? 0} 处调用"
          data-module=${module.id}
          @click=${() => handlers.onAddModule(module.id)}
        >${module.name} v${module.version}</button>
        <button data-edit-module=${module.id} @click=${() => handlers.onEditModule(module.id)}>编辑</button>
        <button data-export-module=${module.id} @click=${() => handlers.onExportModule(module.id)}>导出</button>
      </div>`,
    )}
  </section>`;
}

/** 已建的分组：只列名字与解组入口；分组是布局，改它不需要重新编译。 */
export function renderGroups(document: GraphDocument, handlers: ChromeHandlers): unknown {
  const groups = document.groups ?? [];
  if (groups.length === 0) return nothing;
  return html`<section class="extras">
    <h3>分组</h3>
    ${groups.map(
      (group) => html`<button data-group=${group.id} @click=${() => handlers.onUngroup(group.id)}
        >${group.name} · ${group.members.length} 个节点（解组）</button
      >`,
    )}
  </section>`;
}

/** 问题列表：错误红、警告黄，带「定位」按钮回到对应节点。 */
export function renderIssues(issues: readonly WorkflowIssue[], handlers: ChromeHandlers): unknown {
  if (issues.length === 0) return nothing;
  return html`<p>问题 ${issues.length} 条</p>
    <ul class="issues">
      ${issues.slice(0, 12).map(
        (issue) => html`<li class=${issue.severity}>
          ${issue.nodeId === ''
            ? nothing
            : html`<button class="link" @click=${() => handlers.onLocate(issue.nodeId)}>定位</button>
                <code>${issue.nodeId}</code> `}
          ${issue.message}
        </li>`,
      )}
    </ul>`;
}

/**
 * 存档读取失败：说明原因、列出旧积木的具体问题，并提供原文导出与「放弃旧存档」。
 *
 * 锁住期间不写存档：读不出来不等于首次进入，不能让一次自动保存把用户原来的内容抹掉（10 §5）。
 */
export function renderLoadFailure(failure: LoadFailureView, handlers: ChromeHandlers): unknown {
  return html`<div class="load-failure">
    <p class="bad">${failure.reason}</p>
    <p class="hint">
      已保留原文，画布暂时是空的；在点下面的按钮之前，新的编辑不会写进存档，避免覆盖原有内容。
    </p>
    ${failure.issues === undefined || failure.issues.length === 0
      ? nothing
      : html`<ul class="issues">
          ${failure.issues.map((issue) => html`<li class="warning">${issue}</li>`)}
        </ul>`}
    <p class="row">
      <button @click=${() => handlers.onDownloadRaw(failure.raw)}>导出原文</button>
      <button @click=${() => handlers.onDiscardArchive()}>从空白画布开始（放弃旧存档）</button>
    </p>
  </div>`;
}

/** 编译轨迹：分支选择、循环轮次、模块路径；点一条回到对应节点（06 §8）。 */
export function renderTrace(
  trace: readonly { readonly nodeId: string; readonly message: string; readonly path: readonly string[]; readonly rounds?: Readonly<Record<string, number>> }[],
  handlers: ChromeHandlers,
): unknown {
  if (trace.length === 0) return nothing;
  return html`<details class="trace">
    <summary>编译轨迹 ${trace.length} 条</summary>
    <ol>
      ${trace.slice(0, 40).map(
        (entry) => html`<li>
          <button
            class="link"
            @click=${() =>
              handlers.onLocate(entry.nodeId, {
                path: entry.path,
                ...(entry.rounds === undefined ? {} : { rounds: entry.rounds }),
              })}
          >${entry.nodeId}</button>
          ${entry.rounds === undefined
            ? ''
            : html`<span class="hint"
                >${Object.entries(entry.rounds)
                  .map(([id, round]) => `${id} 第 ${round + 1} 轮`)
                  .join('、')} </span
              >`}
          ${entry.message}
        </li>`,
      )}
    </ol>
  </details>`;
}

/** 模块调用节点要带的参数：模块 id/版本、输出类型与命名输入（10 §6）。 */
export function moduleCallParams(module: GraphModule): Record<string, ParamValue> {
  return {
    moduleId: module.id,
    moduleVersion: module.version,
    ...(module.output === undefined ? { hasOutput: 'no' } : { hasOutput: 'yes', outputType: module.output.type }),
    inputs: module.inputs.map((input) => `${input.name}:${input.type}`),
  };
}
