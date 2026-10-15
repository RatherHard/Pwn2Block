import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  API_ERROR_STATUS,
  ApiErrorSchema,
  NO_FLAGS,
  PAGE_SIZE,
  PrivateChallengeSchema,
  PublicChallengeSchema,
  TEST_FLAG_SENTINEL,
  asciiToBytes,
  bytesToHex,
  formatHex,
  hexToBytes,
  ret2winPrivate,
  ret2winPublic,
} from '@pwn2block/shared';
import type {
  Action,
  ActionName,
  ActionResult as EngineActionResult,
  ApiErrorCode,
  ChallengeVma,
  DebugInstance,
  DisasmEntry,
  EngineRuntime,
  ErrorCode,
  HistoryDepth,
  MemoryApi,
  PrivateChallenge,
  PublicChallenge,
  ReplayFrame,
  RequestOutcome,
  SubmitOutcome,
  Verdict,
  VmState,
  VmaLayout,
} from '@pwn2block/shared';
import type { LightMyRequestResponse } from 'fastify';

/**
 * 服务端测试的公共设施：一份能通过 `checkChallengePair` 的样例题目包 +
 * 一个受测试控制的 fake runtime（引擎 B/G 在 D1 还没实现，08 §3 D1 要求注入 fake）。
 */

/** 部署时注入的 flag 真值；与写进隐藏 VMA 的哨兵值故意不同。 */
export const TEST_FLAG_VALUE = 'flag{server-test-value}';

export const TEST_ENV: Readonly<Record<string, string | undefined>> = {
  FLAG_RET2WIN: TEST_FLAG_VALUE,
};

/** 隐藏 key VMA 的内容：测试哨兵值，投影里永远不该出现。 */
export const HIDDEN_KEY_HEX = bytesToHex(asciiToBytes(TEST_FLAG_SENTINEL));

const HIDDEN_KEY_VMA: ChallengeVma = {
  id: 'key',
  kind: 'key',
  start: '0x600000',
  size: '0x1000',
  perm: 'r',
  hidden: true,
  init: [{ at: '0x600000', hex: HIDDEN_KEY_HEX }],
};

/** 在 ret2win 样例上补出隐藏 VMA、stdio fd 与一条 errorNotes。 */
export function testPublic(overrides: Partial<PublicChallenge> = {}): PublicChallenge {
  return PublicChallengeSchema.parse({
    ...ret2winPublic,
    fds: [
      { fd: 0, name: 'stdin', kind: 'stdin' },
      { fd: 1, name: 'stdout', kind: 'stdout' },
    ],
    errorNotes: { hidden_address: '这块内存只能让程序自己去读' },
    ...overrides,
  });
}

export function testPrivate(overrides: Partial<PrivateChallenge> = {}): PrivateChallenge {
  return PrivateChallengeSchema.parse({
    ...ret2winPrivate,
    vmas: [...ret2winPrivate.vmas, HIDDEN_KEY_VMA],
    ...overrides,
  });
}

/** `hex` 补齐到 `size` 字节（后面填 0），用于精确断言整块 VMA 内容。 */
export function padded(hex: string, size: number): string {
  return hex + '00'.repeat(size - hex.length / 2);
}

export interface FakeRuntimeOptions {
  readonly publicPkg?: PublicChallenge;
  readonly privatePkg?: PrivateChallenge;
  readonly verdict?: Verdict;
  /** 这些动作会以拒绝结果返回，引擎随即停下（真实引擎拒绝时也会停）。 */
  readonly rejectActions?: readonly ActionName[];
  /** 拒绝结果的错误码与补充信息；默认 `not_executable`。 */
  readonly rejectResult?: { readonly code: ErrorCode; readonly detail?: string };
  readonly disasm?: readonly DisasmEntry[];
  readonly revealed?: readonly string[];
  /**
   * 覆盖初态寄存器值（键与 `privatePkg.registers` 对齐）。
   * 用来构造非 `RSP`/`RBP`/`RIP` 命名的题目，验证 `roles` 是**透传**而不是服务端硬编码。
   */
  readonly registers?: Readonly<Record<string, bigint>>;
}

export interface FakeRuntime {
  readonly runtime: EngineRuntime;
  /** 引擎实际收到的**原子动作**类型序列，跨请求累积，用来断言顺序与停止语义。 */
  readonly calls: string[];
}

function buildContents(vmas: readonly ChallengeVma[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const vma of vmas) {
    const size = Number(BigInt(vma.size));
    const bytes = new Uint8Array(size);
    for (const patch of vma.init ?? []) {
      bytes.set(hexToBytes(patch.hex), Number(BigInt(patch.at) - BigInt(vma.start)));
    }
    out.set(vma.id, bytes);
  }
  return out;
}

