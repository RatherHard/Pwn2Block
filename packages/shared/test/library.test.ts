import { describe, expect, it } from 'vitest';
import {
  LIBRARY_CATEGORIES,
  LIBRARY_CATEGORY_IDS,
  NODE,
  PYTHON_TEMPLATES,
  availableNodeSpecs,
  libraryEntryOf,
  libraryGroups,
  searchLibrary,
} from '../src/index';
import type { LibraryCategoryId, LibraryEntry, LibraryGroup, NodeKindSpec } from '../src/index';

/**
 * 节点库分类的契约测试（10 §4.1）。
 *
 * 分类是节点目录的派生视图：这里既断言「七个一级分类固定」，也断言「目录里的节点一个不少、一个不多」，
 * 免得以后新增节点时忘了归类、或把同一个节点摆进两个分类。
 */

const SPECS = availableNodeSpecs();
const GROUPS = libraryGroups(SPECS);

/** 某个分类下的全部条目（跨二级分组摊平）。 */
function entriesIn(id: LibraryCategoryId): readonly LibraryEntry[] {
  const group = groupOf(id);
  return group.sections.flatMap((section) => section.entries);
}

function kindsIn(id: LibraryCategoryId): readonly string[] {
  return entriesIn(id).map((entry) => entry.kind);
}

function groupOf(id: LibraryCategoryId): LibraryGroup {
  const group = GROUPS.find((candidate) => candidate.id === id);
  if (group === undefined) throw new Error(`节点库缺少分类 ${id}`);
  return group;
}

/** 未知种类的回落用例：只填目录契约里必需的字段。 */
const UNKNOWN_DATA: NodeKindSpec = {
  kind: 'custom.data',
  label: '未知数据节点',
  category: 'data',
  summary: '测试用的未知种类',
  version: 1,
  stage: 'p7',
  exec: false,
  params: [],
};

