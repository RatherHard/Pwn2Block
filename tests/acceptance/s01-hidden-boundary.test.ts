import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '@pwn2block/engine';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  PrivateChallengeSchema,
  ProjectionSchema,
  PublicChallengeSchema,
  ReplayFrameSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  VmaViewSchema,
  asciiToBytes,
  bytesToHex,
  parseHex,
  ret2winPrivate,
  ret2winPublic,
} from '@pwn2block/shared';
import type {
  DebugInstance,
  EngineRuntime,
  PrivateChallenge,
  PublicChallenge,
} from '@pwn2block/shared';
import {
  collectKeys,
  expectNoInternalLeak,
  findSecretLeaks,
  jsonOf,
  makeChallengeRoot,
  removeChallengeRoot,
  secretForms,
  stateFieldsOf,
  stateFingerprint,
} from './support';
import type { TempChallengeRoot } from './support';

/**
 * S01 · 隐藏内容边界 — owner F（B/G/C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S01 · F，B/G/C 配合 隐藏内容边界：隐藏 VMA 的 write_bytes、隐藏栈槽的 pop/ret 被拒绝且状态不变；
 *     投影/错误/录像不含未经程序公开的隐藏字节或虚拟文件内容；隐藏区无 hex/disasm，响应不含私有 win/fail 谓词。」
 *
 * 07 §5 原始条目（逐字照抄）：
 *   第 1 条：对隐藏 VMA 的 `write_bytes`，以及栈槽落在隐藏 VMA 时的 `pop` / `ret`，都回 `hidden_address`，
 *            状态不变，响应里不含任何隐藏字节。
 *   第 2 条：投影里隐藏 VMA 只有布局、没有 `hex`，`disasm` 不覆盖隐藏区域；投影里不出现虚拟文件内容、
 *            `win`、`fail`。
 *
 * 本文件三段：
 * 1. **字段白名单**（`describe` 一、二）：真实对象是 shared 的 Schema 与 `fixtures.ts` 样例。
 *    以后有人往投影 / 录像里加字段，或把私有字段塞进公开包，这里立刻变红。
 * 2. **真实引擎**（`describe` 三）：真实 `@pwn2block/engine` 的 `createRuntime` +
 *    `createDebugInstance`，逐条断言隐藏区的拒绝码与**逐字段状态不变**（含隐藏 VMA 的内存字节）。
 * 3. **真实 HTTP**（`describe` 四）：真实 `@pwn2block/server` 的 `buildApp` + `inject`，
 *    断言投影 / 错误 / 录像 / 响应正文都不含未经程序公开的隐藏字节、虚拟文件内容与 `win` / `fail` 谓词。
 *
 * 题目包不是 mock：`hiddenLab()` 用真实 `PublicChallengeSchema` / `PrivateChallengeSchema` 构造，
 * 基线取自 03 §4 的 ret2win 夹具，另加一个**隐藏栈 VMA** 与一个**隐藏代码 VMA**，
 * 覆盖「隐藏栈槽的 `pop` / `ret`」与「隐藏区无 disasm」。
 * 题目包写在临时目录里，不落进仓库的 `challenges/`（那是 E 的地盘）。
 */

/** 投影顶层字段白名单（04 §4 / `ProjectionSchema`）。加字段必须同提交改这里，否则白名单用例变红。 */
const PROJECTION_KEYS = [
  'status',
  'steps',
  'failures',
  'registers',
  'roles',
  'flags',
  'vmas',
  'stdin',
  'stdout',
  'disasm',
  'lastStop',
  'error',
] as const;

/** `roles` 只有三个角色名（04 §4 的 D1 契约决策：角色是「固定的已知信息」，随投影下发）。 */
const ROLE_KEYS = ['sp', 'bp', 'ip'] as const;

/** VMA 视图字段白名单：隐藏区只公开布局，内容字段只能是 `hex`，且只对非隐藏 VMA 出现。 */
const VMA_VIEW_KEYS = ['id', 'kind', 'label', 'start', 'size', 'perm', 'hidden', 'hex'] as const;

/** 录像帧字段白名单（04 §5.1）：录像同样只含公开投影。 */
const REPLAY_FRAME_KEYS = [
  'index',
  'label',
  'kind',
  'status',
  'steps',
  'failures',
  'registers',
  'flags',
  'changedVmas',
  'stdin',
  'stdout',
  'lastStop',
  'error',
] as const;

/** 公开投影 / 录像 / 公开包里一律不允许出现的字段名（私有内容与判胜谓词的载体）。 */
const FORBIDDEN_KEYS = [
  'flag',
  'win',
  'fail',
  'private',
  'privateChallenge',
  'files',
  'fileContents',
  'solution',
  'init',
  'content',
] as const;

/** 判题谓词的字段名（03 §2.1）。它们是私有包里 `win` / `fail` 的结构，出现在响应里就是泄露。 */
const PREDICATE_KEYS = [
  'reg_eq',
  'mem_eq',
  'mem_contains',
  'stdout_contains',
  'exited',
  'all',
  'any',
  'not',
] as const;

/** zod v4 节点的内部结构（只用到 object / array / optional / union 四种）。 */
interface ZodNode {
  readonly def?: {
    readonly type?: string;
    readonly shape?: Record<string, ZodNode>;
    readonly element?: ZodNode;
    readonly innerType?: ZodNode;
    readonly options?: readonly ZodNode[];
  };
}

