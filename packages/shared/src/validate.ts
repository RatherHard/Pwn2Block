import { ACTION_NAMES } from './actions';
import {
  PrivateChallengeSchema,
  PublicChallengeSchema,
  predicateDepthExceeds,
  predicateRegisters,
  predicateVmas,
  publicReferencedRegisters,
  type PrivateChallenge,
  type PublicChallenge,
} from './challenge';
import {
  buildEncodingLookup,
  expandEncoding,
  isEncodingSpec,
  operandConst,
  operandRegister,
  type EncodingItem,
  type EncodingLookup,
} from './encoding';
import { ERROR_CODES } from './errors';
import { asciiToBytes, containsBytesIgnoringAsciiCase, hexToBytes, parseHex } from './hex';
import { MAX_VISIBLE_BYTES, PAGE_SIZE } from './limits';
import type { VmaId } from './primitives';
import { mergePseudocode, validatePseudocodeNoFlag } from './pseudocode';

/**
 * 题目包校验（03 §2.2）。服务端加载与 `challenge:check` 共用这一份实现——
 * 不允许各写一套，否则“本地校验通过、线上拒绝加载”会变成常态。
 */

export interface ChallengeIssue {
  readonly path: string;
  readonly message: string;
}

export interface ChallengeLoadContext {
  /** 默认编码表内容（`presets/<name>.json`），由调用方读文件后传入：shared 不做文件 IO。 */
  readonly presetItems?: readonly EncodingItem[];
  /** flag 真值（部署时由环境变量注入）。缺失时该题拒绝加载（06 §6）。 */
  readonly flagValue?: string;
  /** `pseudocode.c` 原文，由调用方读文件后传入；文件不存在时不传。 */
  readonly pseudocode?: string;
}

export type FlagRef =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'env'; readonly envVar: string; readonly resolved: string };

export interface ChallengeDefinition {
  readonly pub: PublicChallenge;
  readonly priv: PrivateChallenge;
  readonly encoding: readonly EncodingItem[];
  readonly lookup: EncodingLookup;
  readonly flagRef: FlagRef;
}

export type ChallengeCheckResult =
  | { readonly ok: true; readonly definition: ChallengeDefinition }
  | { readonly ok: false; readonly issues: readonly ChallengeIssue[] };

const ENV_FLAG_RE = /^env:(FLAG_[A-Z0-9_]+)$/;

function issue(path: string, message: string): ChallengeIssue {
  return { path, message };
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '<root>' : path.map(String).join('.');
}

function zodIssues(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): ChallengeIssue[] {
  return error.issues.map((item) => issue(formatPath(item.path), item.message));
}

export function parsePublicPackage(
  raw: unknown,
): { ok: true; pub: PublicChallenge } | { ok: false; issues: ChallengeIssue[] } {
  const parsed = PublicChallengeSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, pub: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

export function parsePrivatePackage(
  raw: unknown,
): { ok: true; priv: PrivateChallenge } | { ok: false; issues: ChallengeIssue[] } {
  const parsed = PrivateChallengeSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, priv: parsed.data }
    : { ok: false, issues: zodIssues(parsed.error) };
}

/** 展开编码表；失败时返回问题而不是抛出，好让 `challenge:check` 一次报完。 */
export function expandEncodingOrIssues(
  pub: PublicChallenge,
  presetItems?: readonly EncodingItem[],
): { ok: true; items: EncodingItem[] } | { ok: false; issues: ChallengeIssue[] } {
  try {
    return { ok: true, items: expandEncoding(pub.encoding, presetItems) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [issue('encoding', message)] };
  }
}

