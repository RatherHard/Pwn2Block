import { NODE, nodeInputs, nodeOutput, nodeSpec } from '@pwn2block/shared';
import type { GraphConnection, GraphDocument, GraphModule, GraphNode, ParamValues } from '@pwn2block/shared';
import { lookupGraph } from '../workflow/document';
import type { GraphEditorState } from './editor';
import { withDocument } from './editor';

/**
 * 提取为模块（06 §7；07 §P5）。
 *
 * 这是**纯编辑命令**：只搬节点、连线与序列，不编译、不执行。规则刻意保守，宁可拒绝
 * 也不猜学习者的意图：
 * - 选区必须在同一个执行区域里连续；
 * - 选中的容器必须连内部语句一起选，否则报「控制结构不完整」；
 * - 选区只能有一个外部数据消费者（模块只有一个结果）；
 * - 目前只支持纯数据选区：动作与控制结构由流程模块承载，那条路尚未开放。
 *
 * 拒绝时返回一句能直接展示的原因，不改状态。
 */

export type ExtractOutcome =
  | { readonly ok: true; readonly state: GraphEditorState; readonly moduleId: string }
  | { readonly ok: false; readonly message: string };

export interface ExtractOptions {
  /** 模块显示名；缺省用模块 id。 */
  readonly name?: string;
  /** 模块 id 前缀；缺省 `mod`，重复时自动加序号。 */
  readonly prefix?: string;
}

export function extractModule(
  state: GraphEditorState,
  ids: readonly string[],
  options: ExtractOptions = {},
): ExtractOutcome {
  const document = state.document;
  const selected = ids.filter((id) => id !== 'start' && document.nodes.some((node) => node.id === id));
  if (selected.length === 0) return refuse('先选中要提取的节点');
  const lookup = lookupGraph(document);
  const placements = selected.map((id) => lookup.placements.get(id));
  if (placements.some((placement) => placement === undefined)) {
    return refuse('选中的节点里有还没放进执行序列的：先把它拖进流程再提取');
  }
  const paths = new Set(placements.map((placement) => placement?.path.join('/') ?? ''));
  if (paths.size !== 1) return refuse('选区跨了多个执行区域：一次只能提取同一个区域里的连续片段');

  const path = placements[0]?.path ?? ['main'];
  const sequence = sequenceOf(document, path);
  if (sequence === undefined) return refuse('找不到选区所在的执行区域');
  const indices = selected
    .map((id) => sequence.indexOf(id))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  if (indices.length !== selected.length) return refuse('选区里有节点不在它声明的执行区域里');
  for (let offset = 1; offset < indices.length; offset += 1) {
    if ((indices[offset] as number) !== (indices[offset - 1] as number) + 1) {
      return refuse('选区不连续：先把要提取的语句排在一起');
    }
  }

  const inside = new Set(selected);
  for (const node of document.nodes) {
    if (!selected.includes(node.id)) continue;
    for (const members of Object.values(node.regions ?? {})) {
      if (members.some((member) => !inside.has(member))) {
        return refuse(`「${labelOf(node)}」的控制结构没选全：把它的内部语句一起选上，或先移出容器`);
      }
    }
  }
  const hasExec = selected.some((id) => {
    const node = document.nodes.find((candidate) => candidate.id === id);
    const spec = node === undefined ? undefined : nodeSpec(node.kind);
    return spec?.exec === true;
  });
  const kind = hasExec ? 'flow' : 'data';

  const boundary = splitBoundary(document, inside);
  if (boundary.inputs.some((edge) => edge.type === undefined)) {
    return refuse('选区的输入端口类型不明：检查连线是否完整');
  }
  if (boundary.outputs.length > 1) {
    return refuse('选区有多个外部消费者：模块只有一个结果，先让它们共用同一个输出');
  }
  const inputNames = new Set(boundary.inputs.map((edge) => edge.port));
  if (inputNames.size !== boundary.inputs.length) {
    return refuse('选区的多个输入用了同一个端口名：模块输入需要唯一名字');
  }
  const unused = selected.filter((id) => isUnusedInside(document, inside, id, boundary.outputs[0]));
  if (unused.length > 0) {
    return refuse(`「${labelOf(document.nodes.find((node) => node.id === unused[0]))}」的结果没有被选区内用到`);
  }

  const moduleId = freeModuleId(document, options.prefix ?? 'mod');
  const built = buildModule(document, selected, inside, boundary, {
    id: moduleId,
    name: options.name ?? moduleId,
    path,
    indices,
    kind,
  });
  const rewritten = rewriteMain(document, selected, path, {
    moduleId,
    kind,
    inputs: boundary.inputs,
    ...(boundary.outputs[0] === undefined ? {} : { output: boundary.outputs[0] }),
  });
  return { ok: true, state: withDocument(state, { ...rewritten, modules: [...(document.modules ?? []), built] }), moduleId };
}

