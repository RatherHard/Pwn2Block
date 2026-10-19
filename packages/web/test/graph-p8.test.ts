import { describe, expect, it } from 'vitest';
import {
  GRAPH_MODULE_BUNDLE_FORMAT,
  GRAPH_SAVE_FORMAT,
  NODE,
  emptyGraphDocument,
  collectModuleBundle,
  dependenciesMatch,
  makeGraphSave,
  parseGraphDocument,
  parseModuleBundle,
} from '@pwn2block/shared';
import type { GraphDocument, GraphModule } from '@pwn2block/shared';
import { migrateBlocklyWorkspace } from '../src/graph/migrate-blockly';
import { locateRequestForOrigin, locateTarget } from '../src/graph/locate';
import {
  graphStorageKey,
  interimGraphStorageKey,
  loadGraph,
  saveGraph,
} from '../src/graph/storage';
import type { KeyValueStore } from '../src/viewmodel/storage';
import { compileGraph } from '../src/workflow/compile';

/**
 * P8：存档迁移、模块依赖与来源定位（07 §P8）。
 *
 * 这一组只测纯数据层：假的 `KeyValueStore`、Blockly 的序列化 JSON、图文档与编译结果。
 * 不碰 DOM，也不 import Blockly——迁移解析器只认 JSON，P9 删掉画布库后这些用例仍然成立。
 */

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function block(type: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, id, ...extra };
}

function chain(...blocks: Record<string, unknown>[]): Record<string, unknown> {
  const [head, ...rest] = blocks;
  if (head === undefined) throw new Error('空链');
  return rest.length === 0 ? head : { ...head, next: { block: chain(...rest) } };
}

function value(input: string, type: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { [input]: { block: block(type, id, extra) } };
}

function blocklySample(): Record<string, unknown> {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        chain(
          block('start', 'start-1', { x: 0, y: 0 }),
          block('vars_set', 'set-1', {
            fields: { VAR: { id: 'var-n' } },
            inputs: value('VALUE', 'math_number', 'num-5', { fields: { NUM: 5 } }),
          }),
          block('action_step', 'step-1', {
            inputs: value('COUNT', 'vars_get', 'get-n', { fields: { VAR: { id: 'var-n' } } }),
          }),
          block('action_write_bytes', 'write-1', {
            inputs: {
              ADDR: { block: block('math_number', 'num-addr', { fields: { NUM: 0x400000 } }) },
              BYTES: {
                block: block('bytes_raw', 'raw-1', { fields: { HEX: '41424344' } }),
              },
            },
          }),
        ),
      ],
    },
    variables: [{ name: 'n', id: 'var-n' }],
  };
}

function withHexNode(): GraphDocument {
  const base = emptyGraphDocument();
  return {
    ...base,
    nodes: [...base.nodes, { id: 'hex1', kind: NODE.hex, params: { hex: '4142' } }],
    layout: { ...base.layout, hex1: { x: 40, y: 120 } },
  };
}

function module(id: string, version: number, extra: Partial<GraphModule> = {}): GraphModule {
  return {
    id,
    name: id,
    summary: '',
    kind: 'data',
    version,
    inputs: [],
    nodes: [{ id: 'out', kind: NODE.hex, params: { hex: '41' } }],
    connections: [],
    main: ['out'],
    layout: {},
    ...extra,
  };
}

