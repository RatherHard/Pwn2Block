import {
  bigIntToBytesLE,
  bytesToHex,
  formatHex,
  isKnownOpName,
  maskValue,
  opcodeToNumber,
  operandConst,
  operandRegister,
  parseHex,
  type ChallengeVma,
  type EncodingItem,
  type EncodingLookup,
  type InitPatch,
  type Operand,
  type OpName,
} from '@pwn2block/shared';

/**
 * 伪汇编器（06 §2.2）：`program.asm` → code VMA 的 `init` 补丁。
 *
 * 流水线：
 * 1. 词法/语法：按行解析出 `.vma` 段、标签、指令、`.byte` / `.ascii` 数据；
 * 2. 第一遍扫标签：以「段基址 + 段内偏移」算出每个标签的绝对地址，并累计每条语句的长度；
 * 3. 第二遍逐行编码：指令按 `EncodingLookup` 查 opcode，`imm` / `disp` 按字宽小端跟在后面；
 * 4. 输出 `{ vmaId, patches, segments, listing }`，CLI 把补丁写回 `private.json` 的 `init`。
 *
 * 设计约束：
 * - **没有宏、没有表达式求值**：它只是「别手写 hex」的工具，不是真汇编器（06 §2.2）。
 * - 跳转目标写标签，也允许手写字面地址：两者都是 `imm` 操作数。
 * - 任何错误都返回 `{ok: false, message}`（中文，与源码位置有关的一律带行号），
 *   **绝不返回半成品字节**。
 *
 * 支持的语法见 `docs/archive/mvp-2026-10-16/06-出题指南.md` §2.2；不支持的一律显式报错，不做静默兜底。
 */

export interface AsmOptions {
  /** 题目展开后的编码表查询视图（`ChallengeDefinition.lookup`）。缺了它无法编码。 */
  readonly lookup?: EncodingLookup;
  /**
   * 私有包里声明的寄存器名。只用来把 `rax` 这类记法认成寄存器而不是标签，
   * 好让「表里没有这个形态」报成操作数形态不符，而不是莫名其妙的未定义标签。
   */
  readonly registers?: readonly string[];
}

/** 地址清单的一行：标签 → 绝对地址 → 所属 VMA（06 §2.2）。 */
export interface AsmListingEntry {
  readonly label: string;
  readonly addr: string;
  readonly vma: string;
}

/** 一个 `.vma` 段汇编出来的补丁（通常只有一条：整段一条 `init`）。 */
export interface AsmSegmentResult {
  readonly vmaId: string;
  readonly patches: readonly InitPatch[];
}

export type AsmResult =
  | {
      readonly ok: true;
      /** 第一个 `.vma` 段的 id，即本题的主 code 段。 */
      readonly vmaId: string;
      readonly patches: readonly InitPatch[];
      /** 按段分组的补丁，供写回 `private.json` 用。 */
      readonly segments: readonly AsmSegmentResult[];
      readonly listing: readonly AsmListingEntry[];
    }
  | { readonly ok: false; readonly message: string };

// ---------------------------------------------------------------------------
// 解析后的中间表示
// ---------------------------------------------------------------------------

type ImmExpr =
  | { readonly kind: 'num'; readonly value: bigint }
  | { readonly kind: 'label'; readonly name: string };

type AsmOperand =
  | { readonly kind: 'reg'; readonly name: string }
  | { readonly kind: 'mem'; readonly reg: string; readonly disp: ImmExpr }
  | { readonly kind: 'imm'; readonly value: ImmExpr };

interface InstrStatement {
  readonly kind: 'instr';
  readonly mnemonic: string;
  readonly operands: readonly AsmOperand[];
  /** 源码原文，用于报错时回显。 */
  readonly text: string;
  readonly line: number;
}

type Statement =
  | { readonly kind: 'vma'; readonly id: string; readonly line: number }
  | { readonly kind: 'label'; readonly name: string; readonly line: number }
  | InstrStatement
  | { readonly kind: 'data'; readonly bytes: readonly number[]; readonly line: number };

type AsmFailure = { readonly ok: false; readonly message: string };

function fail(line: number, message: string): AsmFailure {
  return { ok: false, message: `第 ${line} 行：${message}` };
}