describe('节点库一级分类', () => {
  it('七个分类的 id 与顺序固定', () => {
    expect(LIBRARY_CATEGORY_IDS).toEqual(['data', 'compute', 'payload', 'control', 'action', 'python', 'module']);
    expect(LIBRARY_CATEGORIES.map((info) => info.id)).toEqual([...LIBRARY_CATEGORY_IDS]);
    expect(new Set(LIBRARY_CATEGORIES.map((info) => info.id)).size).toBe(7);
  });

  it('每个分类的中文名与用途说明齐全', () => {
    expect(LIBRARY_CATEGORIES.map((info) => info.label)).toEqual([
      '数据与常量',
      '运算与判断',
      '字节与载荷',
      '流程与变量',
      '交互动作',
      'Python',
      '我的模块',
    ]);
    for (const info of LIBRARY_CATEGORIES) {
      expect(info.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('目录 → 分类的派生视图', () => {
  it('目录里的每个节点恰好出现在一个分类里', () => {
    const entries = GROUPS.flatMap((group) => group.sections.flatMap((section) => section.entries));
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds.slice().sort()).toEqual(SPECS.map((spec) => spec.kind).slice().sort());
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(GROUPS.map((group) => group.id)).toEqual([...LIBRARY_CATEGORY_IDS]);
  });

  it('条目只是转述目录，不新增标签或摘要', () => {
    const byKind = new Map(SPECS.map((spec) => [spec.kind, spec]));
    for (const entry of GROUPS.flatMap((group) => group.sections.flatMap((section) => section.entries))) {
      const spec = byKind.get(entry.kind);
      expect(spec).toBeDefined();
      expect(entry.label).toBe(spec?.label);
      expect(entry.summary).toBe(spec?.summary);
      expect(LIBRARY_CATEGORY_IDS).toContain(entry.category);
    }
  });

  it('关键节点落在按用途划定的分类里', () => {
    // 数据与常量只放「值本身」，填充与拼接属于载荷。
    expect(kindsIn('data')).toEqual(expect.arrayContaining([NODE.int, NODE.text, NODE.hex, NODE.address]));
    expect(kindsIn('data')).not.toContain(NODE.fill);
    // 运算与判断
    expect(kindsIn('compute')).toEqual(
      expect.arrayContaining([NODE.arith, NODE.compare, NODE.logic, NODE.bytesToInt, NODE.select]),
    );
    // 字节与载荷：填充、拼接、组装、定位序列
    expect(kindsIn('payload')).toEqual(
      expect.arrayContaining([NODE.fill, NODE.concat, NODE.slice, NODE.assemble, NODE.cyclic, NODE.find]),
    );
    // 流程与变量
    expect(kindsIn('control')).toEqual(
      expect.arrayContaining([
        NODE.start,
        NODE.if,
        NODE.while,
        NODE.repeat,
        NODE.result,
        NODE.index,
        NODE.accumulator,
        NODE.varDeclare,
        NODE.varGet,
        NODE.varSet,
      ]),
    );
    expect(kindsIn('control')).not.toContain(NODE.moduleCall);
    // 交互动作
    expect(kindsIn('action')).toEqual(
      expect.arrayContaining([NODE.feed, NODE.write, NODE.push, NODE.pop, NODE.call, NODE.ret, NODE.step, NODE.run]),
    );
    expect(kindsIn('action')).not.toContain(NODE.start);
    // Python 与我的模块
    expect(kindsIn('python')).toEqual([NODE.python]);
    expect(kindsIn('module')).toEqual(
      expect.arrayContaining([NODE.moduleData, NODE.moduleCall, NODE.moduleReturn]),
    );
  });
});

describe('二级分组', () => {
  it('条目少的分类只有一级，不强行拆二级', () => {
    for (const id of ['data', 'action', 'python', 'module'] as const) {
      const group = groupOf(id);
      expect(group.sections).toHaveLength(1);
      expect(group.sections[0]?.name).toBeUndefined();
      expect(group.sections[0]?.entries.length).toBeGreaterThan(0);
    }
  });

  it('条目多的分类拆二级，且每个分组都有名字', () => {
    for (const id of ['compute', 'payload', 'control'] as const) {
      const group = groupOf(id);
      expect(group.sections.length).toBeGreaterThan(1);
      for (const section of group.sections) {
        expect(typeof section.name).toBe('string');
        expect(section.name?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('节点库搜索', () => {
  it('命中节点并带出分类路径', () => {
    const matches = searchLibrary(SPECS, '填充');
    const hit = matches.find((match) => match.kind === NODE.fill);
    if (hit === undefined) throw new Error('搜索「填充」应命中填充节点');
    expect(hit.category).toBe('payload');
    expect(hit.categoryLabel).toBe('字节与载荷');
    expect(hit.path).toBe('字节与载荷 / 填充与拼接');
  });

  it('英文查询命中拼接与组装', () => {
    for (const query of ['assembly', 'assemble']) {
      expect(searchLibrary(SPECS, query).map((match) => match.kind)).toContain(NODE.assemble);
    }
  });

  it('大小写不敏感，忽略首尾空白', () => {
    const upper = searchLibrary(SPECS, 'CONCAT').map((match) => match.kind);
    const spaced = searchLibrary(SPECS, '  concat  ').map((match) => match.kind);
    expect(upper).toContain(NODE.concat);
    expect(spaced).toEqual(upper);
    expect(searchLibrary(SPECS, 'PYTHON').map((match) => match.path)).toContain('Python');
  });

  it('空查询返回全部条目且不重复', () => {
    const all = searchLibrary(SPECS, '');
    const total = GROUPS.reduce(
      (count, group) => count + group.sections.reduce((sum, section) => sum + section.entries.length, 0),
      0,
    );
    expect(all).toHaveLength(total);
    expect(all).toHaveLength(SPECS.length);
    expect(new Set(all.map((match) => match.kind)).size).toBe(all.length);
    expect(searchLibrary(SPECS, '   ')).toEqual(all);
  });

  it('任何查询的结果都不重复', () => {
    for (const query of ['字节', 'a', 'assembly', 'data.', '变量']) {
      const kinds = searchLibrary(SPECS, query).map((match) => match.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });
});

describe('Python 代码模板', () => {
  it('三个入门模板的代码与输入声明合法', () => {
    expect(PYTHON_TEMPLATES.map((template) => template.id)).toEqual(['pack-address', 'slice-join', 'xor-loop']);
    for (const template of PYTHON_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.summary).toContain('隔离');
      expect(template.code.trim().length).toBeGreaterThan(0);
      expect(template.code).toContain('result');
      expect(template.code).not.toContain('import');
      for (const input of template.inputs) {
        expect(input).toMatch(/^[a-z][a-z0-9_]*:(int|bool|bytes|text)$/);
      }
      expect(['int', 'bool', 'bytes', 'text']).toContain(template.outputType);
    }
  });

  it('模板只通过 in0… 读输入', () => {
    expect(PYTHON_TEMPLATES[0]?.code).toContain('in0');
    expect(PYTHON_TEMPLATES[1]?.code).toContain('in1');
    expect(PYTHON_TEMPLATES[2]?.code).toContain('in1');
  });
});

describe('未知种类', () => {
  it('不抛错，并按 spec.category 回落', () => {
    expect(libraryEntryOf({ ...UNKNOWN_DATA, category: 'flow' }).category).toBe('control');
    expect(libraryEntryOf({ ...UNKNOWN_DATA, category: 'action' }).category).toBe('action');
    expect(libraryEntryOf(UNKNOWN_DATA).category).toBe('data');
    expect(libraryEntryOf(UNKNOWN_DATA).section).toBeUndefined();
  });

  it('回落的节点仍然出现在某个分类里', () => {
    const groups = libraryGroups([...SPECS, UNKNOWN_DATA]);
    const kinds = groups.flatMap((group) => group.sections.flatMap((section) => section.entries.map((e) => e.kind)));
    expect(kinds).toContain('custom.data');
    expect(kinds.filter((kind) => kind === 'custom.data')).toHaveLength(1);
  });
});
