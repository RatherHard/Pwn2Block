import { describe, expect, it } from 'vitest';
// 相对路径指向的正是 vitest 别名 `@pwn2block/shared` 的目标（`packages/shared/src/index.ts`）：
// 根 `tsconfig.json` 目前没有 `@pwn2block/*` 的 `paths` 映射，`tests/**` 下按包名导入过不了 typecheck。
// 契约缺口已报 A（建议给根 tsconfig 加 paths），加好后这里可以换回包名导入。
import {
  ProjectionSchema,
  PublicChallengeSchema,
  ReplayFrameSchema,
  TEST_FLAG_SENTINEL,
  VmaViewSchema,
  ret2winPrivate,
  ret2winPublic,
  type PrivateChallenge,
} from '../../packages/shared/src/index';

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
 * D1 状态：**部分**。
 * - 已真实执行（前两个 describe）：投影 / 录像 / 公开包的**字段白名单**。以后有人往投影或录像里加字段、
 *   或把私有字段塞进公开包，这里立刻变红。真实对象是 shared 的 Schema 与 `fixtures.ts` 样例。
 * - 未验收（文件末尾 `describe.skip`）：真实引擎与真实 REST 响应上的隐藏字节边界（`write_bytes` 拒绝、
 *   隐藏栈槽 `pop`/`ret`、hex/disasm 覆盖范围、错误与录像正文），关卡 G2 · D4，
 *   验收手段见 `tests/acceptance/README.md`。
 */

/** 投影顶层字段白名单（04 §4 / `ProjectionSchema`）。加字段必须同提交改这里，否则白名单用例变红。 */
const PROJECTION_KEYS = [
  'status',
  'steps',
  'failures',
  'registers',
  'flags',
  'vmas',
  'stdin',
  'stdout',
  'disasm',
  'lastStop',
  'error',
] as const;

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

/** 递归收集对象 / 数组里出现过的所有字段名。 */
function collectKeys(value: unknown, out: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.add(key);
      collectKeys(child, out);
    }
  }
  return out;
}

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
const SENTINEL_HEX = Buffer.from(TEST_FLAG_SENTINEL, 'ascii').toString('hex');

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
 * 按 04 §4 的契约拼一份**形状样例**投影（不是真实投影：真实投影在 D3–D4 由 `@pwn2block/server` 产出）。
 * 要点：隐藏 VMA 只给布局、不给 `hex`；虚拟文件内容不进投影；投影里没有 `flag` / `win` / `fail`。
 */
function buildContractSampleProjection(priv: PrivateChallenge): Record<string, unknown> {
  return {
    status: 'ready',
    steps: 0,
    failures: 0,
    registers: priv.registers.map((name) => ({ name, value: priv.initRegisters?.[name] ?? '0x0' })),
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
    lastStop: { reason: 'step' },
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

describe('S01 字段白名单：投影 / 录像 / 公开包的形状固定', () => {
  it('ProjectionSchema 顶层字段集合固定', () => {
    expect(Object.keys(ProjectionSchema.shape).sort()).toEqual([...PROJECTION_KEYS].sort());
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
  });

  it('公开包 Schema 拒收 flag / win / fail / files 等私有字段', () => {
    const extras = [
      { flag: TEST_FLAG_SENTINEL },
      { win: { reg_eq: { reg: 'FLAG', value: '0x1' } } },
      { fail: [] },
      { files: { '3': { hex: SENTINEL_HEX } } },
      { vmas: [] },
      { initRegisters: {} },
      { roles: { sp: 'RSP', bp: 'RBP', ip: 'RIP' } },
    ];
    for (const extra of extras) {
      expect(PublicChallengeSchema.safeParse({ ...ret2winPublic, ...extra }).success).toBe(false);
    }
  });
});

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

describe.skip('S01 隐藏内容边界 · 待真实引擎与真实服务端（G2 · D4）', () => {
  it.todo('对隐藏 VMA 的 write_bytes 回 hidden_address，且投影逐字段与调用前相等（B/G/C）');
  it.todo('栈槽落在隐藏 VMA 时 pop 回 hidden_address，状态不变（B/G/C）');
  it.todo('栈槽落在隐藏 VMA 时 ret 回 hidden_address，状态不变（B/G/C）');
  it.todo('被拒绝的隐藏区写入不产生任何副作用差异（内存/寄存器/history 均不变，B/G/C）');
  it.todo('真实投影里隐藏 VMA 只有布局、没有 hex（B/C）');
  it.todo('真实 disasm 不覆盖隐藏区域（隐藏 VMA 的地址区间内没有反汇编条目，C）');
  it.todo('真实投影与录像里不出现虚拟文件内容（C）');
  it.todo('真实动作响应与错误文案里不含任何隐藏字节（含 error.message / note，C）');
  it.todo('响应（投影 / 错误 / 录像）里不含私有 win / fail 谓词（C）');
});