/** 公开包自身的语义校验：包内字段之间的一致性。 */
export function validatePublic(pub: PublicChallenge): ChallengeIssue[] {
  const issues: ChallengeIssue[] = [];

  for (const name of pub.allowedActions) {
    if (!(ACTION_NAMES as readonly string[]).includes(name)) {
      issues.push(issue('allowedActions', `未知动作：${name}`));
    }
  }
  if (new Set(pub.allowedActions).size !== pub.allowedActions.length) {
    issues.push(issue('allowedActions', '动作重复声明'));
  }

  if (pub.syscallAbi) {
    if (new Set(pub.syscallAbi.args).size !== pub.syscallAbi.args.length) {
      issues.push(issue('syscallAbi.args', '参数寄存器重复'));
    }
    if (pub.syscallAbi.args.includes(pub.syscallAbi.nr)) {
      issues.push(issue('syscallAbi.args', '参数寄存器不能同时是 nr'));
    }
    // nr 与 ret 允许是同一个寄存器：02 §5.1 的示例就是 nr=RAX、ret=RAX。
  }

  const seenNr = new Map<number, string>();
  for (const syscall of pub.syscalls ?? []) {
    const previous = seenNr.get(syscall.nr);
    if (previous !== undefined) {
      issues.push(issue('syscalls', `调用号 ${syscall.nr} 重复声明（${previous} 与 ${syscall.name}）`));
    }
    seenNr.set(syscall.nr, syscall.name);
    if (syscall.kind === 'custom') {
      syscall.effects.forEach((effect, index) => {
        if (effect.type === 'exit' && index !== syscall.effects.length - 1) {
          issues.push(issue(`syscalls.${syscall.name}.effects`, 'exit 只能是最后一个效果'));
        }
      });
    }
  }

  for (const fd of pub.fds ?? []) {
    if (fd.kind === 'file' && fd.size === undefined) {
      issues.push(issue('fds', `虚拟文件 ${fd.name}（fd ${fd.fd}）必须声明 size`));
    }
    if (fd.kind !== 'file' && fd.size !== undefined) {
      issues.push(issue('fds', `${fd.name} 不是 file，不应声明 size`));
    }
  }
  for (const kind of ['stdin', 'stdout'] as const) {
    const count = (pub.fds ?? []).filter((fd) => fd.kind === kind).length;
    if (count > 1) issues.push(issue('fds', `${kind} 至多一个（02 §5.3）`));
  }
  if (new Set((pub.fds ?? []).map((fd) => fd.fd)).size !== (pub.fds ?? []).length) {
    issues.push(issue('fds', 'fd 号重复'));
  }

  const blockIds = new Set<string>();
  for (const block of pub.authorBlocks ?? []) {
    if (blockIds.has(block.id)) issues.push(issue('authorBlocks', `积木 id 重复：${block.id}`));
    blockIds.add(block.id);

    const paramNames = block.params.map((param) => param.name);
    if (new Set(paramNames).size !== paramNames.length) {
      issues.push(issue(`authorBlocks.${block.id}.params`, '参数名重复'));
    }
    for (const template of block.expand) {
      for (const value of Object.values(template as unknown as Record<string, unknown>)) {
        if (typeof value !== 'string' || !value.startsWith('$')) continue;
        if (!paramNames.includes(value.slice(1))) {
          issues.push(issue(`authorBlocks.${block.id}.expand`, `模板引用了未声明的参数：${value}`));
        }
      }
    }
  }

  for (const code of Object.keys(pub.errorNotes ?? {})) {
    if (!(ERROR_CODES as readonly string[]).includes(code)) {
      issues.push(issue('errorNotes', `未知错误码：${code}`));
    }
  }

  return issues;
}