interface BoundaryEdge {
  readonly node: string;
  readonly port: string;
  readonly type?: string;
  /** 输入侧：从哪个外部节点/端口来；输出侧：去哪个外部节点/端口。 */
  readonly fromNode?: string;
  readonly fromPort?: string;
  readonly toNode?: string;
  readonly toPort?: string;
}

interface Boundary {
  readonly inputs: readonly BoundaryEdge[];
  readonly outputs: readonly BoundaryEdge[];
}

function splitBoundary(document: GraphDocument, inside: ReadonlySet<string>): Boundary {
  const inputs: BoundaryEdge[] = [];
  const outputs: BoundaryEdge[] = [];
  for (const connection of document.connections) {
    const fromIn = inside.has(connection.from.node);
    const toIn = inside.has(connection.to.node);
    if (fromIn === toIn) continue;
    if (toIn) {
      inputs.push({
        node: connection.to.node,
        port: connection.to.port,
        type: typeOfInput(document, connection.to.node, connection.to.port),
        fromNode: connection.from.node,
        fromPort: connection.from.port,
      });
    } else {
      outputs.push({
        node: connection.from.node,
        port: connection.from.port,
        type: typeOfOutput(document, connection.from.node, connection.from.port),
        toNode: connection.to.node,
        toPort: connection.to.port,
      });
    }
  }
  return { inputs, outputs };
}

function typeOfInput(document: GraphDocument, nodeId: string, port: string) {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  const spec = node === undefined ? undefined : nodeSpec(node.kind);
  if (node === undefined || spec === undefined) return undefined;
  return nodeInputs(spec, node.params, { archBits: 64 }).find((candidate) => candidate.name === port)?.type;
}

function typeOfOutput(document: GraphDocument, nodeId: string, port: string) {
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  const spec = node === undefined ? undefined : nodeSpec(node.kind);
  if (node === undefined || spec === undefined || port !== 'out') return undefined;
  return nodeOutput(spec, node.params)?.type;
}

function isUnusedInside(
  document: GraphDocument,
  inside: ReadonlySet<string>,
  id: string,
  output: BoundaryEdge | undefined,
): boolean {
  const node = document.nodes.find((candidate) => candidate.id === id);
  const spec = node === undefined ? undefined : nodeSpec(node.kind);
  if (node === undefined || spec === undefined || spec.exec) return false;
  if (output?.node === id) return false;
  const consumed = document.connections.some(
    (connection) => connection.from.node === id && inside.has(connection.to.node),
  );
  return nodeOutput(spec, node.params) !== undefined && !consumed;
}

interface ModuleSeed {
  readonly id: string;
  readonly name: string;
  readonly path: readonly string[];
  readonly indices: readonly number[];
  readonly kind: 'data' | 'flow';
}

function buildModule(
  document: GraphDocument,
  selected: readonly string[],
  inside: ReadonlySet<string>,
  boundary: Boundary,
  seed: ModuleSeed,
): GraphModule {
  const nodes: GraphNode[] = selected.map((id) => document.nodes.find((node) => node.id === id) as GraphNode);
  const connections: GraphConnection[] = document.connections.filter(
    (connection) => inside.has(connection.from.node) && inside.has(connection.to.node),
  );
  // 外部输入变成模块作用域里的变量：每个输入端口建一个「读变量」节点接进原来的入端口。
  const seenInputs = new Set<string>();
  for (const edge of boundary.inputs) {
    const name = edge.port;
    if (!seenInputs.has(name)) {
      seenInputs.add(name);
      nodes.push({
        id: `in_${name}`,
        kind: NODE.varGet,
        params: { name, type: edge.type ?? 'bytes' } satisfies ParamValues,
      });
    }
    connections.push({ from: { node: `in_${name}`, port: 'out' }, to: { node: edge.node, port: portNameOf(edge) } });
  }
  const output = boundary.outputs[0];
  const layout = { ...document.layout };
  const main = [...selected];
  let offset = 0;
  for (const id of main) {
    layout[id] = layout[id] ?? { x: 40 + offset * 260, y: 40 };
    offset += 1;
  }
  if (output !== undefined) {
    nodes.push({
      id: 'out',
      kind: NODE.moduleReturn,
      params: { valueType: output.type ?? 'bytes' } satisfies ParamValues,
    });
    connections.push({ from: { node: output.node, port: output.port }, to: { node: 'out', port: 'value' } });
    main.push('out');
    layout.out = { x: 40 + offset * 260, y: 40 };
  }
  return {
    id: seed.id,
    name: seed.name,
    summary: `从 ${seed.path.join('/')} 提取`,
    kind: seed.kind,
    version: 1,
    inputs: boundary.inputs.map((edge) => ({ name: edge.port, type: (edge.type ?? 'bytes') as GraphModule['inputs'][number]['type'] })),
    ...(output === undefined
      ? {}
      : { output: { name: 'out', type: (output.type ?? 'bytes') as GraphModule['inputs'][number]['type'] } }),
    nodes,
    connections,
    main,
    layout,
  };
}