/** 造一个 fake `EngineRuntime`：状态与历史由测试完全掌控，不依赖真实引擎。 */
export function makeFakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  const pub = options.publicPkg ?? testPublic();
  const priv = options.privatePkg ?? testPrivate();
  const calls: string[] = [];
  const contents = buildContents(priv.vmas);
  const layout: VmaLayout[] = priv.vmas.map((vma) => ({
    id: vma.id,
    kind: vma.kind,
    label: vma.label,
    start: vma.start,
    size: formatHex(BigInt(vma.size)),
    perm: vma.perm,
    hidden: vma.hidden,
  }));

  const notImplemented = (): never => {
    throw new Error('fake runtime 不实现这个入口');
  };
  const memory: MemoryApi = {
    pageSize: PAGE_SIZE,
    create: notImplemented,
    check: notImplemented,
    read: notImplemented,
    write: notImplemented,
    copy: notImplemented,
    readVma: notImplemented,
    snapshot: notImplemented,
    restore: notImplemented,
  };

  const initialState = (): VmState => ({
    archBits: pub.archBits,
    registers: {
      RAX: 0n,
      RDI: 0n,
      RSP: 0x7fffff00n,
      RBP: 0x7fffff10n,
      RIP: 0x400000n,
      FLAG: 0n,
      ...(options.registers ?? {}),
    },
    flags: NO_FLAGS,
    memory: { kind: 'cow-memory' },
    revealed: [...(options.revealed ?? [])],
    stdin: { bytes: new Uint8Array(0), pos: 0 },
    stdout: new Uint8Array(0),
    fileOffsets: {},
    status: 'ready',
    steps: 0,
  });

  const createDebugInstance = (): DebugInstance => {
    let state = initialState();
    let failures = 0;
    let undo = 0;
    return {
      state: () => state,
      failures: () => failures,
      historyDepth: (): HistoryDepth => ({ undo, stepBack: 0 }),
      applyRequest: (actions: readonly Action[]): RequestOutcome => {
        const results: EngineActionResult[] = [];
        let executed = 0;
        for (const action of actions) {
          calls.push(action.type);
          if ((options.rejectActions ?? []).includes(action.type)) {
            const reject = options.rejectResult ?? { code: 'not_executable' as const };
            results.push({
              ok: false,
              action: action.type,
              error: {
                code: reject.code,
                ...(reject.detail === undefined ? {} : { detail: reject.detail }),
              },
            });
            failures += 1;
            break;
          }
          results.push({ ok: true, action: action.type });
          executed += 1;
          state = { ...state, steps: state.steps + 1 };
        }
        undo += 1;
        return { results, executed, state, failures };
      },
    };
  };

  const rejectErrorOf = (): { code: ErrorCode; detail?: string } =>
    options.rejectResult ?? { code: 'not_executable' };

  const replaySubmit = (actions: readonly Action[]): SubmitOutcome => {
    const init = initialState();
    const frames: ReplayFrame[] = [{ kind: 'init', label: '初始状态', state: init }];
    const results: EngineActionResult[] = [];
    let state = init;
    let executed = 0;
    let rejected = false;

    for (const [index, action] of actions.entries()) {
      const label = `动作 ${index + 1}：${action.type}`;
      if ((options.rejectActions ?? []).includes(action.type)) {
        const reject = rejectErrorOf();
        const error = {
          code: reject.code,
          ...(reject.detail === undefined ? {} : { detail: reject.detail }),
        };
        results.push({ ok: false, action: action.type, error });
        frames.push({ kind: 'action', label, state, error });
        rejected = true;
        break;
      }
      state = { ...state, steps: state.steps + 1 };
      results.push({ ok: true, action: action.type });
      frames.push({ kind: 'action', label, state });
      executed += 1;
    }

    return {
      verdict: rejected ? 'rejected' : (options.verdict ?? 'incomplete'),
      executed,
      results,
      frames,
      finalState: state,
    };
  };

  const runtime: EngineRuntime = {
    challengeId: pub.id,
    archBits: pub.archBits,
    wordBytes: pub.archBits / 8,
    layout,
    publicPkg: pub,
    privatePkg: priv,
    memory,
    initialState,
    step: notImplemented,
    run: notImplemented,
    evaluate: notImplemented,
    replaySubmit,
    createDebugInstance,
    disassemble: () => [...(options.disasm ?? [])],
    readVisible: notImplemented,
    readVmaVisible: (state, vmaId) => {
      const vma = priv.vmas.find((item) => item.id === vmaId);
      if (vma === undefined) return undefined;
      if (vma.hidden && !state.revealed.includes(vmaId)) return undefined;
      return contents.get(vmaId);
    },
  };

  return { runtime, calls };
}

/** 造一个临时题目目录（不存在时由调用方自己处理）。 */
export function makeChallengeDir(): string {
  return mkdtempSync(join(tmpdir(), 'pwn2block-server-'));
}

export function writeChallenge(dir: string, id: string, pub: unknown, priv: unknown): void {
  const target = join(dir, id);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'public.json'), JSON.stringify(pub), 'utf8');
  writeFileSync(join(target, 'private.json'), JSON.stringify(priv), 'utf8');
}

/** 造一个临时 `presets/` 目录，并写入一份默认编码表（文件形态与仓库里的 preset 一致）。 */
export function makePresetDir(name: string, items: readonly unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'pwn2block-presets-'));
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(items), 'utf8');
  return dir;
}

/** 断言错误响应：HTTP 状态、`ApiErrorSchema` 形状、错误码，以及没有夹带内部信息。 */
export function expectApiError(response: LightMyRequestResponse, code: ApiErrorCode): void {
  expect(response.statusCode).toBe(API_ERROR_STATUS[code]);
  const parsed = ApiErrorSchema.safeParse(response.json());
  expect(parsed.success).toBe(true);
  if (parsed.success) expect(parsed.data.code).toBe(code);

  // 错误响应不含内部堆栈、文件路径或私有包字段（04 §6）。
  expect(response.body).not.toContain(TEST_FLAG_SENTINEL);
  expect(response.body).not.toContain(HIDDEN_KEY_HEX);
  expect(response.body).not.toContain('private.json');
  expect(response.body).not.toContain('at Object.');
}