/** 私有包自身的语义校验：寄存器、VMA 布局、谓词、flag 形式。 */
export function validatePrivate(priv: PrivateChallenge): ChallengeIssue[] {
  const issues: ChallengeIssue[] = [];

  if (new Set(priv.registers).size !== priv.registers.length) {
    issues.push(issue('registers', '寄存器名重复'));
  }
  const registerSet = new Set(priv.registers);
  for (const role of ['sp', 'bp', 'ip'] as const) {
    if (!registerSet.has(priv.roles[role])) {
      issues.push(issue(`roles.${role}`, `角色寄存器 ${priv.roles[role]} 未在 registers 里声明`));
    }
  }
  for (const name of Object.keys(priv.initRegisters ?? {})) {
    if (!registerSet.has(name)) {
      issues.push(issue('initRegisters', `未声明的寄存器：${name}`));
    }
  }

  const ranges: { id: VmaId; start: bigint; end: bigint }[] = [];
  const vmaIds = new Set<string>();
  for (const vma of priv.vmas) {
    if (vmaIds.has(vma.id)) issues.push(issue('vmas', `VMA id 重复：${vma.id}`));
    vmaIds.add(vma.id);

    const start = parseHex(vma.start);
    const size = parseHex(vma.size);
    if (start % BigInt(PAGE_SIZE) !== 0n) {
      issues.push(issue(`vmas.${vma.id}.start`, `地址必须按 0x${PAGE_SIZE.toString(16)} 对齐`));
    }
    if (size <= 0n || size % BigInt(PAGE_SIZE) !== 0n) {
      issues.push(issue(`vmas.${vma.id}.size`, `大小必须是 0x${PAGE_SIZE.toString(16)} 的正整数倍`));
    }
    if (vma.perm.length === 0) {
      issues.push(issue(`vmas.${vma.id}.perm`, '权限不能为空'));
    }
    if (vma.kind === 'custom' && !vma.label) {
      issues.push(issue(`vmas.${vma.id}.label`, 'custom 类型的 VMA 必须带 label'));
    }
    for (const patch of vma.init ?? []) {
      const at = parseHex(patch.at);
      const len = BigInt(patch.hex.length / 2);
      if (at < start || at + len > start + size) {
        issues.push(issue(`vmas.${vma.id}.init`, `内容补丁 ${patch.at} 越出本 VMA`));
      }
    }
    ranges.push({ id: vma.id, start, end: start + size });
  }

  for (let i = 0; i < ranges.length; i += 1) {
    for (let j = i + 1; j < ranges.length; j += 1) {
      const a = ranges[i];
      const b = ranges[j];
      if (!a || !b) continue;
      if (a.start < b.end && b.start < a.end) {
        issues.push(issue('vmas', `VMA 区间重叠：${a.id} 与 ${b.id}`));
      }
    }
  }

  const checkPredicate = (predicate: Parameters<typeof predicateRegisters>[0], path: string): void => {
    if (predicateDepthExceeds(predicate)) {
      issues.push(issue(path, '谓词嵌套超过 3 层'));
    }
    for (const reg of predicateRegisters(predicate)) {
      if (!registerSet.has(reg)) issues.push(issue(path, `谓词引用了未声明的寄存器：${reg}`));
    }
    for (const vma of predicateVmas(predicate)) {
      if (!vmaIds.has(vma)) issues.push(issue(path, `谓词引用了不存在的 VMA：${vma}`));
    }
  };
  checkPredicate(priv.win, 'win');
  (priv.fail ?? []).forEach((predicate, index) => checkPredicate(predicate, `fail.${index}`));

  if (priv.flag.startsWith('env:') && !ENV_FLAG_RE.test(priv.flag)) {
    issues.push(issue('flag', 'flag 的环境变量引用必须写成 env:FLAG_<ID大写>'));
  }

  return issues;
}

function rangeInsideDeclaration(
  priv: PrivateChallenge,
  addr: bigint,
  len: number,
): { ok: true } | { ok: false } {
  const end = addr + BigInt(len);
  for (const vma of priv.vmas) {
    const start = parseHex(vma.start);
    const size = parseHex(vma.size);
    if (addr >= start && end <= start + size) return { ok: true };
  }
  return { ok: false };
}