const LABEL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEX_NUMBER_RE = /^0[xX][0-9a-fA-F]+$/;
const DEC_NUMBER_RE = /^[0-9]+$/;

// ---------------------------------------------------------------------------
// 词法与语法
// ---------------------------------------------------------------------------

/** 去掉 `;` 注释，但保留字符串里的分号（`.ascii "a;b"`）。 */
function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString && char === '\\') {
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (char === ';' && !inString) return line.slice(0, index);
  }
  return line;
}

/** 编码表 + 私有包里出现过的寄存器名（大写）。 */
function registersOf(lookup: EncodingLookup, declared: readonly string[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const name of declared) names.add(name.toUpperCase());
  for (const item of lookup.items) {
    for (const form of item.operands) {
      const reg = operandRegister(form);
      if (reg) names.add(reg.toUpperCase());
    }
  }
  return names;
}

/** 一行源码 → 若干条语句（`win: syscall 99` 会拆成标签 + 指令）。 */
function parseLine(
  raw: string,
  line: number,
  regs: ReadonlySet<string>,
): { readonly ok: true; readonly statements: readonly Statement[] } | AsmFailure {
  const text = stripComment(raw).trim();
  if (text === '') return { ok: true, statements: [] };
  const statements: Statement[] = [];
  let rest = text;

  for (;;) {
    const label = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(rest);
    if (!label) break;
    const name = label[1];
    if (regs.has(name.toUpperCase())) {
      return fail(line, `标签名「${name}」与本题的寄存器同名，换一个名字`);
    }
    statements.push({ kind: 'label', name, line });
    rest = rest.slice(label[0].length).trim();
    if (rest === '') return { ok: true, statements };
  }

  if (rest.startsWith('.')) {
    const directive = parseDirective(rest, line);
    if (!directive.ok) return directive;
    return { ok: true, statements: [...statements, directive.statement] };
  }

  const head = /^([A-Za-z][A-Za-z0-9_]*)\s*(.*)$/.exec(rest);
  if (!head) return fail(line, `无法解析的语句「${rest}」`);

  const operands: AsmOperand[] = [];
  const operandText = head[2].trim();
  if (operandText !== '') {
    for (const piece of operandText.split(',')) {
      const parsed = parseOperand(piece.trim(), line, regs);
      if (!parsed.ok) return parsed;
      operands.push(parsed.operand);
    }
  }
  statements.push({ kind: 'instr', mnemonic: head[1].toLowerCase(), operands, text: rest, line });
  return { ok: true, statements };
}

function parseDirective(
  text: string,
  line: number,
): { readonly ok: true; readonly statement: Statement } | AsmFailure {
  const space = text.search(/\s/);
  const name = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const rest = space === -1 ? '' : text.slice(space + 1).trim();

  if (name === '.vma') {
    if (!/^[A-Za-z0-9_-]+$/.test(rest)) {
      return fail(line, `.vma 的用法是「.vma <vma id>」，收到的是「${rest}」`);
    }
    return { ok: true, statement: { kind: 'vma', id: rest, line } };
  }
  if (name === '.byte') return parseByteDirective(rest, line);
  if (name === '.ascii') return parseAsciiDirective(rest, line);
  return fail(line, `不支持的伪指令「${name}」（只支持 .vma / .byte / .ascii）`);
}

function parseByteDirective(
  rest: string,
  line: number,
): { readonly ok: true; readonly statement: Statement } | AsmFailure {
  if (rest === '') return fail(line, '.byte 后面至少要写一个字节值');

  const bytes: number[] = [];
  for (const piece of rest.split(',')) {
    const text = piece.trim();
    let value: number | undefined;
    if (/^0x[0-9a-fA-F]{1,2}$/.test(text)) value = Number.parseInt(text.slice(2), 16);
    else if (/^[0-9]{1,3}$/.test(text)) value = Number.parseInt(text, 10);
    if (value === undefined || value > 0xff) {
      return fail(line, `.byte 的值「${text}」不是 0x00–0xff 之间的字节`);
    }
    bytes.push(value);
  }
  return { ok: true, statement: { kind: 'data', bytes, line } };
}

