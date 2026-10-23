/**
 * 节点库分类（10 §4.1）：按用途把节点目录切成一级分类，分类内直接展示节点。
 *
 * **分类是节点目录的派生视图**：它不改节点定义、不新增节点能力，只回答“这个节点在节点库里放哪”；
 * 标签、摘要、端口一律从 `NodeKindSpec` 读，这里只维护 kind → 分类的归属表，表里漏掉的种类
 * 按 `spec.category` 回落，保证任何节点都不会从节点库里消失。
 */
import { NODE } from './kinds';
import type { NodeCategory, NodeKindSpec } from './types';

export const LIBRARY_CATEGORY_IDS = ['data', 'compute', 'payload', 'pattern', 'control', 'loop', 'variable', 'action', 'module'] as const;

export type LibraryCategoryId = (typeof LIBRARY_CATEGORY_IDS)[number];

/** 一级分类的展示信息；数组顺序就是节点库里的展开顺序。 */
export interface LibraryCategoryInfo {
  readonly id: LibraryCategoryId;
  /** 中文一级分类名。 */
  readonly label: string;
  /** 一句话说明归什么。 */
  readonly summary: string;
}

export const LIBRARY_CATEGORIES: readonly LibraryCategoryInfo[] = [
  { id: 'data', label: '数据与常量', summary: '整数、文本、字节与题目公开常量：值是现成的，拿来就能用。' },
  { id: 'compute', label: '运算与判断', summary: '算术、比较、布尔逻辑与类型转换：在一段值上做计算。' },
  { id: 'payload', label: '字节与载荷', summary: '填充、拼接、打包与解包：把字节排成 payload。' },
  { id: 'pattern', label: '定位序列', summary: '生成定位序列，查找字节偏移。' },
  { id: 'control', label: '流程控制', summary: '开始、分支与结果输出。' },
  { id: 'loop', label: '循环', summary: '重复执行、循环控制、索引与累加。' },
  { id: 'variable', label: '变量', summary: '声明、读取与修改变量。' },
  { id: 'action', label: '交互动作', summary: '当前实际支持的动作用节点：真正推进 VM 的只有这些。' },
  { id: 'module', label: '我的模块', summary: '自己封装并保存的可复用模块，以及模块内的结果出口。' },
];

/** 一个节点在节点库里的位置。 */
export interface LibraryEntry {
  readonly kind: string;
  readonly label: string;
  readonly category: LibraryCategoryId;
  /** 二级分组名；`undefined` 表示直接挂在一级分类下（不为所有分类强制加第二级）。 */
  readonly section?: string;
  readonly summary: string;
}

/** 一级分类下的一组条目。 */
export interface LibrarySection {
  /** `undefined` 表示这一组没有二级分类，条目直接列在分类下。 */
  readonly name?: string;
  readonly entries: readonly LibraryEntry[];
}

export interface LibraryGroup extends LibraryCategoryInfo {
  readonly sections: readonly LibrarySection[];
}

/** 搜索结果：比 `LibraryEntry` 多一条展示用的分类路径。 */
export interface LibraryMatch {
  readonly kind: string;
  readonly label: string;
  readonly category: LibraryCategoryId;
  readonly categoryLabel: string;
  readonly section?: string;
  /** 展示用路径，如 `字节与载荷 / 拼装`；没有二级分类时就是一级分类名。 */
  readonly path: string;
}

/** 归属表的一行：一级分类、可选的二级分组，以及只给搜索用的别名。 */
interface Placement {
  readonly category: LibraryCategoryId;
  readonly section?: string;
  /** 检索脚手架（如 `assembly`）：不进入 `LibraryEntry`，它不是节点能力。 */
  readonly aliases?: readonly string[];
}