describe('旧 Blockly 存档迁移', () => {
  it('保留变量、字节与动作语义，编译成同样的动作', async () => {
    const migrated = migrateBlocklyWorkspace(blocklySample());
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;

    const parsed = parseGraphDocument(migrated.document);
    expect(parsed.ok).toBe(true);

    const outcome = await compileGraph({
      document: migrated.document,
      context: { archBits: 64, allowedActions: ['step', 'write_bytes'] },
      documentRevision: 1,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.artifact.actions).toEqual([
      { type: 'step', count: 5 },
      { type: 'write_bytes', addr: '0x400000', hex: '41424344' },
    ]);
  });

  it('拒绝未知积木并给出具体原因，不产出半张图', () => {
    const save = blocklySample();
    const chainBlock = (save['blocks'] as { blocks: Record<string, unknown>[] }).blocks[0] as Record<string, unknown>;
    const next = chainBlock['next'] as { block: Record<string, unknown> };
    next.block['type'] = 'mystery_block';
    const result = migrateBlocklyWorkspace(save);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join('\n')).toContain('mystery_block');
  });

  it('没有开始积木、多个开始积木都明确失败', () => {
    const single = blocklySample();
    (single['blocks'] as { blocks: Record<string, unknown>[] }).blocks[0] = block('action_step', 'only');
    expect(migrateBlocklyWorkspace(single).ok).toBe(false);

    const twice = blocklySample();
    (twice['blocks'] as { blocks: Record<string, unknown>[] }).blocks.push(block('start', 'start-2'));
    const result = migrateBlocklyWorkspace(twice);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons[0]).toContain('2 个');
  });

  it('只读未赋值的变量会被拒绝（旧编译器同样报错）', () => {
    const save = blocklySample();
    const chainBlock = (save['blocks'] as { blocks: Record<string, unknown>[] }).blocks[0] as Record<string, unknown>;
    const set = (chainBlock['next'] as { block: Record<string, unknown> }).block;
    set['type'] = 'action_step';
    set['inputs'] = value('COUNT', 'vars_get', 'get-x', { fields: { VAR: { id: 'var-x' } } });
    delete set['fields'];
    const result = migrateBlocklyWorkspace(save);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons.join('\n')).toContain('只被读取');
  });
});

describe('存档包装与模块依赖', () => {
  it('依赖表由文档算出并参与校验', () => {
    const base = emptyGraphDocument();
    const document: GraphDocument = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'call1', kind: NODE.moduleData, params: { moduleId: 'm', moduleVersion: 2 } },
      ],
      main: ['call1'],
      modules: [module('m', 2)],
    };
    const save = makeGraphSave('ret2win', document);
    expect(save.format).toBe(GRAPH_SAVE_FORMAT);
    expect(save.dependencies).toEqual([{ id: 'm', version: 2 }]);
    expect(dependenciesMatch(document, save.dependencies)).toBe(true);
    expect(dependenciesMatch(document, [])).toBe(false);

    const store = memoryStore();
    expect(saveGraph(store, 'ret2win', document)).toBe(true);
    expect(loadGraph(store, 'ret2win').ok).toBe(true);
  });

  it('模块导出携带递归依赖，缺依赖的文件拒绝导入', () => {
    const leaf = module('leaf', 1);
    const root = module('root', 1, {
      kind: 'data',
      nodes: [{ id: 'call', kind: NODE.moduleData, params: { moduleId: 'leaf', moduleVersion: 1 } }],
      main: ['call'],
    });
    const document: GraphDocument = { ...emptyGraphDocument(), modules: [root, leaf] };

    const bundle = collectModuleBundle(document, 'root');
    expect(bundle).toBeDefined();
    expect(bundle?.dependencies.map((item) => item.id)).toEqual(['leaf']);
    expect(parseModuleBundle(bundle).ok).toBe(true);

    const missing = {
      format: GRAPH_MODULE_BUNDLE_FORMAT,
      version: 1,
      module: root,
      dependencies: [],
    };
    const result = parseModuleBundle(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('缺少');
  });
});

