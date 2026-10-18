import type { GraphDocument } from '@pwn2block/shared';
import { createEditor, withDocument, type EditResult, type GraphEditorState } from './editor';

/**
 * 模块体编辑（06 §7；07 §P5）。
 *
 * 主图是唯一事实来源：进入模块时把模块体当成一份独立文档交给画布，编辑后立刻写回
 * 主图的 `modules` 里，撤销/重做也只作用于主图。这样「模块版本、输入输出、说明」
 * 不会被编辑动作改掉，面包屑返回时主图就是最新的。
 */

export function moduleViewDocument(document: GraphDocument, moduleId: string): GraphDocument | undefined {
  const module = (document.modules ?? []).find((candidate) => candidate.id === moduleId);
  if (module === undefined) return undefined;
  return {
    ...document,
    nodes: module.nodes,
    connections: module.connections,
    main: module.main,
    layout: module.layout,
    groups: [],
    modules: [],
  };
}

export function moduleViewState(
  main: GraphEditorState,
  moduleId: string,
  selection: readonly string[] = [],
): GraphEditorState | undefined {
  const view = moduleViewDocument(main.document, moduleId);
  if (view === undefined) return undefined;
  return { ...createEditor(view), selection };
}

export function withModuleBody(
  main: GraphEditorState,
  moduleId: string,
  body: GraphDocument,
  kind: 'semantic' | 'layout' = 'semantic',
): EditResult {
  const modules = main.document.modules ?? [];
  if (!modules.some((module) => module.id === moduleId)) {
    return { ok: false, message: `找不到模块 ${moduleId}` };
  }
  const next = modules.map((module) =>
    module.id === moduleId
      ? {
          ...module,
          nodes: body.nodes,
          connections: body.connections,
          main: body.main,
          layout: body.layout,
        }
      : module,
  );
  const document: GraphDocument = { ...main.document, modules: next };
  return { ok: true, state: withDocument(main, document, kind) };
}