function parseAsciiDirective(
  rest: string,
  line: number,
): { readonly ok: true; readonly statement: Statement } | AsmFailure {
  if (!/^".*"$/s.test(rest)) return fail(line, '.ascii 的用法是「.ascii "文本"」（只支持双引号）');
  const decoded = decodeAscii(rest.slice(1, -1), line);
  if (!decoded.ok) return decoded;
  return { ok: true, statement: { kind: 'data', bytes: decoded.bytes, line } };
}

const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  '0': 0x00,
  '\\': 0x5c,
  '"': 0x22,
};

/** `.ascii` 的转义：`\n \r \t \0 \\ \"` 与 `\xNN`；非 ASCII 字符显式报错。 */
function decodeAscii(body: string, line: number): { readonly ok: true; readonly bytes: number[] } | AsmFailure {
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      const code = char.codePointAt(0) ?? 0;
      if (code < 0x20 || code > 0x7e) {
        return fail(line, `.ascii 只支持 ASCII 可打印字符，遇到 U+${code.toString(16).toUpperCase()}`);
      }
      bytes.push(code);
      continue;
    }
    const next = body[index + 1];
    if (next === undefined) return fail(line, '.ascii 的字符串以未完成的转义结尾');
    if (next === 'x') {
      const digits = body.slice(index + 2, index + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) return fail(line, `\\x 后面必须跟两位十六进制，收到「\\x${digits}」`);
      bytes.push(Number.parseInt(digits, 16));
      index += 3;
      continue;
    }
    const simple = SIMPLE_ESCAPES[next];
    if (simple === undefined) return fail(line, `不支持的转义「\\${next}」（支持 \\n \\r \\t \\0 \\\\ \\" \\xNN）`);
    bytes.push(simple);
    index += 1;
  }
  return { ok: true, bytes };
}

function parseOperand(
  text: string,
  line: number,
  regs: ReadonlySet<string>,
): { readonly ok: true; readonly operand: AsmOperand } | AsmFailure {
  if (text === '') return fail(line, '操作数不能为空（检查多余的逗号）');

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return fail(line, `内存操作数「${text}」缺少右括号`);
    const inner = text.slice(1, -1).trim();
    const parsed = /^([A-Za-z][A-Za-z0-9_]*)\s*(?:([+-])\s*(.+))?$/.exec(inner);
    if (!parsed) return fail(line, `内存操作数「${text}」的写法是 [REG] / [REG+disp] / [REG-disp]`);
    const reg = parsed[1].toUpperCase();
    if (!regs.has(reg)) return fail(line, `内存操作数「${text}」里的寄存器 ${reg} 不在本题的编码表里`);

    const dispText = parsed[3];
    if (dispText === undefined) return { ok: true, operand: { kind: 'mem', reg, disp: { kind: 'num', value: 0n } } };
    const disp = parseImm(dispText, line, regs);
    if (!disp.ok) return disp;
    if (parsed[2] === '-' && disp.value.kind === 'label') {
      return fail(line, `位移不能是取负的标签「-${dispText}」`);
    }
    const value: ImmExpr =
      parsed[2] === '-' && disp.value.kind === 'num'
        ? { kind: 'num', value: -disp.value.value }
        : disp.value;
    return { ok: true, operand: { kind: 'mem', reg, disp: value } };
  }

  if (LABEL_NAME_RE.test(text) && regs.has(text.toUpperCase())) {
    return { ok: true, operand: { kind: 'reg', name: text.toUpperCase() } };
  }

  const imm = parseImm(text, line, regs);
  if (!imm.ok) return imm;
  return { ok: true, operand: { kind: 'imm', value: imm.value } };
}

/** 立即数 / 位移：十六进制、十进制，或标签（标签在第二遍解析成绝对地址）。 */
function parseImm(
  text: string,
  line: number,
  regs: ReadonlySet<string>,
): { readonly ok: true; readonly value: ImmExpr } | AsmFailure {
  if (HEX_NUMBER_RE.test(text)) return { ok: true, value: { kind: 'num', value: BigInt(`0x${text.slice(2)}`) } };
  if (DEC_NUMBER_RE.test(text)) return { ok: true, value: { kind: 'num', value: BigInt(text) } };
  if (LABEL_NAME_RE.test(text)) {
    if (regs.has(text.toUpperCase())) {
      return fail(line, `「${text}」是本题的寄存器名，不能当标签用`);
    }
    return { ok: true, value: { kind: 'label', name: text } };
  }
  return fail(line, `无法识别的操作数「${text}」`);
}

