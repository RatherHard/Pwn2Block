import type { GraphDocument, GraphNode, ParamValue, ParamValues, PortType } from '@pwn2block/shared';
import { NODE, WORKFLOW_FORMAT, WORKFLOW_VERSION } from '@pwn2block/shared';

/**
 * 旧 Blockly 存档 → 节点画布文档的单向迁移（07 §P8；08 §4）。
 *
 * 只读 **Blockly 的序列化 JSON**，不 import Blockly：迁移发生在打开旧存档时，
 * 而 P9 之后运行时依赖会被删掉；保留一个「认旧数据」的纯函数，比留一整套画布库便宜得多。
 *
 * 迁移原则：
 * - **白名单映射**：只转换 P0 冻结时存在的积木；未知积木不猜，整份存档拒绝并列出原因。
 * - **语义优先**：变量在旧编译器里是编译期常量，迁移后变成图里的显式声明 + 设置，
 *   声明放在顶层序列最前面（初始值 0），执行顺序与旧语义一致。
 * - **失败不产出半张图**：任何一条语句转换失败都返回失败与全部原因，调用方保留原文。
 */

export type BlocklyMigrationResult =
  | { readonly ok: true; readonly document: GraphDocument; readonly notes: readonly string[] }
  | { readonly ok: false; readonly reasons: readonly string[] };

interface SerializedBlock {
  readonly type: string;
  readonly id?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly inputs?: Readonly<Record<string, { readonly block?: SerializedBlock; readonly shadow?: SerializedBlock }>>;
  readonly next?: { readonly block?: SerializedBlock };
}

interface SerializedWorkspace {
  readonly blocks?: {
    readonly languageVersion?: number;
    readonly blocks?: readonly SerializedBlock[];
  };
  readonly variables?: readonly { readonly name?: string; readonly id?: string }[];
}

const KNOWN_BLOCKS: ReadonlySet<string> = new Set([
  'start',
  'vars_set',
  'vars_get',
  'math_number',
  'math_arithmetic',
  'logic_compare',
  'value_addr',
  'controls_if',
  'controls_repeat_ext',
  'controls_whileUntil',
  'bytes_padding',
  'bytes_string',
  'bytes_int',
  'bytes_addr',
  'bytes_raw',
  'bytes_concat',
  'action_write_bytes',
  'action_push',
  'action_pop',
  'action_call',
  'action_ret',
  'action_feed',
  'action_step',
  'action_run',
]);

/** 迁移器内部的可变构建状态；对外只暴露成功文档或失败原因。 */
class Builder {
  readonly nodes: GraphNode[] = [];
  readonly connections: { from: { node: string; port: string }; to: { node: string; port: string } }[] = [];
  readonly main: string[] = [];
  readonly layout: Record<string, { x: number; y: number }> = {};
  readonly variables = new Map<string, PortType>();
  readonly variableNames = new Map<string, string>();
  readonly reasons: string[] = [];
  readonly notes: string[] = [];
  private sequence = 0;
  private layoutIndex = 0;
  private readonly seen = new Set<string>();

  nextId(prefix = 'n'): string {
    this.sequence += 1;
    return `${prefix}${this.sequence}`;
  }

  add(kind: string, params: ParamValues, at?: { x: number; y: number }): string {
    const id = kind === 'start' ? 'start' : this.nextId();
    this.layoutIndex += 1;
    const x = at?.x ?? 40 + (this.layoutIndex % 4) * 240;
    const y = at?.y ?? 40 + Math.floor(this.layoutIndex / 4) * 110;
    this.nodes.push({ id, kind, params });
    this.layout[id] = { x, y };
    return id;
  }

  connect(from: string, port: string, to: string, toPort: string): void {
    this.connections.push({ from: { node: from, port }, to: { node: to, port: toPort } });
  }