/** 跨包校验：公开包引用的东西必须在私有包里存在（03 §2.2）。 */
export function validatePair(pub: PublicChallenge, priv: PrivateChallenge): ChallengeIssue[] {
  const issues: ChallengeIssue[] = [];
  const registerSet = new Set(priv.registers);
  const ip = priv.roles.ip;

  for (const reg of publicReferencedRegisters(pub)) {
    if (!registerSet.has(reg)) {
      issues.push(issue('encoding', `公开包引用了未声明的寄存器：${reg}`));
    }
  }

  if (pub.syscallAbi) {
    if (pub.syscallAbi.nr === ip) issues.push(issue('syscallAbi.nr', 'nr 不能是 ip 角色寄存器'));
    if (pub.syscallAbi.ret === ip) issues.push(issue('syscallAbi.ret', 'ret 不能是 ip 角色寄存器'));
  }

  for (const syscall of pub.syscalls ?? []) {
    if (syscall.kind !== 'custom') continue;
    for (const effect of syscall.effects) {
      if (effect.type === 'set_reg') {
        if (effect.reg === ip) {
          issues.push(issue(`syscalls.${syscall.name}`, 'set_reg 不得写 ip 角色寄存器'));
        }
      } else if (effect.type === 'reveal') {
        const vma = priv.vmas.find((item) => item.id === effect.vma);
        if (!vma) {
          issues.push(issue(`syscalls.${syscall.name}`, `reveal 引用了不存在的 VMA：${effect.vma}`));
        } else if (!vma.hidden) {
          issues.push(issue(`syscalls.${syscall.name}`, `reveal 只能作用于 hidden VMA：${effect.vma}`));
        }
      } else if (effect.type === 'copy') {
        const segments: readonly (readonly [string, bigint])[] = [
          ['src', parseHex(effect.src)],
          ['dst', parseHex(effect.dst)],
        ];
        for (const [label, addr] of segments) {
          if (!rangeInsideDeclaration(priv, addr, effect.len).ok) {
            issues.push(issue(`syscalls.${syscall.name}`, `copy 的 ${label} 区间不在任何已声明 VMA 内`));
          }
        }
      }
    }
  }

  const fileFds = (pub.fds ?? []).filter((fd) => fd.kind === 'file');
  const files = priv.files ?? {};
  for (const fd of fileFds) {
    const content = files[String(fd.fd)];
    if (!content) {
      issues.push(issue('files', `fd ${fd.fd}（${fd.name}）缺少虚拟文件内容`));
      continue;
    }
    const length = content.hex.length / 2;
    if (fd.size !== undefined && length !== fd.size) {
      issues.push(
        issue('files', `fd ${fd.fd} 的文件内容长度 ${length} 与公开的 size ${fd.size} 不一致`),
      );
    }
  }
  for (const key of Object.keys(files)) {
    const fd = Number.parseInt(key, 10);
    if (!fileFds.some((item) => item.fd === fd)) {
      issues.push(issue('files', `虚拟文件 ${key} 没有对应的 fd 声明`));
    }
  }

  const visibleBytes = priv.vmas
    .filter((vma) => !vma.hidden)
    .reduce((sum, vma) => sum + Number(parseHex(vma.size)), 0);
  if (visibleBytes > MAX_VISIBLE_BYTES) {
    issues.push(
      issue('vmas', `非隐藏 VMA 总量 ${visibleBytes} 字节超过投影上限 ${MAX_VISIBLE_BYTES} 字节`),
    );
  }

  return issues;
}

/**
 * flag 真值不得出现在虚拟文件或隐藏 VMA 的内容里，否则调试实例里一个 `write` 就把 flag 打出来了（02 §5.3）。
 * 用测试哨兵值校验，真实 flag 永不进仓库。
 */
export function validateFlagNotLeaked(
  priv: PrivateChallenge,
  flagValue: string | undefined,
): ChallengeIssue[] {
  if (!flagValue) return [];
  const needle = asciiToBytes(flagValue);
  const issues: ChallengeIssue[] = [];

  for (const vma of priv.vmas) {
    if (!vma.hidden) continue;
    const bytes = (vma.init ?? []).flatMap((patch) => [...hexToBytes(patch.hex)]);
    if (containsBytesIgnoringAsciiCase(Uint8Array.from(bytes), needle)) {
      issues.push(issue(`vmas.${vma.id}`, '隐藏 VMA 的内容包含 flag 真值，拒绝加载'));
    }
  }
  for (const [fd, content] of Object.entries(priv.files ?? {})) {
    if (containsBytesIgnoringAsciiCase(hexToBytes(content.hex), needle)) {
      issues.push(issue(`files.${fd}`, '虚拟文件内容包含 flag 真值，拒绝加载'));
    }
  }
  return issues;
}