function parseStatements(
  source: string,
  regs: ReadonlySet<string>,
): { readonly ok: true; readonly statements: readonly Statement[] } | AsmFailure {
  const statements: Statement[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = parseLine(lines[index], index + 1, regs);
    if (!parsed.ok) return parsed;
    statements.push(...parsed.statements);
  }
  return { ok: true, statements };
}

// ---------------------------------------------------------------------------
// 第一遍：标签与段的地址
// ---------------------------------------------------------------------------

interface SegmentLayout {
  readonly id: string;
  readonly start: bigint;
  readonly size: bigint;
  /** 已排布的字节数。 */
  total: number;
}

interface LabelInfo {
  readonly addr: bigint;
  readonly vma: string;
  readonly line: number;
}

type LayoutResult =
  | { readonly ok: true; readonly segments: readonly SegmentLayout[]; readonly labels: ReadonlyMap<string, LabelInfo> }
  | AsmFailure;

/** 指令字节长度：1 字节 opcode + 每个 `imm` / `disp` 各一个字宽（02 §4）。 */
function instructionLength(statement: InstrStatement, lookup: EncodingLookup, wordBytes: number): number | AsmFailure {
  const resolved = resolveInstruction(statement, lookup);
  if (!resolved.ok) return resolved;
  const extra = resolved.item.operands.filter((form) => form === 'imm' || form.startsWith('mem:')).length;
  return 1 + extra * wordBytes;
}

function computeLayout(
  statements: readonly Statement[],
  vmas: readonly ChallengeVma[],
  lookup: EncodingLookup,
  wordBytes: number,
): LayoutResult {
  const byId = new Map(vmas.map((vma) => [vma.id, vma] as const));
  const segments: SegmentLayout[] = [];
  const declared = new Set<string>();
  const labels = new Map<string, LabelInfo>();
  let current: SegmentLayout | undefined;

  for (const statement of statements) {
    if (statement.kind === 'vma') {
      const vma = byId.get(statement.id);
      if (!vma) {
        return fail(statement.line, `.vma 引用了 private.json 里不存在的 VMA：${statement.id}`);
      }
      if (declared.has(statement.id)) return fail(statement.line, `段 ${statement.id} 重复声明，一个段只能出现一次`);
      declared.add(statement.id);
      current = { id: statement.id, start: parseHex(vma.start), size: parseHex(vma.size), total: 0 };
      segments.push(current);
      continue;
    }

    if (current === undefined) {
      return fail(statement.line, '内容出现在任何 .vma 段之前，第一行要先写「.vma <id>」');
    }

    if (statement.kind === 'label') {
      const previous = labels.get(statement.name);
      if (previous) {
        return fail(statement.line, `标签「${statement.name}」重复定义（首次在第 ${previous.line} 行）`);
      }
      labels.set(statement.name, { addr: current.start + BigInt(current.total), vma: current.id, line: statement.line });
      continue;
    }

    let length: number;
    if (statement.kind === 'data') {
      length = statement.bytes.length;
    } else {
      const computed = instructionLength(statement, lookup, wordBytes);
      if (typeof computed !== 'number') return computed;
      length = computed;
    }

    if (BigInt(current.total) + BigInt(length) > current.size) {
      return fail(
        statement.line,
        `内容越出 VMA ${current.id} 的大小（${formatHex(current.size)}），已经排到 ${formatHex(current.start + BigInt(current.total))}`,
      );
    }
    current.total += length;
  }

  if (segments.length === 0) return { ok: false, message: 'program.asm 里没有 .vma 段：第一行先写「.vma <id>」' };
  return { ok: true, segments, labels };
}

// ---------------------------------------------------------------------------
// 指令匹配与第二遍编码
// ---------------------------------------------------------------------------