  fail(message: string): void {
    if (!this.reasons.includes(message)) this.reasons.push(message);
  }

  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /** 防止旧存档里出现成环的 next 链把迁移拖死。 */
  mark(block: SerializedBlock): boolean {
    const id = block.id ?? '';
    if (id === '' || this.seen.has(id)) return false;
    this.seen.add(id);
    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readBlocklyWorkspace(raw: unknown): SerializedWorkspace | undefined {
  const record = asRecord(raw);
  if (record === undefined) return undefined;
  const blocks = asRecord(record['blocks']);
  if (blocks === undefined || !Array.isArray(blocks['blocks'])) return undefined;
  return record as unknown as SerializedWorkspace;
}

function inputBlock(block: SerializedBlock, name: string): SerializedBlock | undefined {
  const input = block.inputs?.[name];
  return input?.block ?? input?.shadow;
}

function nextBlock(block: SerializedBlock): SerializedBlock | undefined {
  return block.next?.block;
}

function fieldString(block: SerializedBlock, name: string): string | undefined {
  const value = block.fields?.[name];
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
}

function fieldNumber(block: SerializedBlock, name: string): number | undefined {
  const value = block.fields?.[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return undefined;
}

function variableName(block: SerializedBlock, variables: ReadonlyMap<string, string>): string | undefined {
  const raw = block.fields?.['VAR'];
  if (typeof raw === 'string') return raw;
  const record = asRecord(raw);
  const id = typeof record?.['id'] === 'string' ? record['id'] : undefined;
  if (id !== undefined) return variables.get(id);
  return undefined;
}

function isKnown(block: SerializedBlock): boolean {
  return KNOWN_BLOCKS.has(block.type) || block.type.startsWith('author_');
}

function typeOfValue(block: SerializedBlock): 'int' | 'bool' | 'bytes' | undefined {
  switch (block.type) {
    case 'math_number':
    case 'math_arithmetic':
    case 'value_addr':
    case 'vars_get':
      return 'int';
    case 'logic_compare':
      return 'bool';
    case 'bytes_padding':
    case 'bytes_string':
    case 'bytes_int':
    case 'bytes_addr':
    case 'bytes_raw':
    case 'bytes_concat':
      return 'bytes';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 表达式
// ---------------------------------------------------------------------------

/**
 * 把数值表达式变成新图里的节点，返回节点 id。
 *
 * `math_number` 在需要节点的地方用 `data.arith ADD(a, 0)` 承载：节点目录没有裸整数字面量，
 * 而算术节点的两个参数都可内填，正好可以表达常量且不引入新节点类型。
 */
function intNode(builder: Builder, block: SerializedBlock): string | undefined {
  const number = block.type === 'math_number' ? fieldNumber(block, 'NUM') : undefined;
  if (block.type === 'math_number' && number === undefined) {
    builder.fail(`数字积木 ${block.id ?? ''} 的 NUM 不是整数`);
    return undefined;
  }
  if (block.type === 'math_number') {
    return builder.add(NODE.arith, { op: 'ADD', a: number as number, b: 0 });
  }
  if (block.type === 'value_addr') {
    const text = fieldString(block, 'ADDR')?.trim() ?? '';
    if (!/^0x[0-9a-fA-F]+$/.test(text)) {
      builder.fail(`地址积木 ${block.id ?? ''} 的 ADDR 不是 0x 十六进制`);
      return undefined;
    }
    return builder.add(NODE.arith, { op: 'ADD', a: text, b: 0 });
  }
  if (block.type === 'vars_get') {
    const name = variableName(block, builder.variableNames);
    if (name === undefined) {
      builder.fail(`读取变量积木 ${block.id ?? ''} 缺少变量名`);
      return undefined;
    }
    return builder.add(NODE.varGet, { name, type: 'int' });
  }
  if (block.type === 'math_arithmetic') {
    const id = builder.add(NODE.arith, {
      op: fieldString(block, 'OP') ?? 'ADD',
    });
    bindIntInput(builder, block, 'A', id, 'a');
    bindIntInput(builder, block, 'B', id, 'b');
    return id;
  }
  if (block.type === 'logic_compare') {
    // 旧逻辑比较在数值语境里是 1/0；用「条件选值」显式转回整数，保持原来的数值语义。
    const id = builder.add(NODE.select, { type: 'int', a: 1, b: 0 });
    const cond = boolNode(builder, block);
    if (cond !== undefined) builder.connect(cond, 'out', id, 'cond');
    return id;
  }
  builder.fail(`不支持的数值表达式：${block.type}（积木 ${block.id ?? '无 id'}）`);
  return undefined;
}

/** 把数值输入绑到目标节点的参数或端口；字面量内填，其它表达式接线。 */
function bindIntInput(
  builder: Builder,
  block: SerializedBlock,
  inputName: string,
  target: string,
  port: string,
): void {
  const child = inputBlock(block, inputName);
  if (child === undefined) return;
  if (child.type === 'math_number') {
    const number = fieldNumber(child, 'NUM');
    if (number === undefined) {
      builder.fail(`数字积木 ${child.id ?? ''} 的 NUM 不是整数`);
      return;
    }
    patchParam(builder, target, port, number);
    return;
  }
  const node = intNode(builder, child);
  if (node !== undefined) builder.connect(node, 'out', target, port);
}

function patchParam(builder: Builder, nodeId: string, name: string, value: ParamValue): void {
  const node = builder.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) return;
  const index = builder.nodes.indexOf(node);
  // 显式写 `…Mode: 'inline'`：动态输入（变量值、条件选值、出题人参数）没有参数定义，
  // 校验器只认「已接线」或「显式手填」；不写模式会被判成缺输入。
  builder.nodes[index] = {
    ...node,
    params: { ...node.params, [name]: value, [`${name}Mode`]: 'inline' },
  };
}

/** 布尔表达式 → 输出 bool 的节点（比较节点或把数值按非 0 转成布尔）。 */
function boolNode(builder: Builder, block: SerializedBlock): string | undefined {
  if (block.type === 'logic_compare') {
    const op = fieldString(block, 'OP') ?? 'EQ';
    const id = builder.add(NODE.compare, { op });
    bindIntInput(builder, block, 'A', id, 'a');
    bindIntInput(builder, block, 'B', id, 'b');
    return id;
  }
  const numeric = intNode(builder, block);
  if (numeric === undefined) return undefined;
  const id = builder.add(NODE.compare, { op: 'NEQ', b: 0 });
  builder.connect(numeric, 'out', id, 'a');
  return id;
}

/** 字节表达式 → data.* 节点。 */
function bytesNode(builder: Builder, block: SerializedBlock): string | undefined {
  switch (block.type) {
    case 'bytes_padding': {
      const id = builder.add(NODE.fill, {});
      bindIntInput(builder, block, 'BYTE', id, 'byte');
      bindIntInput(builder, block, 'COUNT', id, 'count');
      return id;
    }
    case 'bytes_string': {
      const text = fieldString(block, 'TEXT');
      if (text === undefined) {
        builder.fail(`字符串积木 ${block.id ?? ''} 缺少 TEXT`);
        return undefined;
      }
      return builder.add(NODE.text, { text, encoding: 'utf-8' });
    }
    case 'bytes_raw': {
      const hex = fieldString(block, 'HEX');
      if (hex === undefined) {
        builder.fail(`十六进制积木 ${block.id ?? ''} 缺少 HEX`);
        return undefined;
      }
      return builder.add(NODE.hex, { hex });
    }
    case 'bytes_int': {
      const id = builder.add(NODE.int, {
        width: fieldNumber(block, 'WIDTH') ?? 8,
        endian: (fieldString(block, 'ENDIAN') ?? 'LITTLE').toLowerCase() === 'big' ? 'big' : 'little',
      });
      bindIntInput(builder, block, 'VALUE', id, 'value');
      return id;
    }
    case 'bytes_addr': {
      const id = builder.add(NODE.address, {});
      bindIntInput(builder, block, 'VALUE', id, 'value');
      return id;
    }
    case 'bytes_concat': {
      const items = Object.keys(block.inputs ?? {})
        .filter((name) => /^item\d+$/.test(name))
        .sort((a, b) => Number.parseInt(a.slice(4), 10) - Number.parseInt(b.slice(4), 10));
      if (items.length === 0) {
        builder.fail(`拼接积木 ${block.id ?? ''} 没有片段`);
        return undefined;
      }
      const id = builder.add(NODE.concat, { count: Math.min(16, Math.max(1, items.length)) });
      for (const [index, name] of items.entries()) {
        const child = inputBlock(block, name);
        if (child === undefined) continue;
        const node = bytesNode(builder, child);
        if (node !== undefined) builder.connect(node, 'out', id, `item${index}`);
      }
      return id;
    }
    default:
      builder.fail(`不支持的字节表达式：${block.type}（积木 ${block.id ?? '无 id'}）`);
      return undefined;
  }
}

/** 把字节输入接到动作/数据节点的 `data` 端口。 */
function bindBytesInput(
  builder: Builder,
  block: SerializedBlock,
  inputName: string,
  target: string,
  port: string,
): void {
  const child = inputBlock(block, inputName);
  if (child === undefined) {
    builder.fail(`积木 ${block.id ?? ''}（${block.type}）缺少字节输入 ${inputName}`);
    return;
  }
  const node = bytesNode(builder, child);
  if (node !== undefined) builder.connect(node, 'out', target, port);
}

// ---------------------------------------------------------------------------
// 语句
// ---------------------------------------------------------------------------

function statements(
  builder: Builder,
  first: SerializedBlock | undefined,
  region: string[],
): void {
  let current = first;
  while (current !== undefined) {
    if (!builder.mark(current)) {
      builder.fail(`积木链出现重复或成环的引用：${current.id ?? current.type}`);
      return;
    }
    if (!isKnown(current)) {
      builder.fail(`不支持的积木类型：${current.type}（积木 ${current.id ?? '无 id'}）`);
      return;
    }
    const nodeId = statement(builder, current);
    if (nodeId === undefined) return;
    region.push(nodeId);
    current = nextBlock(current);
  }
}

function statement(builder: Builder, block: SerializedBlock): string | undefined {
  switch (block.type) {
    case 'vars_set': {
      const name = variableName(block, builder.variableNames);
      if (name === undefined || name === '') {
        builder.fail(`设置变量积木 ${block.id ?? ''} 缺少变量名`);
        return undefined;
      }
      const value = inputBlock(block, 'VALUE');
      if (value === undefined) {
        builder.fail(`设置变量 ${name} 缺少值`);
        return undefined;
      }
      const id = builder.add(NODE.varSet, { name, type: 'int' });
      bindIntInput(builder, block, 'VALUE', id, 'value');
      return id;
    }
    case 'controls_if':
      return ifStatement(builder, block);
    case 'controls_repeat_ext': {
      const id = builder.add(NODE.repeat, { resultType: 'none' });
      bindIntInput(builder, block, 'TIMES', id, 'count');
      const body = inputBlock(block, 'DO');
      if (body !== undefined) {
        const region: string[] = [];
        statements(builder, body, region);
        const node = builder.nodes.find((candidate) => candidate.id === id);
        if (node !== undefined) {
          const index = builder.nodes.indexOf(node);
          builder.nodes[index] = { ...node, regions: { body: region } };
        }
      }
      return id;
    }
    case 'controls_whileUntil': {
      const mode = (fieldString(block, 'MODE') ?? 'WHILE').toUpperCase() === 'UNTIL' ? 'until' : 'while';
      const id = builder.add(NODE.while, { mode, resultType: 'none' });
      const cond = inputBlock(block, 'BOOL');
      if (cond !== undefined) {
        const condNode = boolNode(builder, cond);
        if (condNode !== undefined) builder.connect(condNode, 'out', id, 'cond');
      } else {
        builder.fail(`循环积木 ${block.id ?? ''} 缺少条件`);
        return undefined;
      }
      const body = inputBlock(block, 'DO');
      if (body !== undefined) {
        const region: string[] = [];
        statements(builder, body, region);
        const node = builder.nodes.find((candidate) => candidate.id === id);
        if (node !== undefined) {
          const index = builder.nodes.indexOf(node);
          builder.nodes[index] = { ...node, regions: { body: region } };
        }
      }
      return id;
    }
    case 'action_write_bytes': {
      const id = builder.add(NODE.write, {});
      bindIntInput(builder, block, 'ADDR', id, 'addr');
      bindBytesInput(builder, block, 'BYTES', id, 'data');
      return id;
    }
    case 'action_push': {
      const id = builder.add(NODE.push, {});
      bindIntInput(builder, block, 'VALUE', id, 'value');
      return id;
    }
    case 'action_pop':
      return builder.add(NODE.pop, {});
    case 'action_call': {
      const id = builder.add(NODE.call, {});
      bindIntInput(builder, block, 'ADDR', id, 'addr');
      return id;
    }
    case 'action_ret':
      return builder.add(NODE.ret, {});
    case 'action_feed': {
      const id = builder.add(NODE.feed, {});
      bindBytesInput(builder, block, 'BYTES', id, 'data');
      return id;
    }
    case 'action_step': {
      const id = builder.add(NODE.step, {});
      bindIntInput(builder, block, 'COUNT', id, 'count');
      return id;
    }
    case 'action_run': {
      const id = builder.add(NODE.run, {});
      bindIntInput(builder, block, 'MAXSTEPS', id, 'maxSteps');
      return id;
    }
    default:
      if (block.type.startsWith('author_')) return authorStatement(builder, block);
      builder.fail(`不支持的语句积木：${block.type}（积木 ${block.id ?? '无 id'}）`);
      return undefined;
  }
}

function ifStatement(builder: Builder, block: SerializedBlock): string {
  const branches = branchIndexes(block);
  const id = builder.add(NODE.if, { branches: Math.max(0, branches.length - 1), resultType: 'none' });
  const regions: Record<string, readonly string[]> = {};
  for (const [index, branch] of branches.entries()) {
    const condition = inputBlock(block, `IF${branch}`);
    const cond = condition === undefined ? falseNode(builder) : boolNode(builder, condition);
    if (cond !== undefined) {
      builder.connect(cond, 'out', id, index === 0 ? 'cond' : `cond${index}`);
    }
    const body = inputBlock(block, `DO${branch}`);
    const region: string[] = [];
    if (body !== undefined) statements(builder, body, region);
    regions[index === 0 ? 'then' : `branch${index}`] = region;
  }
  const elseBody = inputBlock(block, 'ELSE');
  if (elseBody !== undefined) {
    const region: string[] = [];
    statements(builder, elseBody, region);
    regions['else'] = region;
  }
  const node = builder.nodes.find((candidate) => candidate.id === id);
  if (node !== undefined) {
    const nodeIndex = builder.nodes.indexOf(node);
    builder.nodes[nodeIndex] = { ...node, regions };
  }
  return id;
}

/** 哪些分支真的存在：IFn 或 DOn 任一出现就算一条；返回分支序号（0、1、2…）。 */
function branchIndexes(block: SerializedBlock): number[] {
  const present = new Set<number>();
  for (const name of Object.keys(block.inputs ?? {})) {
    const match = /^(IF|DO)(\d+)$/.exec(name);
    if (match !== null) present.add(Number.parseInt(match[2] as string, 10));
  }
  const indexes = [...present].sort((a, b) => a - b);
  return indexes.length === 0 ? [0] : indexes;
}

/** 恒定假：旧条件下缺少输入时，分支不会执行。 */
function falseNode(builder: Builder): string {
  const id = builder.add(NODE.compare, { op: 'EQ', a: 1, b: 0 });
  return id;
}

function authorStatement(builder: Builder, block: SerializedBlock): string | undefined {
  const idValue = block.type.slice('author_'.length);
  if (idValue === '') {
    builder.fail(`出题人积木 ${block.id ?? ''} 没有 id`);
    return undefined;
  }
  const id = builder.add(NODE.author, { id: idValue });
  for (const [name, input] of Object.entries(block.inputs ?? {})) {
    const child = input.block ?? input.shadow;
    if (child === undefined) continue;
    const type = typeOfValue(child);
    if (type === 'bytes') {
      bindBytesInput(builder, block, name, id, name);
    } else if (type === 'int' || type === 'bool') {
      bindIntInput(builder, block, name, id, name);
    } else {
      builder.fail(`出题人积木 ${idValue} 的参数 ${name} 不是受支持的类型`);
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 迁移一份 Blockly 存档。
 *
 * 返回 `ok` 时文档可直接交给 `validateGraph`；返回失败时 `reasons` 是给人看的中文原因，
 * 调用方必须保留原始 JSON（07 §P8「失败时保留原文并提供导出」）。
 */
export function migrateBlocklyWorkspace(raw: unknown): BlocklyMigrationResult {
  const workspace = readBlocklyWorkspace(raw);
  if (workspace === undefined) {
    return { ok: false, reasons: ['不是 Blockly 存档：缺少 blocks.blocks 数组'] };
  }

  const variables = new Map<string, string>();
  for (const variable of workspace.variables ?? []) {
    if (typeof variable.id === 'string' && typeof variable.name === 'string') {
      variables.set(variable.id, variable.name);
    }
  }

  const tops = workspace.blocks?.blocks ?? [];
  const starts = tops.filter((block) => block.type === 'start');
  if (starts.length === 0) {
    return { ok: false, reasons: ['旧存档里没有「开始」积木，无法确定程序入口'] };
  }
  if (starts.length > 1) {
    return { ok: false, reasons: [`旧存档里有 ${starts.length} 个「开始」积木，旧编译器也不接受`] };
  }

  const builder = new Builder();
  for (const [id, name] of variables) builder.variableNames.set(id, name);
  builder.nodes.push({ id: 'start', kind: NODE.start, params: {} });
  builder.layout['start'] = { x: 40, y: 40 };

  // 变量声明放在顶层最前面：旧变量是编译期常量，声明后再按原顺序设置，语义不变。
  const declared = collectVariables(starts[0] as SerializedBlock, variables, builder);
  for (const name of declared) {
    const id = builder.add(NODE.varDeclare, { name, type: 'int', initial: '0' });
    builder.main.push(id);
  }

  const start = starts[0] as SerializedBlock;
  const first = nextBlock(start);
  if (first !== undefined) statements(builder, first, builder.main);

  for (const top of tops) {
    if (top === start) continue;
    if (builder.hasSeen(top.id ?? '')) continue;
    builder.notes.push(`未连到「开始」积木的 ${top.type}（${top.id ?? '无 id'}）不参与执行，已忽略`);
  }

  const document: GraphDocument = {
    format: WORKFLOW_FORMAT,
    version: WORKFLOW_VERSION,
    nodes: builder.nodes,
    connections: builder.connections,
    main: builder.main,
    layout: builder.layout,
  };

  if (builder.reasons.length > 0) return { ok: false, reasons: builder.reasons };
  return { ok: true, document, notes: builder.notes };
}

/** 预扫描变量名与类型：旧变量只有整数一种，读到非数值赋值就记原因。 */
function collectVariables(
  start: SerializedBlock,
  variables: ReadonlyMap<string, string>,
  builder: Builder,
): readonly string[] {
  const names: string[] = [];
  const reads: string[] = [];
  const visited = new Set<string>();
  const visitBlock = (block: SerializedBlock | undefined): void => {
    let current = block;
    while (current !== undefined) {
      const id = current.id ?? '';
      if (id !== '' && visited.has(id)) return;
      if (id !== '') visited.add(id);
      if (current.type === 'vars_set') {
        const name = variableName(current, variables);
        if (name === undefined || name === '') {
          builder.fail(`设置变量积木 ${current.id ?? ''} 缺少变量名`);
        } else {
          if (!names.includes(name)) names.push(name);
          const value = inputBlock(current, 'VALUE');
          const type = value === undefined ? undefined : typeOfValue(value);
          if (type === 'bytes') builder.fail(`变量 ${name} 被赋成字节：旧编译器只支持整数变量`);
        }
      } else if (current.type === 'vars_get') {
        const name = variableName(current, variables);
        if (name !== undefined && !reads.includes(name)) reads.push(name);
      }
      for (const input of Object.values(current.inputs ?? {})) {
        const child = input.block ?? input.shadow;
        if (child !== undefined) visitBlock(child);
      }
      current = nextBlock(current);
    }
  };
  visitBlock(nextBlock(start));
  for (const name of reads) {
    if (!names.includes(name)) builder.fail(`变量 ${name} 只被读取、从未赋值：旧编译器会报错`);
  }
  return names;
}