/** 解析 + 全部校验。服务端加载题目与 `challenge:check` 的唯一入口。 */
export function checkChallengePair(
  publicRaw: unknown,
  privateRaw: unknown,
  ctx: ChallengeLoadContext = {},
): ChallengeCheckResult {
  const merged = mergePseudocode(publicRaw, ctx.pseudocode);
  if (!merged.ok) return { ok: false, issues: merged.issues };
  const pubResult = parsePublicPackage(merged.raw);
  if (!pubResult.ok) return { ok: false, issues: pubResult.issues };
  const privResult = parsePrivatePackage(privateRaw);
  if (!privResult.ok) return { ok: false, issues: privResult.issues };

  const { pub } = pubResult;
  const { priv } = privResult;

  const issues: ChallengeIssue[] = [
    ...validatePublic(pub),
    ...validatePrivate(priv),
    ...validatePair(pub, priv),
  ];

  const encodingResult = expandEncodingOrIssues(pub, ctx.presetItems);
  if (!encodingResult.ok) issues.push(...encodingResult.issues);

  let flagRef: FlagRef | undefined;
  const envMatch = ENV_FLAG_RE.exec(priv.flag);
  if (envMatch) {
    const envVar = envMatch[1] as string;
    if (!ctx.flagValue) {
      issues.push(issue('flag', `环境变量 ${envVar} 缺失，拒绝加载该题（06 §6）`));
    } else {
      flagRef = { kind: 'env', envVar, resolved: ctx.flagValue };
    }
  } else if (!priv.flag.startsWith('env:')) {
    flagRef = { kind: 'literal', value: priv.flag };
  }

  if (encodingResult.ok) {
    const items = encodingResult.items;
    const syscallOps = items.filter((item) => item.op === 'syscall');
    if (syscallOps.length > 0 && (!pub.syscallAbi || !pub.syscalls || pub.syscalls.length === 0)) {
      issues.push(issue('syscalls', '编码表里有 syscall，必须声明 syscallAbi 与 syscalls'));
    }

    const declaredNr = new Set((pub.syscalls ?? []).map((syscall) => syscall.nr));
    for (const item of syscallOps) {
      for (const operand of item.operands) {
        if (operand === 'imm') {
          issues.push(issue('encoding', 'syscall 不支持 imm 形式的调用号'));
          continue;
        }
        const nr = operandConst(operand);
        if (nr !== undefined && !declaredNr.has(nr)) {
          issues.push(issue('encoding', `syscall 的调用号 ${nr} 不在 syscalls 表里`));
        }
      }
    }

    for (const item of items) {
      for (const operand of item.operands) {
        const reg = operandRegister(operand);
        if (reg && !registerSetHas(priv, reg)) {
          issues.push(issue('encoding', `编码表引用了未声明的寄存器：${operand}`));
        }
      }
    }
  }

  const flagValue = flagRef?.kind === 'env' ? flagRef.resolved : ctx.flagValue;
  issues.push(...validateFlagNotLeaked(priv, flagValue));
  // 伪代码是公开面：字面 flag 也要查，不只查环境变量注入的真值。
  issues.push(
    ...validatePseudocodeNoFlag(pub.pseudocode, flagRef?.kind === 'literal' ? flagRef.value : flagValue),
  );

  if (issues.length > 0 || !flagRef || !encodingResult.ok) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    definition: {
      pub,
      priv,
      encoding: encodingResult.items,
      lookup: buildEncodingLookup(encodingResult.items, pub.archBits / 8),
      flagRef,
    },
  };
}

function registerSetHas(priv: PrivateChallenge, name: string): boolean {
  return priv.registers.includes(name);
}

/** 题目 id → 私有包 flag 字段对应的环境变量名；供部署检查与 `challenge:new` 用。 */
export function flagEnvVarName(challengeId: string): string {
  return `FLAG_${challengeId.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * 从私有包的 `flag` 字段解出环境变量名：`"env:FLAG_RET2WIN"` → `"FLAG_RET2WIN"`。
 * flag 是字面量（本地题目包）时返回 `undefined`。
 *
 * 服务端加载器与出题 CLI 都用它，不要各自复刻正则（03 §2.2、06 §6）。
 */
export function flagEnvNameOf(priv: PrivateChallenge): string | undefined {
  return ENV_FLAG_RE.exec(priv.flag)?.[1];
}

/** 编码表引用 preset 时报告用了哪个 preset，便于 CLI 去读 `presets/<name>.json`。 */
export function presetNameOf(pub: PublicChallenge): string | undefined {
  return isEncodingSpec(pub.encoding) ? pub.encoding.preset : undefined;
}