/** 按助记符 + 操作数形态在编码表里定位唯一的编码项（02 §4）。 */
function resolveInstruction(
  statement: InstrStatement,
  lookup: EncodingLookup,
): { readonly ok: true; readonly item: EncodingItem } | AsmFailure {
  const { mnemonic, line } = statement;
  if (!isKnownOpName(mnemonic)) {
    return fail(line, `指令「${statement.text}」不在编码表里（${mnemonic} 不是内置作用）`);
  }
  const candidates = lookup.findByOp(mnemonic as OpName);
  if (candidates.length === 0) {
    return fail(line, `指令「${statement.text}」不在本题的编码表里`);
  }

  const matched = candidates.filter((item) => operandsMatch(item.operands, statement.operands));
  if (matched.length === 0) {
    const forms = candidates.map((item) => describeForms(item)).join('；');
    return fail(line, `操作数形态不符：${statement.text}（本题「${mnemonic}」可用形态：${forms}）`);
  }
  if (matched.length > 1) {
    const opcodes = matched.map((item) => item.opcode).join('、');
    return fail(line, `指令「${statement.text}」同时匹配多个编码项（${opcodes}），无法确定用哪一个`);
  }
  return { ok: true, item: matched[0] };
}

function describeForms(item: EncodingItem): string {
  return item.operands.length === 0 ? `${item.op}（无操作数）` : item.operands.join(', ');
}

function operandsMatch(expected: readonly Operand[], actual: readonly AsmOperand[]): boolean {
  return expected.length === actual.length && expected.every((form, index) => operandMatches(form, actual[index]));
}

function operandMatches(form: Operand, actual: AsmOperand): boolean {
  if (form === 'imm') return actual.kind === 'imm';
  const nr = operandConst(form);
  if (nr !== undefined) {
    return actual.kind === 'imm' && actual.value.kind === 'num' && actual.value.value === BigInt(nr);
  }
  const reg = operandRegister(form);
  if (form.startsWith('reg:')) return actual.kind === 'reg' && actual.name === reg;
  if (form.startsWith('mem:')) return actual.kind === 'mem' && actual.reg === reg;
  return false;
}

/** 立即数 / 位移 → 定宽小端字节；标签在这里换成绝对地址。 */
function resolveImm(
  expr: ImmExpr,
  labels: ReadonlyMap<string, LabelInfo>,
  wordBytes: number,
  line: number,
): { readonly ok: true; readonly value: bigint } | AsmFailure {
  if (expr.kind === 'label') {
    const label = labels.get(expr.name);
    if (!label) return fail(line, `未定义的标签：${expr.name}`);
    return { ok: true, value: label.addr };
  }
  if (expr.value < 0n) return { ok: true, value: maskValue(expr.value, wordBytes * 8) };
  if (expr.value >= 1n << BigInt(wordBytes * 8)) {
    return fail(line, `立即数 0x${expr.value.toString(16)} 超出 ${wordBytes} 字节字宽`);
  }
  return { ok: true, value: expr.value };
}

/** 一个 `imm` / `disp` 操作数 → 定宽小端字节。 */
function encodeOperandBytes(
  form: Operand,
  actual: AsmOperand,
  labels: ReadonlyMap<string, LabelInfo>,
  wordBytes: number,
  line: number,
): { readonly ok: true; readonly bytes: readonly number[] } | AsmFailure {
  const expr =
    form === 'imm' && actual.kind === 'imm'
      ? actual.value
      : form.startsWith('mem:') && actual.kind === 'mem'
        ? actual.disp
        : undefined;
  if (expr === undefined) return fail(line, `内部错误：操作数形态「${form}」与匹配结果不一致`);

  const value = resolveImm(expr, labels, wordBytes, line);
  if (!value.ok) return value;
  return { ok: true, bytes: [...bigIntToBytesLE(value.value, wordBytes)] };
}

function encodeInstruction(
  item: EncodingItem,
  operands: readonly AsmOperand[],
  labels: ReadonlyMap<string, LabelInfo>,
  wordBytes: number,
  line: number,
): { readonly ok: true; readonly bytes: readonly number[] } | AsmFailure {
  const bytes: number[] = [opcodeToNumber(item.opcode)];

  for (let index = 0; index < item.operands.length; index += 1) {
    const form = item.operands[index];
    if (form !== 'imm' && !form.startsWith('mem:')) continue;
    const encoded = encodeOperandBytes(form, operands[index], labels, wordBytes, line);
    if (!encoded.ok) return encoded;
    bytes.push(...encoded.bytes);
  }
  return { ok: true, bytes };
}