/**
 * 递归收集一份 Schema **声明过**的全部字段名（含嵌套对象与数组元素）。
 *
 * 为什么不能只看解析结果：`z.object` 是宽松的，`parse` 会静默丢掉未声明的字段，
 * 于是「往 Schema 里加一个 flag 字段」在样例扫描里反而看不出来。直接扫 Schema 声明才是真的守卫。
 */
function declaredKeys(schema: ZodNode, out: Set<string> = new Set<string>()): Set<string> {
  const def = schema.def;
  if (!def) return out;
  for (const [key, child] of Object.entries(def.shape ?? {})) {
    out.add(key);
    declaredKeys(child, out);
  }
  if (def.element) declaredKeys(def.element, out);
  if (def.innerType) declaredKeys(def.innerType, out);
  for (const option of def.options ?? []) declaredKeys(option, out);
  return out;
}

/** 07 §5 第 1、2 条用的哨兵真值（08 §5 S05：只用测试哨兵，不写真实 flag）。 */
const SENTINEL_HEX = bytesToHex(asciiToBytes(TEST_FLAG_SENTINEL));

/**
 * 在样例私有包上追加一份**隐藏** VMA（内容为哨兵真值）和一个虚拟文件，用来构造“如果泄露会怎样”的靶子。
 * 只在本文件内派生，不改 `packages/shared`。
 */
const leakyPrivate: PrivateChallenge = {
  ...ret2winPrivate,
  vmas: [
    ...ret2winPrivate.vmas,
    {
      id: 'secret',
      kind: 'key',
      start: '0x600000',
      size: '0x1000',
      perm: 'r',
      hidden: true,
      init: [{ at: '0x600000', hex: SENTINEL_HEX }],
    },
  ],
  files: { '3': { hex: SENTINEL_HEX } },
};

/**
 * 按 04 §4 的契约拼一份**形状样例**投影（不是真实投影：真实投影由 `@pwn2block/server` 产出，见本文件第四节）。
 * 要点：隐藏 VMA 只给布局、不给 `hex`；虚拟文件内容不进投影；投影里没有 `flag` / `win` / `fail`；
 * `roles` 从私有包逐字段取（`ProjectionSchema` 里它是必填项）。
 */
function buildContractSampleProjection(priv: PrivateChallenge): Record<string, unknown> {
  return {
    status: 'ready',
    steps: 0,
    failures: 0,
    registers: priv.registers.map((name) => ({ name, value: priv.initRegisters?.[name] ?? '0x0' })),
    roles: { sp: priv.roles.sp, bp: priv.roles.bp, ip: priv.roles.ip },
    flags: { ZF: false, CF: false, SF: false },
    vmas: priv.vmas.map((vma) => ({
      id: vma.id,
      kind: vma.kind,
      start: vma.start,
      size: vma.size,
      perm: vma.perm,
      hidden: vma.hidden,
      // 契约：隐藏 VMA 的内容一律不下发（01 §6 第 2 条）。
      ...(vma.hidden ? {} : { hex: (vma.init ?? []).map((patch) => patch.hex).join('') }),
    })),
    stdin: { hex: '', pos: 0 },
    stdout: { hex: '' },
    disasm: [],
    lastStop: { reason: 'exception', addr: '0x400000' },
  };
}

const rawSampleProjection = buildContractSampleProjection(leakyPrivate);
const sampleProjection = ProjectionSchema.parse(rawSampleProjection);
const sampleProjectionJson = JSON.stringify(sampleProjection);

/** 私有包里所有 VMA 的原始内容字节（含非隐藏），供“公开包不得出现私有内容”的断言使用。 */
function privateVmaContentHexes(): string[] {
  return ret2winPrivate.vmas.flatMap((vma) => (vma.init ?? []).map((patch) => patch.hex));
}

/**
 * 不允许出现在投影里的字节：**隐藏** VMA 的内容与虚拟文件内容。
 * 非隐藏 VMA 的内容按契约本来就在投影里（`hex`），不能算泄露。
 */
function mustStayHiddenHexes(): string[] {
  const fromHiddenVmas = leakyPrivate.vmas
    .filter((vma) => vma.hidden)
    .flatMap((vma) => (vma.init ?? []).map((patch) => patch.hex));
  const fromFiles = Object.values(leakyPrivate.files ?? {}).map((file) => file.hex);
  return [...fromHiddenVmas, ...fromFiles];
}

// ---------------------------------------------------------------------------
// 真实对象用的题目包：隐藏代码 VMA + 隐藏栈 VMA + 虚拟文件
// ---------------------------------------------------------------------------

/** 隐藏栈 VMA 的内容（ASCII，故意写成可辨别的串，泄露时一眼能认出来）。 */
const STACK_SECRET = 'TOPSECRETSTACK';
/** 隐藏代码 VMA 在四条指令之后跟着的内容（证明隐藏区里确实有字节，只是不下发）。 */
const CODE_SECRET = 'HIDDENCODESECRET';
/** 虚拟文件（fd 3）的内容。 */
const FILE_SECRET = 'VIRTUALFILESECRET';

const STACK_SECRET_HEX = bytesToHex(asciiToBytes(STACK_SECRET));
const CODE_SECRET_HEX = bytesToHex(asciiToBytes(CODE_SECRET));
const FILE_SECRET_HEX = bytesToHex(asciiToBytes(FILE_SECRET));

/** 隐藏代码 VMA 的地址区间：`[0x600000, 0x601000)`。 */
const HCODE_START = 0x600000n;
const HCODE_END = 0x601000n;
/** 隐藏栈 VMA 的地址区间：`[0x700000, 0x701000)`。`RSP` 初值落在它里面。 */
const HSTACK_START = 0x700000n;
const HSTACK_END = 0x701000n;
/** 非隐藏的栈（对照用）：`[0x500000, 0x501000)`。 */
const VISIBLE_STACK_START = 0x500000n;

