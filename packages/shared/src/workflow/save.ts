import { z } from 'zod';
import { GraphDocumentSchema, GraphModuleSchema } from './schema';
import { WORKFLOW_VERSION, type GraphDocument, type GraphModule } from './types';

/**
 * 图存档与模块导出的包装格式（07 §P8）。
 *
 * 为什么要一层包装，而不是直接存 `GraphDocument`：
 * - 存档要能自证「属于哪道题」和「依赖了哪些固定版本的模块」，读到时先验这两件事，
 *   而不是等编译失败才发现拿错了题；
 * - 包装格式有自己的版本号，与 `GraphDocument.version`（节点/图语义版本）分开进位：
 *   以后只改存档外层（例如加签名）不必让所有图文档升版本。
 *
 * 两条硬约束：
 * - **只写文档，不写产物**：预览、来源表、编译轨迹都是编译结果，不能从存档恢复成有效产物。
 * - **依赖必须自洽**：`dependencies` 与文档里模块调用的 `moduleId`/`moduleVersion` 完全一致，
 *   缺一个就拒绝加载，避免出现「图里有调用、模块定义却没带过来」的半份存档。
 */

export const GRAPH_SAVE_FORMAT = 'pwn2block.graph-save';
export const GRAPH_MODULE_BUNDLE_FORMAT = 'pwn2block.graph-modules';
export const GRAPH_SAVE_VERSION = 1;

/** 一个固定版本依赖：模块 id + 版本。 */
export const GraphDependencySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  version: z.number().int().min(1).max(1000),
});
export type GraphDependency = z.infer<typeof GraphDependencySchema>;

export const GraphSaveSchema = z.strictObject({
  format: z.literal(GRAPH_SAVE_FORMAT),
  version: z.number().int().min(1),
  challengeId: z.string().min(1).max(64),
  dependencies: z.array(GraphDependencySchema).max(256),
  document: GraphDocumentSchema,
});

/** 对外用不可变接口；Schema 推导出来的是可变结构，不能直接当契约用。 */
export interface GraphSave {
  readonly format: typeof GRAPH_SAVE_FORMAT;
  readonly version: number;
  readonly challengeId: string;
  readonly dependencies: readonly GraphDependency[];
  readonly document: GraphDocument;
}

export const GraphModuleBundleSchema = z.strictObject({
  format: z.literal(GRAPH_MODULE_BUNDLE_FORMAT),
  version: z.number().int().min(1),
  module: GraphModuleSchema,
  /** 该模块内部调用到的模块定义（按需带上，不含自己）。 */
  dependencies: z.array(GraphModuleSchema).max(256),
});

export interface GraphModuleBundle {
  readonly format: typeof GRAPH_MODULE_BUNDLE_FORMAT;
  readonly version: number;
  readonly module: GraphModule;
  readonly dependencies: readonly GraphModule[];
}

export type ParseSaveResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

function firstIssue(error: z.ZodError): string {
  const first = error.issues[0];
  const where = first?.path.length ? `（${first.path.join('.')}）` : '';
  return `${where}${first?.message ?? '未知原因'}`;
}

/** 从图里所有模块调用节点收集依赖；模块定义本身也列进去，便于检查「定义是否随存档带走」。 */
export function dependenciesOf(document: GraphDocument): readonly GraphDependency[] {
  const found = new Map<string, GraphDependency>();
  const add = (id: string, version: number): void => {
    if (id === '' || !Number.isInteger(version) || version < 1) return;
    found.set(`${id}@${version}`, { id, version });
  };
  for (const module of document.modules ?? []) add(module.id, module.version);
  const nodes = [
    ...document.nodes,
    ...(document.modules ?? []).flatMap((module) => [...module.nodes]),
  ];
  for (const node of nodes) {
    const id = typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '';
    const version = typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1;
    add(id, version);
  }
  return [...found.values()].sort((a, b) => (a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id)));
}

/** 依赖表与文档是否一致：多一个少一个都算坏存档，不猜哪边是对的。 */
export function dependenciesMatch(
  document: GraphDocument,
  dependencies: readonly GraphDependency[],
): boolean {
  const expected = dependenciesOf(document);
  if (expected.length !== dependencies.length) return false;
  return expected.every((item, index) => {
    const actual = dependencies[index];
    return actual !== undefined && actual.id === item.id && actual.version === item.version;
  });
}