describe('读取顺序、保留旧存档与失败不覆盖', () => {
  it('没有存档时明确说明，不写任何键', () => {
    const store = memoryStore();
    const result = loadGraph(store, 'ret2win');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('empty');
    expect(store.data.size).toBe(0);
  });

  it('中期裸图搬到新键，旧键保留', () => {
    const document = withHexNode();
    const store = memoryStore({ [interimGraphStorageKey('ret2win')]: JSON.stringify(document) });
    const result = loadGraph(store, 'ret2win');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('interim');
    expect(store.data.get(graphStorageKey('ret2win'))).toBeDefined();
    expect(store.data.get(interimGraphStorageKey('ret2win'))).toBe(JSON.stringify(document));
  });

  it('旧积木迁移成功后保留原键，新键可再次加载', () => {
    const raw = JSON.stringify(blocklySample());
    const store = memoryStore({ 'pwn2block.canvas.v1.ret2win': raw });
    const first = loadGraph(store, 'ret2win');
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.source).toBe('blockly');
    expect(store.data.get('pwn2block.canvas.v1.ret2win')).toBe(raw);
    const second = loadGraph(store, 'ret2win');
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.source).toBe('current');
  });

  it('旧积木迁移失败时保留原文并列出原因，不写新键', () => {
    const save = blocklySample();
    const head = (save['blocks'] as { blocks: Record<string, unknown>[] }).blocks[0] as Record<string, unknown>;
    const nested = head['next'] as { block: Record<string, unknown> };
    nested.block['type'] = 'mystery_block';
    const raw = JSON.stringify(save);
    const store = memoryStore({ 'pwn2block.canvas.v1.ret2win': raw });
    const result = loadGraph(store, 'ret2win');
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'corrupt') {
      expect(result.raw).toBe(raw);
      expect(result.issues?.join('\n')).toContain('mystery');
    }
    expect(store.data.get(graphStorageKey('ret2win'))).toBeUndefined();
    expect(store.data.get('pwn2block.canvas.v1.ret2win')).toBe(raw);
  });

  it('新格式损坏时不回退到旧存档，也不覆盖', () => {
    const raw = '{"format":"pwn2block.graph-save","version":99}';
    const store = memoryStore({
      [graphStorageKey('ret2win')]: raw,
      [interimGraphStorageKey('ret2win')]: JSON.stringify(withHexNode()),
    });
    const result = loadGraph(store, 'ret2win');
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === 'corrupt') expect(result.raw).toBe(raw);
    expect(store.data.get(graphStorageKey('ret2win'))).toBe(raw);
  });

  it('跨题目与缺模块依赖的存档都拒绝加载', () => {
    const store = memoryStore();
    const other = makeGraphSave('endian', withHexNode());
    store.setItem(graphStorageKey('ret2win'), JSON.stringify(other));
    expect(loadGraph(store, 'ret2win').ok).toBe(false);

    const save = { ...makeGraphSave('ret2win', withHexNode()), dependencies: [{ id: 'ghost', version: 1 }] };
    store.setItem(graphStorageKey('ret2win'), JSON.stringify(save));
    const missing = loadGraph(store, 'ret2win');
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.kind === 'corrupt') expect(missing.reason).toContain('依赖');
  });

  it('存储不可用时返回没有存档，写入返回 false', () => {
    expect(loadGraph(undefined, 'ret2win').ok).toBe(false);
    expect(saveGraph(undefined, 'ret2win', withHexNode())).toBe(false);
  });
});

describe('来源定位', () => {
  function documentWithLoopModule(): GraphDocument {
    const graphModule: GraphModule = {
      id: 'mod',
      name: '模块',
      summary: '',
      kind: 'flow',
      version: 1,
      inputs: [],
      nodes: [
        { id: 'body-step', kind: NODE.step, params: { count: 1 } },
        { id: 'loop-1', kind: NODE.repeat, params: { count: 2 }, regions: { body: ['body-step'] } },
      ],
      connections: [],
      main: ['loop-1'],
      layout: {
        'body-step': { x: 40, y: 160 },
        'loop-1': { x: 40, y: 40, collapsed: true },
      },
    };
    return { ...emptyGraphDocument(), modules: [graphModule] };
  }

  it('展开折叠容器并切到模块视图，说明轮次', () => {
    const result = locateTarget(documentWithLoopModule(), {
      nodeId: 'body-step',
      path: ['main', 'loop-1/body'],
      rounds: { 'loop-1': 2 },
      modules: ['mod@1'],
    });
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.moduleId).toBe('mod');
    expect(result.document.modules?.[0]?.layout['loop-1']?.collapsed).toBe(false);
    expect(result.detail).toContain('第 3 轮');
  });

  it('主图节点只展开主图布局', () => {
    const base = emptyGraphDocument();
    const document: GraphDocument = {
      ...base,
      nodes: [
        ...base.nodes,
        { id: 'if-1', kind: NODE.if, params: {}, regions: { then: [] } },
        { id: 'step-1', kind: NODE.step, params: { count: 1 } },
      ],
      main: ['if-1'],
      layout: { ...base.layout, 'if-1': { x: 40, y: 40, collapsed: true } },
    };
    const result = locateTarget(document, { nodeId: 'step-1', path: ['main', 'if-1/then'] });
    expect(result?.document.layout['if-1']?.collapsed).toBe(false);
    expect(result?.moduleId).toBeUndefined();
  });

  it('找不到节点时返回 undefined；来源越界也不猜', () => {
    expect(locateTarget(emptyGraphDocument(), { nodeId: 'ghost' })).toBeUndefined();
    expect(locateRequestForOrigin([{ index: 0, nodeId: 'a', path: ['main'] }], 1)).toBeUndefined();
    expect(locateRequestForOrigin([{ index: 0, nodeId: '', path: ['main'] }], 0)).toBeUndefined();
  });
});