/** 真实 Schema 构造的“隐藏区实验台”题目包（基线：03 §4 的 ret2win）。 */
function hiddenLab(options: { readonly codeHidden?: boolean; readonly sp?: string } = {}): {
  readonly pub: PublicChallenge;
  readonly priv: PrivateChallenge;
} {
  const pub = PublicChallengeSchema.parse({
    id: 'hidden-lab',
    title: '隐藏区实验台',
    briefing: '隐藏区的内容只能由程序自己读出来。',
    archBits: 64,
    // 编码表直接沿用 ret2win 夹具（完整数组，不引用 preset，引擎不需要额外参数）。
    encoding: ret2winPublic.encoding,
    syscallAbi: ret2winPublic.syscallAbi,
    syscalls: ret2winPublic.syscalls,
    fds: [
      { fd: 0, name: 'stdin', kind: 'stdin' },
      { fd: 1, name: 'stdout', kind: 'stdout' },
      { fd: 3, name: 'secret.txt', kind: 'file', size: FILE_SECRET.length },
    ],
    labels: [
      { name: 'buf', addr: '0x500000', size: 16, kind: 'buffer' },
      { name: 'saved rbp', addr: '0x500010', size: 8, kind: 'saved_bp' },
      { name: 'ret addr', addr: '0x500018', size: 8, kind: 'ret_addr' },
    ],
    // 写原语全开：这样才能把“隐藏区写入”与“允许集拒绝”区分开（否则只会看到 action_not_allowed）。
    allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'step'],
    authorBlocks: [
      {
        id: 'gets',
        label: 'gets(buf)',
        tooltip: '从 buf 起写入字节，不检查长度',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: '0x500000', hex: '$data' }],
      },
      {
        id: 'poke_hidden',
        label: '向隐藏区写入(data)',
        tooltip: '出题人积木也不能绕过隐藏检查',
        params: [{ name: 'data', type: 'bytes' }],
        expand: [{ type: 'write_bytes', addr: '0x600000', hex: '$data' }],
      },
    ],
    errorNotes: { hidden_address: '这块内存只能让程序自己去读' },
  });

  const priv = PrivateChallengeSchema.parse({
    registers: ['RAX', 'RDI', 'RSP', 'RBP', 'RIP', 'FLAG'],
    roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' },
    // RSP 默认落在**隐藏**栈里：pop / ret 必须因此被拒（07 §5 第 1 条）。
    initRegisters: { RSP: options.sp ?? '0x700000', RBP: '0x500010', RIP: '0x400000' },
    vmas: [
      {
        id: 'text',
        kind: 'code',
        start: '0x400000',
        size: '0x1000',
        perm: 'rx',
        hidden: false,
        init: [{ at: '0x400000', hex: 'c9c30f0e' }],
      },
      {
        id: 'stack',
        kind: 'stack',
        start: '0x500000',
        size: '0x1000',
        perm: 'rw',
        hidden: false,
        init: [{ at: '0x500000', hex: 'aa'.repeat(8) }],
      },
      {
        id: 'hcode',
        kind: 'code',
        start: '0x600000',
        size: '0x1000',
        perm: 'rx',
        hidden: options.codeHidden ?? true,
        // 四条真实指令 + 一段 ASCII：隐藏时整段都不许出现在 disasm / 投影里。
        init: [{ at: '0x600000', hex: `c9c30f0e${CODE_SECRET_HEX}` }],
      },
      {
        id: 'hstack',
        kind: 'stack',
        start: '0x700000',
        size: '0x1000',
        perm: 'rw',
        hidden: true,
        init: [{ at: '0x700000', hex: STACK_SECRET_HEX }],
      },
    ],
    files: { '3': { hex: FILE_SECRET_HEX } },
    win: { reg_eq: { reg: 'FLAG', value: '0x1' } },
    fail: [{ all: [{ exited: {} }, { not: { reg_eq: { reg: 'FLAG', value: '0x1' } } }] }],
    flag: 'env:FLAG_HIDDEN_LAB',
  });

  return { pub, priv };
}

const lab = hiddenLab();

/** 一份全新的真实引擎实例（每个用例都从初态开始，互不污染）。 */
function freshDebug(options: { readonly sp?: string } = {}): {
  readonly runtime: EngineRuntime;
  readonly debug: DebugInstance;
} {
  const packages = hiddenLab(options);
  const runtime = createRuntime(packages.pub, packages.priv);
  return { runtime, debug: runtime.createDebugInstance() };
}

/** 响应 / 响应正文里一律不许出现的字节串：隐藏 VMA 内容、虚拟文件内容、flag 哨兵真值。 */
function mustNeverAppear(): string[] {
  return [STACK_SECRET_HEX, CODE_SECRET_HEX, FILE_SECRET_HEX, SENTINEL_HEX, TEST_FLAG_SENTINEL];
}

// ---------------------------------------------------------------------------
// 一、字段白名单：投影 / 录像 / 公开包的形状固定
// ---------------------------------------------------------------------------

