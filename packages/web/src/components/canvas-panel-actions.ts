import { dissolveEnvelope } from '../canvas/editor-envelope';
import { selectionRoots } from '../canvas/structure';
import type { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { createGroup, newNodeId, type CanvasEdit } from '../canvas/editor';
import { addReference, addVariable, applyInspectorChange, applyRowEdit, type InspectorChange } from './canvas-panel-commands';
import { applyConvertChange } from './canvas-panel-convert';
import { applyWrapSelection } from './canvas-panel-regions';

/**
 * 顶栏与工具箱上那几个「一次性动作」（加节点、成组、解组、加变量、导出）。
 *
 * 抽出来的理由：面板外壳要管文档、历史、存档与事件，再塞十几条动作就过长了；而这些动作
 * 只依赖「当前文档 + 选中集 + 一次编辑」，与 Lit 无关，所以它们收在一个小接口上。
 * 动作里面**不直接改文档**，全部走 `canvas/editor` 的命令。
 */

/** 动作需要的宿主能力（面板外壳实现）。 */
export interface PanelActionHost {
  currentDocument(): canvas.CanvasDocument | undefined;
  selection(): readonly string[];
  /** 包络后要把选区切到新容器，所以动作层也要能改选中集。 */
  selectNodes(ids: readonly string[]): void;
  applyEdit(edit: CanvasEdit): void;
  report(message: string | undefined): void;
  authorBlocks(): readonly AuthorBlock[] | undefined;
  exportSave(): string;
}

/** 「成组」：把选中的节点按选择顺序拼成一个组合。 */
export function groupSelection(host: PanelActionHost): void {
  const document = host.currentDocument();
  const ids = host.selection();
  if (document === undefined) return;
  if (ids.length < 1) {
    host.report('先选中数据结构再包络');
    return;
  }
  const id = newNodeId(document, 'group');
  const roots = selectionRoots(document, ids);
  const edit = createGroup(document, roots, id);
  host.applyEdit(edit);
  if (edit.issues.length === 0) host.selectNodes([id]);
}

/** 「解除组合」：对选中的第一个组合包络生效。 */
export function dissolveSelection(host: PanelActionHost): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  const selected = document.nodes.find((node) => host.selection().includes(node.id) && ['group', 'convert', 'loop', 'if'].includes(node.kind));
  if (selected === undefined) { host.report('先选中一个包络'); return; }
  const edit = dissolveEnvelope(document, selected.id);
  host.applyEdit(edit);
  if (edit.issues.length === 0) host.selectNodes([]);
}

/** 「加变量」：新建一个整数变量声明。 */
export function addVariableNode(host: PanelActionHost): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  host.applyEdit(addVariable(document));
}

/** 「引用变量」：给选中的声明（没有就用第一个）造一个引用视图。 */
export function addReferenceNode(host: PanelActionHost): void {
  const document = host.currentDocument();
  if (document === undefined) return;
  const declId = host.selection().find((id) => document.nodes.find((node) => node.id === id)?.kind === 'var-decl');
  host.applyEdit(addReference(document, declId));
}

/**
 * 侧栏改了一个字段：交给命令映射，改不动就说明白为什么。
 *
 * 包络与其它字段不同：它作用在**整段选区**上，成功还要把选区切到新容器，所以那两条在这里
 * 直接交给 `applyWrapSelection`；`applyInspectorChange` 里仍保留纯映射（同样按选区包），
 * 供只想要「一份编辑」的调用方使用。
 */
export function applyInspectorField(host: PanelActionHost, change: InspectorChange): void {
  const document = host.currentDocument();
  const nodeId = host.selection()[0];
  if (document === undefined || nodeId === undefined) return;
  if (change.kind === 'wrap-loop' || change.kind === 'wrap-branch') {
    applyWrapSelection(host, change.kind === 'wrap-loop' ? 'loop' : 'branch');
    return;
  }
  if (change.kind === 'wrap-convert' || change.kind === 'unwrap-convert') {
    applyConvertChange(host, change);
    return;
  }
  const authorBlocks = host.authorBlocks();
  const edit = change.kind === 'literal' ? applyRowEdit(document, nodeId, '值', change.value) : applyInspectorChange(
    document,
    nodeId,
    change,
    {
      ...(authorBlocks === undefined ? {} : { authorBlocks }),
      selection: host.selection(),
    },
  );
  if (edit === undefined) {
    host.report('这个字段在当前节点上没有对应的编辑命令');
    return;
  }
  host.applyEdit(edit);
}

/** 「导出存档」：优先复制到剪贴板；没有剪贴板就把取文本的办法说清楚。 */
export function copySave(host: PanelActionHost): void {
  const text = host.exportSave();
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) {
    host.report('当前环境没有剪贴板：请用 exportSave() 取存档文本');
    return;
  }
  clipboard.writeText(text).then(
    () => host.report('存档已复制到剪贴板'),
    () => host.report('复制失败：请用 exportSave() 取存档文本'),
  );
}
