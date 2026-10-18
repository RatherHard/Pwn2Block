import { NODE, nodeInputs, nodeOutput, nodeSpec } from '@pwn2block/shared';
import type { GraphDocument, GraphModule, GraphNode } from '@pwn2block/shared';
import { paramsOf } from '../workflow/document';
import { withDocument, type EditResult, type GraphEditorState } from './editor';

/**
 * 模块显式升级（06 §7；07 §P5）。
 *
 * 新版本**不会**自动改已有调用：调用节点钉住 `id + 版本`。升级是一个用户主动触发的
 * 编辑命令，先做兼容性预检，不兼容就拒绝并说清是哪一项，绝不半改：
 * - 输入集合（名字与类型）必须一致；
 * - 结果的“有无”与类型必须一致；
 * - 调用节点自己声明的端口也要与目标版本一致（防止旧端口残留）。
 */

export interface UpgradeTarget {
  readonly module: GraphModule;
  readonly version: number;
}

export function upgradeTargetOf(document: GraphDocument, node: GraphNode): UpgradeTarget | undefined {
  if (node.kind !== NODE.moduleData && node.kind !== NODE.moduleCall) return undefined;
  const id = typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '';
  const current = typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1;
  const versions = (document.modules ?? []).filter((module) => module.id === id);
  const latest = versions.reduce<GraphModule | undefined>(
    (best, module) => (best === undefined || module.version > best.version ? module : best),
    undefined,
  );
  if (latest === undefined || latest.version <= current) return undefined;
  return { module: latest, version: latest.version };
}

export function upgradeModule(state: GraphEditorState, nodeId: string): EditResult {
  const document = state.document;
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return { ok: false, message: '找不到这个调用节点' };
  const target = upgradeTargetOf(document, node);
  if (target === undefined) return { ok: false, message: '已经是最新版本' };
  const current = currentModule(document, node);
  const reason = compatibilityReason(current, target.module, node);
  if (reason !== undefined) return { ok: false, message: `不能升级到 v${target.version}：${reason}` };
  const nodes = document.nodes.map((candidate) =>
    candidate.id === nodeId
      ? { ...candidate, params: { ...candidate.params, moduleVersion: target.version } }
      : candidate,
  );
  return { ok: true, state: withDocument(state, { ...document, nodes }) };
}

function currentModule(document: GraphDocument, node: GraphNode): GraphModule | undefined {
  const id = typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '';
  const version = typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1;
  return (document.modules ?? []).find((module) => module.id === id && module.version === version);
}

function compatibilityReason(
  current: GraphModule | undefined,
  next: GraphModule,
  node: GraphNode,
): string | undefined {
  if (current !== undefined && current.kind !== next.kind) return '模块种类变了';
  const sameInputs =
    current !== undefined &&
    current.inputs.length === next.inputs.length &&
    current.inputs.every((input, index) => {
      const other = next.inputs[index];
      return other !== undefined && other.name === input.name && other.type === input.type;
    });
  if (!sameInputs) return '输入端口的名字或类型变了';
  const currentOut = current?.output?.type;
  const nextOut = next.output?.type;
  if (currentOut !== nextOut) return '结果的类型或有无变了';

  const spec = nodeSpec(node.kind);
  if (spec === undefined) return '调用节点种类不明';
  const declared = nodeInputs(spec, paramsOf(node, spec), { archBits: 64 });
  const matchesCall =
    declared.length === next.inputs.length &&
    declared.every((port, index) => {
      const other = next.inputs[index];
      return other !== undefined && other.name === port.name && other.type === port.type;
    });
  if (!matchesCall) return '调用节点声明的输入与目标版本不一致';
  const output = nodeOutput(spec, paramsOf(node, spec));
  if ((output?.type ?? undefined) !== nextOut) return '调用节点声明的输出与目标版本不一致';
  return undefined;
}