function rewriteMain(
  document: GraphDocument,
  selected: readonly string[],
  path: readonly string[],
  call: {
    readonly moduleId: string;
    readonly kind: 'data' | 'flow';
    readonly inputs: readonly BoundaryEdge[];
    readonly output?: BoundaryEdge;
  },
): GraphDocument {
  const output = call.output;
  const callNode: GraphNode = {
    id: freeNodeId(document, 'extracted'),
    kind: call.kind === 'data' ? NODE.moduleData : NODE.moduleCall,
    params: {
      moduleId: call.moduleId,
      moduleVersion: 1,
      ...(output === undefined
        ? { hasOutput: 'no' }
        : { hasOutput: 'yes', outputType: output.type ?? 'bytes' }),
      ...(call.kind === 'data' && output !== undefined ? { outputType: output.type ?? 'bytes' } : {}),
      inputs: call.inputs.map((edge) => `${edge.port}:${edge.type ?? 'bytes'}`),
    },
  };
  const withoutSelected = document.nodes.filter((node) => !selected.includes(node.id));
  const region = sequenceOf(document, path);
  const nextRegion = [...(region ?? [])];
  const removed = new Set(selected);
  const nextSequence = nextRegion.filter((id) => !removed.has(id));
  const insertAt = countBefore(nextSequence, region ?? [], removed);
  nextSequence.splice(insertAt, 0, callNode.id);
  const nodes = [...withoutSelected, callNode];
  const connections = [
    ...document.connections.filter(
      (connection) => !removed.has(connection.from.node) && !removed.has(connection.to.node),
    ),
    ...call.inputs.map((edge) => ({
      from: { node: edge.fromNode as string, port: edge.fromPort as string },
      to: { node: callNode.id, port: edge.port },
    })),
    ...(output === undefined
      ? []
      : [{ from: { node: callNode.id, port: 'out' }, to: { node: output.toNode as string, port: output.toPort as string } }]),
  ];
  if (path.length === 1) {
    return { ...document, nodes, connections, main: nextSequence };
  }
  const containerId = path[path.length - 1]?.split('/')[0] ?? '';
  const regionName = path[path.length - 1]?.split('/')[1] ?? '';
  return {
    ...document,
    nodes: nodes.map((node) =>
      node.id === containerId && node.regions !== undefined
        ? { ...node, regions: { ...node.regions, [regionName]: nextSequence } }
        : node,
    ),
    connections,
  };
}

function countBefore(sequence: readonly string[], original: readonly string[], removed: ReadonlySet<string>): number {
  let index = 0;
  for (const id of original) {
    if (removed.has(id)) return index;
    if (sequence.includes(id)) index += 1;
  }
  return index;
}

function sequenceOf(document: GraphDocument, path: readonly string[]): readonly string[] | undefined {
  if (path.length === 1) return document.main;
  const last = path[path.length - 1] ?? '';
  const [containerId, region] = last.split('/');
  const container = document.nodes.find((node) => node.id === containerId);
  return container?.regions?.[region ?? ''] ?? undefined;
}

function freeNodeId(document: GraphDocument, base: string): string {
  let index = 1;
  while (document.nodes.some((node) => node.id === `${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function freeModuleId(document: GraphDocument, prefix: string): string {
  const modules = document.modules ?? [];
  let index = 1;
  while (modules.some((module) => module.id === `${prefix}${index}`)) index += 1;
  return `${prefix}${index}`;
}

function labelOf(node: GraphNode | undefined): string {
  if (node === undefined) return '节点';
  return nodeSpec(node.kind)?.label ?? node.kind;
}

function portNameOf(edge: BoundaryEdge): string {
  return edge.port;
}

function refuse(message: string): ExtractOutcome {
  return { ok: false, message };
}