function emitBytes(
  statements: readonly Statement[],
  layout: Extract<LayoutResult, { ok: true }>,
  lookup: EncodingLookup,
  wordBytes: number,
): { readonly ok: true; readonly bytes: ReadonlyMap<string, readonly number[]> } | AsmFailure {
  const buffers = new Map<string, number[]>(layout.segments.map((segment) => [segment.id, []] as const));
  let currentId: string | undefined;

  for (const statement of statements) {
    if (statement.kind === 'vma') {
      currentId = statement.id;
      continue;
    }
    if (statement.kind === 'label') continue;
    if (currentId === undefined) return { ok: false, message: '内部错误：内容出现在 .vma 段之前' };

    const buffer = buffers.get(currentId);
    if (!buffer) return { ok: false, message: `内部错误：段 ${currentId} 没有对应的缓冲区` };

    if (statement.kind === 'data') {
      buffer.push(...statement.bytes);
      continue;
    }

    const resolved = resolveInstruction(statement, lookup);
    if (!resolved.ok) return resolved;
    const encoded = encodeInstruction(resolved.item, statement.operands, layout.labels, wordBytes, statement.line);
    if (!encoded.ok) return encoded;
    buffer.push(...encoded.bytes);
  }

  for (const segment of layout.segments) {
    const size = buffers.get(segment.id)?.length ?? 0;
    if (size !== segment.total) {
      return { ok: false, message: `内部错误：段 ${segment.id} 的编码长度 ${size} 与布局 ${segment.total} 不一致` };
    }
  }
  return { ok: true, bytes: buffers };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function patchesFor(segment: SegmentLayout, bytes: readonly number[]): readonly InitPatch[] {
  if (bytes.length === 0) return [];
  return [{ at: formatHex(segment.start), hex: bytesToHex(Uint8Array.from(bytes)) }];
}

function buildListing(labels: ReadonlyMap<string, LabelInfo>): readonly AsmListingEntry[] {
  return [...labels.entries()]
    .sort(([, a], [, b]) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .map(([label, info]) => ({ label, addr: formatHex(info.addr), vma: info.vma }));
}

/**
 * 编译 `program.asm`。成功时给出按段分组的 `init` 补丁与地址清单；
 * 任何问题都返回中文错误，不返回半成品字节（06 §2.2）。
 */
export function assembleProgram(
  source: string,
  vmas: readonly ChallengeVma[],
  options: AsmOptions = {},
): AsmResult {
  const lookup = options.lookup;
  if (!lookup) {
    return { ok: false, message: '缺少编码表：汇编器需要题目展开后的 EncodingLookup（ChallengeDefinition.lookup）。' };
  }
  const wordBytes = lookup.wordBytes;
  if (!Number.isInteger(wordBytes) || wordBytes < 1 || wordBytes > 8) {
    return { ok: false, message: `编码表的字宽不合法：${wordBytes}（应为 archBits / 8）` };
  }

  const parsed = parseStatements(source, registersOf(lookup, options.registers ?? []));
  if (!parsed.ok) return parsed;

  const layout = computeLayout(parsed.statements, vmas, lookup, wordBytes);
  if (!layout.ok) return layout;

  const emitted = emitBytes(parsed.statements, layout, lookup, wordBytes);
  if (!emitted.ok) return emitted;

  const segments: AsmSegmentResult[] = layout.segments
    .map((segment) => ({ vmaId: segment.id, patches: patchesFor(segment, emitted.bytes.get(segment.id) ?? []) }))
    .filter((segment) => segment.patches.length > 0);

  if (segments.length === 0) {
    return { ok: false, message: 'program.asm 里没有任何字节：至少写一条指令或一个 .byte / .ascii 数据。' };
  }

  return {
    ok: true,
    vmaId: segments[0].vmaId,
    patches: segments.flatMap((segment) => segment.patches),
    segments,
    listing: buildListing(layout.labels),
  };
}