const PLACEMENTS: Readonly<Record<string, Placement | undefined>> = {
  // 数据与常量：值本身就是答案，只有一级。
  [NODE.int]: { category: 'data' },
  [NODE.text]: { category: 'data' },
  [NODE.hex]: { category: 'data' },
  [NODE.address]: { category: 'data' },
  // 运算与判断：直接列出运算节点。
  [NODE.arith]: { category: 'compute' },
  [NODE.compare]: { category: 'compute' },
  [NODE.logic]: { category: 'compute' },
  [NODE.bytesToInt]: { category: 'compute' },
  [NODE.select]: { category: 'compute' },
  // 字节与载荷：定位序列单独归类。
  [NODE.fill]: { category: 'payload', aliases: ['pad'] },
  [NODE.concat]: { category: 'payload', aliases: ['concat', 'join', 'assembly'] },
  [NODE.slice]: { category: 'payload', aliases: ['slice', 'substr'] },
  [NODE.assemble]: { category: 'payload', aliases: ['assembly', 'pack', 'layout'] },
  [NODE.cyclic]: { category: 'pattern', aliases: ['cyclic', 'debruijn'] },
  [NODE.find]: { category: 'pattern', aliases: ['cyclic_find', 'offset'] },
  // 流程与变量：入口、循环与名字绑定各自归类。
  [NODE.start]: { category: 'control' },
  [NODE.if]: { category: 'control' },
  [NODE.repeat]: { category: 'loop' },
  [NODE.while]: { category: 'loop' },
  [NODE.break]: { category: 'loop' },
  [NODE.continue]: { category: 'loop' },
  [NODE.result]: { category: 'control' },
  [NODE.index]: { category: 'loop' },
  [NODE.accumulator]: { category: 'loop' },
  [NODE.varDeclare]: { category: 'variable' },
  [NODE.varGet]: { category: 'variable' },
  [NODE.varSet]: { category: 'variable' },
  // 交互动作：条目自解释，只有一级。
  [NODE.feed]: { category: 'action' },
  [NODE.write]: { category: 'action' },
  [NODE.push]: { category: 'action' },
  [NODE.pop]: { category: 'action' },
  [NODE.call]: { category: 'action' },
  [NODE.ret]: { category: 'action' },
  [NODE.step]: { category: 'action' },
  [NODE.run]: { category: 'action' },
  [NODE.author]: { category: 'action' },
  // 模块：只有一类东西，只有一级。
  [NODE.moduleData]: { category: 'module' },
  [NODE.moduleCall]: { category: 'module' },
  [NODE.moduleReturn]: { category: 'module' },
};

/** 节点种类 → 分类条目；未知种类回落到按 spec.category 推断，保证不丢节点。 */
export function libraryEntryOf(spec: NodeKindSpec): LibraryEntry {
  const placement = PLACEMENTS[spec.kind];
  const category = placement?.category ?? fallbackCategory(spec.category);
  const entry: LibraryEntry = { kind: spec.kind, label: spec.label, category, summary: spec.summary };
  return placement?.section === undefined ? entry : { ...entry, section: placement.section };
}

/** 把目录按用途分类（只保留传入 specs 里出现的条目；空分类不返回）。 */
export function libraryGroups(specs: readonly NodeKindSpec[]): readonly LibraryGroup[] {
  const entries = entriesOf(specs);
  const groups: LibraryGroup[] = [];
  for (const info of LIBRARY_CATEGORIES) {
    const sections = sectionsOf(entries.filter((entry) => entry.category === info.id));
    if (sections.length > 0) groups.push({ ...info, sections });
  }
  return groups;
}

/** 搜索：大小写不敏感，匹配标签、kind、摘要、二级分组名；返回带分类路径的结果。 */
export function searchLibrary(specs: readonly NodeKindSpec[], query: string): readonly LibraryMatch[] {
  const needle = query.trim().toLowerCase();
  const matches: LibraryMatch[] = [];
  for (const group of libraryGroups(specs)) {
    for (const section of group.sections) {
      for (const entry of section.entries) {
        if (needle !== '' && !includesNeedle(entry, section.name, needle)) continue;
        matches.push({
          kind: entry.kind,
          label: entry.label,
          category: group.id,
          categoryLabel: group.label,
          section: section.name,
          path: section.name === undefined ? group.label : `${group.label} / ${section.name}`,
        });
      }
    }
  }
  return matches;
}

// 下面是纯函数实现：去重、分组与匹配。

/** 目录条目，按目录顺序去重：同一个 kind 在库里只出现一次。 */
function entriesOf(specs: readonly NodeKindSpec[]): readonly LibraryEntry[] {
  const seen = new Set<string>();
  const entries: LibraryEntry[] = [];
  for (const spec of specs) {
    if (seen.has(spec.kind)) continue;
    seen.add(spec.kind);
    entries.push(libraryEntryOf(spec));
  }
  return entries;
}

/** 同二级分组的条目聚成一组；分组顺序 = 该组第一个条目在目录里的顺序。 */
function sectionsOf(entries: readonly LibraryEntry[]): readonly LibrarySection[] {
  const buckets = new Map<string, LibraryEntry[]>();
  for (const entry of entries) {
    // 空字符串作“没有二级分组”的桶名：Map 需要确定的 key，`undefined` 不行。
    const key = entry.section ?? '';
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [entry]);
    else bucket.push(entry);
  }
  const sections: LibrarySection[] = [];
  for (const [key, bucket] of buckets) {
    sections.push(key === '' ? { entries: bucket } : { name: key, entries: bucket });
  }
  return sections;
}

function includesNeedle(entry: LibraryEntry, section: string | undefined, needle: string): boolean {
  const aliases = PLACEMENTS[entry.kind]?.aliases ?? [];
  const fields = [entry.kind, entry.label, entry.summary, section ?? '', ...aliases];
  return fields.some((field) => field.toLowerCase().includes(needle));
}

/** 未知种类的回落：目录的三种 category 一一对应到最接近的一级分类。 */
function fallbackCategory(category: NodeCategory): LibraryCategoryId {
  if (category === 'flow') return 'control';
  if (category === 'action') return 'action';
  return 'data';
}
