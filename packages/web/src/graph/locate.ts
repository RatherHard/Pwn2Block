import type { GraphDocument, GraphModule } from '@pwn2block/shared';
import type { WorkflowIssue } from '@pwn2block/shared';
import type { WorkflowOrigin } from '../workflow/types';

/**
 * 来源定位（07 §P8；06 §8）。
 *
 * 一条 VM 动作可能来自：主图节点、某个模块实例里的节点、某个分支区域、第 n 轮循环。
 * 画布只显示一张图，所以定位要做两件事：
 * 1. **展开**路径上被折叠的容器，否则目标节点在屏幕上不可见；
 * 2. 如果节点在模块体里，**切到模块视图**再去选中它。
 *
 * 这里只改布局（`layout[].collapsed`），不碰语义；定位因此不会让产物过期。
 */

export interface LocateRequest {
  readonly nodeId: string;
  /** 编译期路径，例如 `['main', 'if-1/then']`。 */
  readonly path?: readonly string[];
  /** 模块调用链（`id@版本`，外层到内层）。 */
  readonly modules?: readonly string[];
  /** 已经知道要进哪个模块时优先用它。 */
  readonly moduleId?: string;
  readonly rounds?: Readonly<Record<string, number>>;
}

export interface LocateResult {
  /** 已展开相关容器的文档；调用方用它替换当前文档（只涨布局版本）。 */
  readonly document: GraphDocument;
  readonly nodeId: string;
  /** 需要进入的模块 id；`undefined` 表示目标在主图。 */
  readonly moduleId?: string;
  /** 路径上被展开的容器 id。 */
  readonly expanded: readonly string[];
  /** 供界面显示的定位说明（模块、分支、轮次）。 */
  readonly detail: string;
}

/** 从路径里取容器 id：`if-1/then` → `if-1`；`main` 没有容器。 */
export function containerIdsOf(path: readonly string[] | undefined): readonly string[] {
  if (path === undefined) return [];
  const ids: string[] = [];
  for (const segment of path) {
    const slash = segment.indexOf('/');
    if (slash <= 0) continue;
    const id = segment.slice(0, slash);
    if (id !== '' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function findModule(
  document: GraphDocument,
  ref: string,
): GraphModule | undefined {
  const at = ref.lastIndexOf('@');
  const id = at < 0 ? ref : ref.slice(0, at);
  const version = at < 0 ? Number.NaN : Number.parseInt(ref.slice(at + 1), 10);
  const modules = document.modules ?? [];
  const exact = modules.find((candidate) => candidate.id === id && candidate.version === version);
  return exact ?? modules.find((candidate) => candidate.id === id);
}

function moduleHoldingNode(document: GraphDocument, nodeId: string): GraphModule | undefined {
  return (document.modules ?? []).find((module) =>
    module.nodes.some((node) => node.id === nodeId),
  );
}

/** 把容器从折叠改成展开；只改布局，不动节点与连线。 */
function expandCollapsed(
  layout: Readonly<Record<string, { x: number; y: number; collapsed?: boolean }>>,
  ids: readonly string[],
): { layout: Record<string, { x: number; y: number; collapsed?: boolean }>; expanded: string[] } {
  const next = { ...layout };
  const expanded: string[] = [];
  for (const id of ids) {
    const entry = next[id];
    if (entry === undefined || entry.collapsed !== true) continue;
    next[id] = { ...entry, collapsed: false };
    expanded.push(id);
  }
  return { layout: next, expanded };
}

/**
 * 定位一个节点（可选带编译期路径与模块链）。
 *
 * 找不到节点时返回 `undefined`：界面应说「来源未知」，而不是高亮一个不存在的位置。
 */
export function locateTarget(document: GraphDocument, request: LocateRequest): LocateResult | undefined {
  const requestedModule =
    request.moduleId !== undefined
      ? (document.modules ?? []).find((module) => module.id === request.moduleId)
      : request.modules !== undefined && request.modules.length > 0
        ? findModule(document, request.modules[request.modules.length - 1] as string)
        : undefined;

  const holder = requestedModule ?? moduleHoldingNode(document, request.nodeId);
  const containerIds = containerIdsOf(request.path);

  if (holder === undefined) {
    if (!document.nodes.some((node) => node.id === request.nodeId)) return undefined;
    const { layout, expanded } = expandCollapsed(document.layout, containerIds);
    return {
      document: layout === document.layout ? document : { ...document, layout },
      nodeId: request.nodeId,
      expanded,
      detail: describe(request, undefined),
    };
  }

  const body = expandCollapsed(holder.layout, containerIds);
  const module: GraphModule = { ...holder, layout: body.layout };
  const modules = (document.modules ?? []).map((candidate) =>
    candidate.id === holder.id && candidate.version === holder.version ? module : candidate,
  );
  return {
    document: { ...document, modules },
    nodeId: request.nodeId,
    moduleId: holder.id,
    expanded: body.expanded,
    detail: describe(request, holder),
  };
}

function describe(request: LocateRequest, module: GraphModule | undefined): string {
  const parts: string[] = [];
  if (module !== undefined) parts.push(`模块 ${module.name}（${module.id}@${module.version}）`);
  if (request.path !== undefined && request.path.length > 1) {
    parts.push(`路径 ${request.path.join(' → ')}`);
  }
  if (request.rounds !== undefined) {
    const rounds = Object.entries(request.rounds)
      .map(([id, round]) => `${id} 第 ${round + 1} 轮`)
      .join('、');
    if (rounds !== '') parts.push(rounds);
  }
  return parts.length === 0 ? '主图' : parts.join('；');
}

/** 把来源表里的第 `index` 条动作翻成定位请求；越界或没有节点时返回 `undefined`。 */
export function locateRequestForOrigin(
  origins: readonly WorkflowOrigin[],
  index: number,
): LocateRequest | undefined {
  if (!Number.isInteger(index) || index < 0) return undefined;
  const origin = origins[index];
  if (origin === undefined || origin.index !== index || origin.nodeId === '') return undefined;
  return {
    nodeId: origin.nodeId,
    path: origin.path,
    ...(origin.modules === undefined ? {} : { modules: origin.modules }),
    ...(origin.rounds === undefined ? {} : { rounds: origin.rounds }),
  };
}

/** 编译错误 → 定位请求。错误没有路径时仍然定位节点。 */
export function locateRequestForIssue(issue: WorkflowIssue): LocateRequest | undefined {
  if (issue.nodeId === '') return undefined;
  return { nodeId: issue.nodeId };
}