describe('S01 字段白名单：投影 / 录像 / 公开包的形状固定', () => {
  it('ProjectionSchema 顶层字段集合固定', () => {
    expect(Object.keys(ProjectionSchema.shape).sort()).toEqual([...PROJECTION_KEYS].sort());
  });

  it('投影 roles 只含 sp / bp / ip：角色名逐个取自私有包，不夹带其它私有字段', () => {
    const rolesSchema = ProjectionSchema.shape.roles as unknown as ZodNode;
    expect([...declaredKeys(rolesSchema)].sort()).toEqual([...ROLE_KEYS].sort());

    const roles = sampleProjection.roles;
    expect(Object.keys(roles).sort()).toEqual([...ROLE_KEYS].sort());
    for (const name of Object.values(roles)) {
      // 角色名必须是私有包声明过的寄存器，不能凭空捏造。
      expect(ret2winPrivate.registers).toContain(name);
    }
    // 整个 roles 子树只有三个字符串叶子，没有嵌套对象可以夹带 `flag` / `win` / `fail`。
    expect([...collectKeys(roles)].sort()).toEqual([...ROLE_KEYS].sort());
  });

  it('VmaViewSchema 字段集合固定：内容字段只能是 hex', () => {
    expect(Object.keys(VmaViewSchema.shape).sort()).toEqual([...VMA_VIEW_KEYS].sort());
  });

  it('ReplayFrameSchema 字段集合固定：录像不引入新的泄露面', () => {
    expect(Object.keys(ReplayFrameSchema.shape).sort()).toEqual([...REPLAY_FRAME_KEYS].sort());
  });

  it('投影 / 录像 / 公开包契约的任何层级都不存在禁止字段（递归扫描 Schema 声明）', () => {
    const keys = new Set<string>();
    for (const schema of [ProjectionSchema, ReplayFrameSchema, PublicChallengeSchema]) {
      declaredKeys(schema as unknown as ZodNode, keys);
    }
    // 自检：确认扫描器确实走到了嵌套对象与数组元素，别让它失效后静默丢覆盖。
    for (const expected of [
      'status',
      'steps',
      'failures',
      'registers',
      'roles',
      'sp',
      'bp',
      'ip',
      'flags',
      'vmas',
      'stdin',
      'stdout',
      'disasm',
      'lastStop',
      'error',
      'id',
      'kind',
      'label',
      'start',
      'size',
      'perm',
      'hidden',
      'hex',
      'pos',
      'addr',
      'bytes',
      'text',
      'target',
      'reason',
      'code',
      'message',
      'note',
      'name',
      'value',
      'ZF',
      'CF',
      'SF',
      'changedVmas',
      'index',
      'authorBlocks',
      'allowedActions',
    ]) {
      expect(keys).toContain(expected);
    }
    for (const forbidden of FORBIDDEN_KEYS) expect([...keys]).not.toContain(forbidden);
    for (const predicate of PREDICATE_KEYS) expect([...keys]).not.toContain(predicate);
  });

  it('公开包 Schema 拒收 flag / win / fail / files / roles 等私有字段', () => {
    const extras = [
      { flag: TEST_FLAG_SENTINEL },
      { win: { reg_eq: { reg: 'FLAG', value: '0x1' } } },
      { fail: [] },
      { files: { '3': { hex: SENTINEL_HEX } } },
      { vmas: [] },
      { initRegisters: {} },
      // `roles` 随投影下发，但**不进公开包**：出题人只在私有包里声明一次（04 §4、09 §4）。
      { roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' } },
    ];
    for (const extra of extras) {
      expect(PublicChallengeSchema.safeParse({ ...ret2winPublic, ...extra }).success).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 二、内容边界：形状样例（shared 契约层）
// ---------------------------------------------------------------------------

describe('S01 内容边界：公开面不含隐藏字节、虚拟文件内容与 win/fail 谓词', () => {
  it('形状样例能通过 ProjectionSchema 校验，且解析前顶层键全部落在白名单内', () => {
    expect(ProjectionSchema.safeParse(rawSampleProjection).success).toBe(true);
    for (const key of Object.keys(rawSampleProjection)) {
      expect([...PROJECTION_KEYS]).toContain(key);
    }
  });

  it('解析前的形状样例在任何层级都没有禁止字段', () => {
    const keys = [...collectKeys(rawSampleProjection)];
    for (const forbidden of FORBIDDEN_KEYS) expect(keys).not.toContain(forbidden);
    for (const predicate of PREDICATE_KEYS) expect(keys).not.toContain(predicate);
  });

  it('隐藏 VMA 在投影里只有布局：带 hidden: true，且不带 hex', () => {
    const hiddenVma = sampleProjection.vmas.find((vma) => vma.hidden);
    expect(hiddenVma).toBeDefined();
    expect(hiddenVma?.id).toBe('secret');
    expect(Object.keys(hiddenVma ?? {})).not.toContain('hex');
  });

  it('非隐藏 VMA 带 hex（确认上一条不是空断言）', () => {
    const visibleVma = sampleProjection.vmas.find((vma) => !vma.hidden);
    expect(visibleVma).toBeDefined();
    expect(Object.keys(visibleVma ?? {})).toContain('hex');
  });

  it('投影样例的 JSON 里不出现哨兵真值、隐藏 VMA 内容与虚拟文件内容', () => {
    expect(sampleProjectionJson).not.toContain(TEST_FLAG_SENTINEL);
    expect(sampleProjectionJson).not.toContain(SENTINEL_HEX);
    for (const hex of mustStayHiddenHexes()) {
      if (hex === '') continue;
      expect(sampleProjectionJson).not.toContain(hex);
    }
  });

  it('下发给浏览器的公开包样例不带任何私有 VMA 内容', () => {
    const publicJson = JSON.stringify(ret2winPublic);
    for (const hex of privateVmaContentHexes()) expect(publicJson).not.toContain(hex);
    expect(publicJson).not.toContain(TEST_FLAG_SENTINEL);
    expect(publicJson).not.toContain('env:FLAG');
    const keys = [...collectKeys(ret2winPublic)];
    for (const forbidden of FORBIDDEN_KEYS) expect(keys).not.toContain(forbidden);
  });

  it('样例私有包的 flag 只写环境变量引用（真值不进仓库）', () => {
    expect(ret2winPrivate.flag).toMatch(/^env:FLAG_[A-Z0-9_]+$/);
  });
});

// ---------------------------------------------------------------------------
// 三、真实引擎：隐藏区的直接动作被拒绝，且状态逐字段不变（07 §5 第 1 条）
// ---------------------------------------------------------------------------

describe('S01 真实引擎：隐藏区直接动作被拒绝且状态不变（07 §5 第 1 条）', () => {
  it('隐藏代码 VMA 里确实有字节：readVma 读得到，readVmaVisible / readVisible 读不到', () => {
    const { runtime, debug } = freshDebug();
    const state = debug.state();

    const raw = runtime.memory.readVma(state.memory, 'hcode');
    const prefix = raw === undefined ? '<unreadable>' : bytesToHex(raw.subarray(0, 4 + CODE_SECRET.length));
    expect(prefix).toBe(`c9c30f0e${CODE_SECRET_HEX}`);

    expect(runtime.readVmaVisible(state, 'hcode')).toBeUndefined();
    expect(runtime.readVisible(state, HCODE_START, 4)).toEqual({ ok: false, reason: 'hidden' });
    // 对照：非隐藏的 text 读得到，证明上面不是“引擎一律读不到”。
    expect(runtime.readVmaVisible(state, 'text')).toBeDefined();
    expect(runtime.readVisible(state, 0x400000n, 4).ok).toBe(true);
  });

  it('对隐藏代码 VMA 的 write_bytes 回 hidden_address，VM 状态逐字段不变且不压快照', () => {
    const { runtime, debug } = freshDebug();
    const before = stateFingerprint(runtime, debug.state());
    const historyBefore = debug.historyDepth();

    const outcome = debug.applyRequest([{ type: 'write_bytes', addr: '0x600000', hex: '41' }]);

    expect(outcome.executed).toBe(0);
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.action).toBe('write_bytes');
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.results[0]?.error?.addr).toBe(HCODE_START);
    expect(stateFingerprint(runtime, debug.state())).toBe(before);
    expect(debug.historyDepth()).toEqual(historyBefore);
    // 被拒绝的动作计入 failures（04 §3），这是计数而不是状态。
    expect(outcome.failures).toBe(1);
  });

  it('写入跨越隐藏栈 VMA 的区间同样回 hidden_address，状态不变', () => {
    const { runtime, debug } = freshDebug();
    const before = stateFingerprint(runtime, debug.state());

    const outcome = debug.applyRequest([{ type: 'write_bytes', addr: '0x700002', hex: '4142' }]);

    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.results[0]?.error?.addr).toBe(HSTACK_START + 2n);
    expect(stateFingerprint(runtime, debug.state())).toBe(before);
  });

  it('栈槽落在隐藏 VMA 时 pop 回 hidden_address，状态不变（RSP 一个字节都不动）', () => {
    const { runtime, debug } = freshDebug();
    const before = stateFingerprint(runtime, debug.state());
    const spBefore = debug.state().registers.RSP;

    const outcome = debug.applyRequest([{ type: 'pop' }]);

    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.results[0]?.error?.addr).toBe(HSTACK_START);
    expect(debug.state().registers.RSP).toBe(spBefore);
    expect(spBefore).toBe(HSTACK_START);
    expect(stateFingerprint(runtime, debug.state())).toBe(before);
  });

  it('栈槽落在隐藏 VMA 时 ret 回 hidden_address，状态不变（ip 不动）', () => {
    const { runtime, debug } = freshDebug();
    const before = stateFingerprint(runtime, debug.state());
    const ipBefore = debug.state().registers.RIP;

    const outcome = debug.applyRequest([{ type: 'ret' }]);

    expect(outcome.results[0]?.ok).toBe(false);
    expect(outcome.results[0]?.error?.code).toBe('hidden_address');
    expect(outcome.results[0]?.error?.addr).toBe(HSTACK_START);
    expect(debug.state().registers.RIP).toBe(ipBefore);
    expect(stateFingerprint(runtime, debug.state())).toBe(before);
  });

  it('对照：RSP 落在非隐藏栈时 pop / ret 正常生效（证明上两条不是空断言）', () => {
    const pop = freshDebug({ sp: '0x500000' });
    const popOutcome = pop.debug.applyRequest([{ type: 'pop' }]);
    expect(popOutcome.results[0]?.ok).toBe(true);
    expect(pop.debug.state().registers.RSP).toBe(VISIBLE_STACK_START + 8n);

    const ret = freshDebug({ sp: '0x500000' });
    const retOutcome = ret.debug.applyRequest([{ type: 'ret' }]);
    expect(retOutcome.results[0]?.ok).toBe(true);
    // 非隐藏栈的初值 'aa' × 8 → ip 直接吃下这个字（不执行指令）。
    expect(ret.debug.state().registers.RIP).toBe(0xaaaaaaaaaaaaaaaan);
    expect(ret.debug.state().registers.RSP).toBe(VISIBLE_STACK_START + 8n);
  });

  it('出题人积木的展开写入隐藏区同样回 hidden_address：积木不能绕过隐藏检查', () => {
    const { runtime, debug } = freshDebug();
    const before = stateFingerprint(runtime, debug.state());

    const rejectedBlock = debug.applyRequest([
      { type: 'block', id: 'poke_hidden', args: { data: '41' } },
    ]);
    expect(rejectedBlock.results[0]?.ok).toBe(false);
    expect(rejectedBlock.results[0]?.action).toBe('block');
    expect(rejectedBlock.results[0]?.error?.code).toBe('hidden_address');
    expect(rejectedBlock.results[0]?.error?.addr).toBe(HCODE_START);
    expect(stateFingerprint(runtime, debug.state())).toBe(before);

    // 对照：同一个会话上写非隐藏栈的积木正常生效。
    const okBlock = debug.applyRequest([{ type: 'block', id: 'gets', args: { data: '41' } }]);
    expect(okBlock.results[0]?.ok).toBe(true);
    const stack = debug.state();
    const bytes = runtime.memory.readVma(stack.memory, 'stack');
    expect(bytes === undefined ? '' : bytesToHex(bytes.subarray(0, 1))).toBe('41');
  });

  it('disasm 不覆盖隐藏区域；同一份包把 hcode 设为非隐藏后确实会被反汇编（对照）', () => {
    const { runtime, debug } = freshDebug();
    const entries = runtime.disassemble(debug.state());
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const addr = parseHex(entry.addr);
      expect(addr).toBeGreaterThanOrEqual(0x400000n);
      expect(addr).toBeLessThan(0x401000n);
      expect(addr >= HCODE_START && addr < HCODE_END).toBe(false);
      expect(addr >= HSTACK_START && addr < HSTACK_END).toBe(false);
    }
    // 隐藏 VMA 里带 `x` 权限也一样：权限公开，内容不公开。
    expect(lab.priv.vmas.find((vma) => vma.id === 'hcode')?.perm).toBe('rx');

    const controlPackages = hiddenLab({ codeHidden: false });
    const control = createRuntime(controlPackages.pub, controlPackages.priv);
    const controlEntries = control.disassemble(control.createDebugInstance().state());
    const inHiddenRange = controlEntries.filter((entry) => {
      const addr = parseHex(entry.addr);
      return addr >= HCODE_START && addr < HCODE_END;
    });
    expect(inHiddenRange.length).toBeGreaterThan(0);
    expect(inHiddenRange[0]?.addr).toBe('0x600000');
  });
});

// ---------------------------------------------------------------------------
// 四、真实 HTTP：真实 buildApp + inject（07 §5 第 1、2 条）
// ---------------------------------------------------------------------------

type App = ReturnType<typeof buildApp>;

let app: App;
let root: TempChallengeRoot;

beforeAll(async () => {
  root = makeChallengeRoot({ 'hidden-lab': { pub: lab.pub, priv: lab.priv } });
  app = buildApp({
    challengeDir: root.challengeDir,
    presetDir: root.presetDir,
    env: { FLAG_HIDDEN_LAB: TEST_FLAG_SENTINEL },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  removeChallengeRoot(root);
});

async function createSession(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: 'hidden-lab' },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

async function readState(sessionId: string): Promise<ReturnType<typeof SessionStateResponseSchema.parse>> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  expect(response.statusCode).toBe(200);
  return SessionStateResponseSchema.parse(response.json());
}

async function act(
  sessionId: string,
  actions: readonly unknown[],
): Promise<{ readonly response: Awaited<ReturnType<App['inject']>>; readonly body: ReturnType<typeof ActionsResponseSchema.parse> }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/actions`,
    payload: { actions },
  });
  expect(response.statusCode).toBe(200);
  return { response, body: ActionsResponseSchema.parse(response.json()) };
}

describe('S01 真实 HTTP：投影 / 错误 / 录像 / 响应正文都不含隐藏内容', () => {
  it('创建会话：隐藏 VMA 只有布局、没有 hex；非隐藏 VMA 带 hex（非空断言）', async () => {
    const sessionId = await createSession();
    const { projection } = await readState(sessionId);

    expect(projection.roles).toEqual({ sp: 'RSP', bp: 'RBP', ip: 'RIP' });

    const hcode = projection.vmas.find((vma) => vma.id === 'hcode');
    expect(hcode).toEqual({
      id: 'hcode',
      kind: 'code',
      start: '0x600000',
      size: '0x1000',
      perm: 'rx',
      hidden: true,
    });
    const hstack = projection.vmas.find((vma) => vma.id === 'hstack');
    expect(hstack?.hidden).toBe(true);
    expect(hstack?.hex).toBeUndefined();

    const stack = projection.vmas.find((vma) => vma.id === 'stack');
    expect(stack?.hidden).toBe(false);
    expect(stack?.hex?.startsWith('aa'.repeat(8))).toBe(true);
  });

  it('投影正文不含隐藏 VMA 内容、虚拟文件内容、哨兵真值与 win/fail 谓词字段', async () => {
    const sessionId = await createSession();
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    const parsed = SessionStateResponseSchema.parse(response.json());
    const body = jsonOf(parsed);

    expectNoInternalLeak(response.body, mustNeverAppear());
    expect(body).not.toContain(STACK_SECRET);
    expect(body).not.toContain(CODE_SECRET);
    expect(body).not.toContain(FILE_SECRET);
    // 非空断言：非隐藏 VMA 的内容按契约本来就在投影里。
    expect(body).toContain('aa'.repeat(8));

    const keys = [...collectKeys(parsed)];
    for (const forbidden of FORBIDDEN_KEYS) expect(keys).not.toContain(forbidden);
    for (const predicate of PREDICATE_KEYS) expect(keys).not.toContain(predicate);
  });

  it('对隐藏 VMA 的 write_bytes：回 hidden_address、状态逐字段不变、错误文案不含隐藏字节', async () => {
    const sessionId = await createSession();
    const before = await readState(sessionId);

    const { response, body } = await act(sessionId, [
      { type: 'write_bytes', addr: '0x600000', hex: '41' },
    ]);

    expect(body.executed).toBe(0);
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.error?.code).toBe('hidden_address');
    expect(body.results[0]?.error?.message).toBe('目标落在隐藏区域，直接动作不能读写隐藏内容（地址 0x600000）');
    expect(body.results[0]?.error?.note).toBe('这块内存只能让程序自己去读');

    const after = await readState(sessionId);
    // 状态逐字段不变（`failures` 见下面的正面断言，04 §3 不计入比较）。
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(before.projection.failures).toBe(0);
    expect(after.projection.failures).toBe(before.projection.failures + 1);
    // 被拒绝的动作不产生历史位置（04 §2、§3）：两层回退深度都不该因这次拒绝增加。
    expect(after.history).toEqual(before.history);
    expectNoInternalLeak(response.body, mustNeverAppear());
  });

  it('隐藏栈槽的 pop / ret：都回 hidden_address，状态逐字段不变', async () => {
    const sessionId = await createSession();
    const before = await readState(sessionId);
    expect(before.projection.registers.find((item) => item.name === 'RSP')?.value).toBe('0x700000');

    const pop = await act(sessionId, [{ type: 'pop' }]);
    expect(pop.body.results[0]?.error?.code).toBe('hidden_address');
    expect((await readState(sessionId)).projection.registers).toEqual(before.projection.registers);

    const ret = await act(sessionId, [{ type: 'ret' }]);
    expect(ret.body.results[0]?.error?.code).toBe('hidden_address');

    const after = await readState(sessionId);
    // 两次拒绝都不改状态；`failures` 按 04 §3 单调递增，单独正面断言。
    expect(stateFieldsOf(after.projection)).toBe(stateFieldsOf(before.projection));
    expect(after.projection.failures).toBe(before.projection.failures + 2);
    expect(after.history).toEqual(before.history);
    expectNoInternalLeak(pop.response.body, mustNeverAppear());
    expectNoInternalLeak(ret.response.body, mustNeverAppear());
  });

  it('出题人积木展开写入隐藏区：被拒且状态不变；写非隐藏栈的积木照常生效', async () => {
    const sessionId = await createSession();
    const before = await readState(sessionId);

    const { body } = await act(sessionId, [{ type: 'block', id: 'poke_hidden', args: { data: '41' } }]);
    expect(body.results[0]?.ok).toBe(false);
    expect(body.results[0]?.action).toBe('block');
    expect(body.results[0]?.error?.code).toBe('hidden_address');
    const afterReject = await readState(sessionId);
    expect(stateFieldsOf(afterReject.projection)).toBe(stateFieldsOf(before.projection));
    expect(afterReject.projection.failures).toBe(before.projection.failures + 1);
    expect(afterReject.history).toEqual(before.history);

    const ok = await act(sessionId, [{ type: 'block', id: 'gets', args: { data: '4142' } }]);
    expect(ok.body.results[0]?.ok).toBe(true);
    const stack = ok.body.projection.vmas.find((vma) => vma.id === 'stack');
    expect(stack?.hex?.startsWith('4142')).toBe(true);
  });

  it('投影里的 disasm 只覆盖非隐藏的可执行区（隐藏区没有 hex，也没有反汇编条目）', async () => {
    const sessionId = await createSession();
    const { projection } = await readState(sessionId);

    expect(projection.disasm.length).toBeGreaterThan(0);
    for (const entry of projection.disasm) {
      const addr = parseHex(entry.addr);
      expect(addr).toBeGreaterThanOrEqual(0x400000n);
      expect(addr).toBeLessThan(0x401000n);
    }
    expect(projection.disasm.map((entry) => entry.addr)).toEqual([
      '0x400000',
      '0x400001',
      '0x400002',
      '0x400003',
    ]);
    for (const vma of projection.vmas) {
      if (!vma.hidden) continue;
      expect(vma.hex).toBeUndefined();
    }
  });

  it('提交录像：只含公开投影，隐藏字节与私有谓词都不出现', async () => {
    const sessionId = await createSession();
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/submit`,
      payload: {
        actions: [
          { type: 'write_bytes', addr: '0x500000', hex: '41' },
          { type: 'pop' },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    const body = SubmitResponseSchema.parse(response.json());

    expect(body.verdict).toBe('rejected');
    expect(body.executed).toBe(1);
    expect(body.flag).toBeUndefined();
    expect(body.results[1]?.error?.code).toBe('hidden_address');

    // 录像首份投影同样只有布局。
    const hiddenInInitial = body.replay.initial.vmas.filter((vma) => vma.hidden);
    expect(hiddenInInitial.map((vma) => vma.id).sort()).toEqual(['hcode', 'hstack']);
    for (const vma of hiddenInInitial) expect(vma.hex).toBeUndefined();

    // 非空断言：第一个动作真的改了非隐藏栈，录像确实带内容。
    const changed = body.replay.frames[0]?.changedVmas.find((vma) => vma.id === 'stack');
    expect(changed?.hex?.startsWith('41')).toBe(true);

    const replayJson = jsonOf(body.replay);
    expect(replayJson).toContain('0x500000');
    expect(replayJson).not.toContain(STACK_SECRET_HEX);
    expect(replayJson).not.toContain(CODE_SECRET_HEX);
    expect(replayJson).not.toContain(FILE_SECRET_HEX);
    expect(replayJson).not.toContain(SENTINEL_HEX);
    expectNoInternalLeak(response.body, mustNeverAppear());

    const keys = [...collectKeys(body)];
    for (const forbidden of FORBIDDEN_KEYS) expect(keys).not.toContain(forbidden);
    for (const predicate of PREDICATE_KEYS) expect(keys).not.toContain(predicate);
  });
});