/** 构造一份可写入的存档对象（写入前调用，保证依赖表是新算的）。 */
export function makeGraphSave(challengeId: string, document: GraphDocument): GraphSave {
  return {
    format: GRAPH_SAVE_FORMAT,
    version: GRAPH_SAVE_VERSION,
    challengeId,
    dependencies: [...dependenciesOf(document)],
    document,
  };
}

/** 解析存档：形状、外层版本、题目、内在版本、依赖自洽，任何一项不符都返回原因。 */
export function parseGraphSave(
  raw: unknown,
  expectedChallengeId?: string,
): ParseSaveResult<GraphSave> {
  const parsed = GraphSaveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: `存档格式不对${firstIssue(parsed.error)}` };
  const save = parsed.data;
  if (save.version !== GRAPH_SAVE_VERSION) {
    return {
      ok: false,
      message: `存档外层版本 ${save.version} 不受支持，当前只认版本 ${GRAPH_SAVE_VERSION}`,
    };
  }
  if (save.document.version !== WORKFLOW_VERSION) {
    return {
      ok: false,
      message: `图版本 ${save.document.version} 不受支持，当前只认版本 ${WORKFLOW_VERSION}`,
    };
  }
  if (expectedChallengeId !== undefined && save.challengeId !== expectedChallengeId) {
    return {
      ok: false,
      message: `存档属于题目 ${save.challengeId}，不是当前的 ${expectedChallengeId}`,
    };
  }
  if (!dependenciesMatch(save.document, save.dependencies)) {
    return { ok: false, message: '存档里的模块依赖与图里的调用不一致：不加载这份存档' };
  }
  return { ok: true, value: save as GraphSave };
}

/** 收集一个模块及其递归依赖（按版本钉住），用于模块导出。 */
export function collectModuleBundle(
  document: GraphDocument,
  moduleId: string,
): GraphModuleBundle | undefined {
  const all = document.modules ?? [];
  const byKey = new Map(all.map((module) => [`${module.id}@${module.version}`, module]));
  const self = all.find((module) => module.id === moduleId);
  if (self === undefined) return undefined;

  const dependencies: GraphModule[] = [];
  const seen = new Set<string>([`${self.id}@${self.version}`]);
  const visit = (module: GraphModule): void => {
    for (const node of module.nodes) {
      const id = typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '';
      if (id === '') continue;
      const version = typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1;
      const key = `${id}@${version}`;
      if (seen.has(key)) continue;
      const dependency = byKey.get(key);
      if (dependency === undefined) continue;
      seen.add(key);
      dependencies.push(dependency);
      visit(dependency);
    }
  };
  visit(self);
  dependencies.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id.localeCompare(b.id)));
  return {
    format: GRAPH_MODULE_BUNDLE_FORMAT,
    version: GRAPH_SAVE_VERSION,
    module: self,
    dependencies,
  };
}

/** 解析模块导出：版本、依赖自洽都检查；失败时给出可展示原因。 */
export function parseModuleBundle(raw: unknown): ParseSaveResult<GraphModuleBundle> {
  const parsed = GraphModuleBundleSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: `模块文件格式不对${firstIssue(parsed.error)}` };
  const bundle = parsed.data;
  if (bundle.version !== GRAPH_SAVE_VERSION) {
    return {
      ok: false,
      message: `模块文件版本 ${bundle.version} 不受支持，当前只认版本 ${GRAPH_SAVE_VERSION}`,
    };
  }
  if (!bundleCoversCalls(bundle.module, bundle.dependencies)) {
    return { ok: false, message: '模块文件缺少它调用到的模块定义：不导入这份文件' };
  }
  return { ok: true, value: bundle as GraphModuleBundle };
}

/** 模块本身和它带上的每个依赖都被调用时，调用目标必须在这批定义里。 */
function bundleCoversCalls(
  module: GraphModule,
  dependencies: readonly GraphModule[],
): boolean {
  const available = new Set(
    [module, ...dependencies].map((candidate) => `${candidate.id}@${candidate.version}`),
  );
  for (const candidate of [module, ...dependencies]) {
    for (const node of candidate.nodes) {
      const id = typeof node.params.moduleId === 'string' ? node.params.moduleId.trim() : '';
      if (id === '') continue;
      const version = typeof node.params.moduleVersion === 'number' ? node.params.moduleVersion : 1;
      if (!available.has(`${id}@${version}`)) return false;
    }
  }
  return true;
}