// ---------------------------------------------------------------------------
// 五、多形态泄露扫描：隐藏内容不以任何编码形式出现在任何响应里
// ---------------------------------------------------------------------------

/**
 * 必须永远不下发的秘密（04 §4「隐藏 VMA 的内容、虚拟文件内容、win/fail 永不出现在任何响应中」）。
 *
 * 这里按**字节**登记，扫描时展开成 hex 大小写 / 原始 ASCII / base64 四种形态：
 * 只扫 hex 会漏掉 ASCII 与 base64 两种同样算泄露的形式（D3 的独立复核也是这么扫的，本用例把它固化下来）。
 */
const HIDDEN_SECRETS: Readonly<Record<string, Uint8Array>> = {
  '隐藏栈内容': asciiToBytes(STACK_SECRET),
  '隐藏代码区内容': asciiToBytes(CODE_SECRET),
  '虚拟文件内容': asciiToBytes(FILE_SECRET),
  'flag 哨兵真值': asciiToBytes(TEST_FLAG_SENTINEL),
};

/** 一次真实 HTTP 调用与它的用途说明。 */
interface ScannedResponse {
  readonly what: string;
  readonly response: Awaited<ReturnType<App['inject']>>;
}

describe('S01 多形态泄露扫描：隐藏内容不以任何编码形式出现在任何响应里', () => {
  it('扫描器正对照：每个秘密的每种编码形态都能被命中（否则下面的零命中是空转）', () => {
    for (const [label, bytes] of Object.entries(HIDDEN_SECRETS)) {
      const forms = secretForms(bytes);
      // ascii / base64 / hex / hex 大写：去重后至少三种，且都够长到不是随机命中。
      expect(forms.length, label).toBeGreaterThanOrEqual(3);
      for (const form of forms) {
        expect(findSecretLeaks(`{"x":"${form}"}`, HIDDEN_SECRETS), `${label} 的 ${form}`).toEqual([
          { label, form },
        ]);
      }
    }
    // 反面对照：不含秘密的正文零命中。
    expect(findSecretLeaks('{"status":"ready","steps":0}', HIDDEN_SECRETS)).toEqual([]);
  });

  it('全流程每一个响应正文都零命中：列表 / 公开包 / 建会话 / 投影 / 动作错误 / 录像 / 404', async () => {
    const sessionId = await createSession();

    const scanned: ScannedResponse[] = [
      { what: '题目列表', response: await app.inject({ method: 'GET', url: '/api/challenges' }) },
      {
        what: '题目公开包',
        response: await app.inject({ method: 'GET', url: '/api/challenges/hidden-lab' }),
      },
      {
        what: '创建会话',
        response: await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: 'hidden-lab' },
        }),
      },
      {
        what: '当前投影',
        response: await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` }),
      },
      {
        what: '动作被拒的错误正文（隐藏 VMA 写入）',
        response: await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions: [{ type: 'write_bytes', addr: '0x600000', hex: '41' }] },
        }),
      },
      {
        what: '动作被拒的错误正文（隐藏栈槽 pop）',
        response: await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions: [{ type: 'pop' }] },
        }),
      },
      {
        what: '出题人积木被拒的错误正文',
        response: await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/actions`,
          payload: { actions: [{ type: 'block', id: 'poke_hidden', args: { data: '41' } }] },
        }),
      },
      {
        what: '提交录像（含逐帧 diff）',
        response: await app.inject({
          method: 'POST',
          url: `/api/sessions/${sessionId}/submit`,
          payload: {
            actions: [
              { type: 'write_bytes', addr: '0x500000', hex: '4142' },
              { type: 'pop' },
            ],
          },
        }),
      },
      {
        what: '未知会话的 404 正文',
        response: await app.inject({
          method: 'GET',
          url: '/api/sessions/00000000000000000000000000000000',
        }),
      },
      {
        what: '未知题目的 404 正文',
        response: await app.inject({
          method: 'POST',
          url: '/api/sessions',
          payload: { challengeId: 'no-such-lab' },
        }),
      },
    ];

    for (const { what, response } of scanned) {
      expect(findSecretLeaks(response.body, HIDDEN_SECRETS), `${what} 的响应正文命中隐藏内容`).toEqual(
        [],
      );
      expectNoInternalLeak(response.body, mustNeverAppear());
    }

    // 非空断言：扫描的确实是**有内容**的响应正文，而不是一串空体或全 404。
    const projectionBody = scanned.find((item) => item.what === '当前投影')?.response.body ?? '';
    expect(projectionBody).toContain('aa'.repeat(8));
    expect(projectionBody).toContain('0x600000');
    const replayBody = scanned.find((item) => item.what === '提交录像（含逐帧 diff）')?.response.body ?? '';
    expect(replayBody).toContain('4142');
    expect(scanned.filter((item) => item.response.statusCode === 200).length).toBeGreaterThanOrEqual(8);
  });
});
