import type { ArchBits, MemoryApi, MemoryState, VmaInit } from '@pwn2block/shared';
import { describe, expect, it } from 'vitest';
import { createDebugInstance } from '../src/instance';
import { createMemory } from '../src/memory/index';
import type { EngineEnv } from '../src/env';
import { code, testKit } from './helpers/challenge';
import { createFakeMemory, memoryHex } from './helpers/fake-memory';

/**
 * 零长度访问与动作层口径（D5 · BG04 复核时实测钉住）。
 *
 * 两件事必须分开看：
 *
 * 1. **内存层**（02 §3、09 §7 第 8 条）：`len === 0` 不触碰任何字节、**不做地址与权限判定**，
 *    一律通过。真实实现是 `src/memory/vma.ts` 的 `planAccess`（`len === 0` 在掩蔽地址之后
 *    直接 `return { ok: true, addr, segments: [] }`）。测试替身必须同语义，否则引擎测试会看到
 *    真实实现里根本不存在的结果。
 * 2. **动作层**（04 §2）：`write_bytes` 的 `hex === ''`（零字节区间）是**真正的空操作**——
 *    不做地址、权限、隐藏判定，一律通过且不触碰任何字节；仍算一次生效动作。
 *    零字节写**非空**时的判定一个字都没变（隐藏 → `hidden_address`，未映射 / 只读 / 跨区 →
 *    `inaccessible_address`），本文件最后一条用例就是这条边界的守门人。
 *
 * 这条动作层口径是 D5 复核后由 A 判定的：`09` §7 第 8 条原本只把「零长度不构成探测」限定在
 * 内存层，动作层没人对过账，于是长成了「未映射/只读拒、隐藏过」的混合体——文档说不构成探测、
 * 代码却在构成探测。统一到「一律放行」是把特例消掉，而不是再加一条「按隐藏判定」的规则
 * （后者只是换一批地址被拒，仍然是探测）。安全上两种选择都不改变结论：零长度既不读也不写内容，
 * 既不可能违反「隐藏即不下发」，也不构成越权。
 *
 * 为什么值得钉：浏览器编译器会产出 `hex: ''` 的 `write_bytes`（空字节块，
 * 见 `packages/web/src/compiler/author-blocks.test.ts`），所以这是闭环真实可达的请求形状。
 */

/** 真实内存与测试替身跑同一批操作，结果必须逐字段一致。 */
function bothMemories(env: EngineEnv): {
  real: { api: MemoryApi; state: MemoryState };
  fake: { api: MemoryApi; state: MemoryState };
} {
  const vmas: readonly VmaInit[] = env.vmas;
  const archBits: ArchBits = env.archBits;
  return {
    real: { api: createMemory, state: createMemory.create(vmas, archBits) },
    fake: { api: createFakeMemory(), state: createFakeMemory().create(vmas, archBits) },
  };
}

const EMPTY = new Uint8Array(0);

describe('零长度访问：真实内存与测试替身必须同语义（02 §3、09 §7 第 8 条）', () => {
  function fixtures(): ReturnType<typeof bothMemories> {
    const { env } = testKit({ code: code(0x90, 0x90) });
    return bothMemories(env);
  }

  it('write 零字节：任意地址（隐藏 / 未映射 / 只读 / 不可写代码段）都通过且不落笔', () => {
    const { real, fake } = fixtures();
    // 0x4000 隐藏可写、0x9000 未映射、0x5000 只读、0x1000 可执行但不可写。
    const addrs = [0x4000n, 0x9000n, 0x5000n, 0x1000n, 0x2000n];

    const realResults = addrs.map((addr) => real.api.write(real.state, addr, EMPTY));
    const fakeResults = addrs.map((addr) => fake.api.write(fake.state, addr, EMPTY));

    expect(realResults).toStrictEqual(addrs.map(() => ({ ok: true, bytes: EMPTY })));
    expect(fakeResults).toStrictEqual(realResults);
  });

  it('read / check / copy 的零长度同样通过，且不区分地址与权限', () => {
    const { real, fake } = fixtures();

    for (const addr of [0x9000n, 0x5000n, 0x4000n]) {
      expect(real.api.check(real.state, addr, 0, 'w')).toStrictEqual({ ok: true });
      expect(fake.api.check(fake.state, addr, 0, 'w')).toStrictEqual({ ok: true });
      expect(real.api.read(real.state, addr, 0)).toStrictEqual({ ok: true, bytes: EMPTY });
      expect(fake.api.read(fake.state, addr, 0)).toStrictEqual({ ok: true, bytes: EMPTY });
      expect(real.api.copy(real.state, addr, addr, 0)).toStrictEqual({ ok: true, bytes: EMPTY });
      expect(fake.api.copy(fake.state, addr, addr, 0)).toStrictEqual({ ok: true, bytes: EMPTY });
    }
  });

  it('跨相邻 VMA 的整段访问按片段处理（取指跨代码区末尾、栈顶写进相邻区）', () => {
    const { real, fake } = fixtures();
    const eight = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);

    // 0x1ffa 起 8 字节：代码区 6 字节 + 数据区 2 字节，两段都可读。
    expect(real.api.read(real.state, 0x1ffan, 8)).toStrictEqual({ ok: true, bytes: new Uint8Array(8) });
    expect(fake.api.read(fake.state, 0x1ffan, 8)).toStrictEqual(real.api.read(real.state, 0x1ffan, 8));

    // 同一段地址写 8 字节：第一段是 `rx` 代码区 → permission；整段失败且无副作用。
    expect(fake.api.write(fake.state, 0x1ffan, eight)).toStrictEqual(
      real.api.write(real.state, 0x1ffan, eight),
    );
    expect(real.api.write(real.state, 0x1ffan, eight)).toStrictEqual({
      ok: false,
      reason: 'permission',
      addr: 0x1ffan,
      len: 8,
    });
    expect(real.api.read(real.state, 0x2000n, 2)).toStrictEqual({ ok: true, bytes: new Uint8Array(2) });
    expect(fake.api.read(fake.state, 0x2000n, 2)).toStrictEqual({ ok: true, bytes: new Uint8Array(2) });

    // 0x3ffc 起 8 字节：栈区 4 字节 + 隐藏区 4 字节（内存层不因 hidden 拒绝，02 §3）。
    expect(fake.api.write(fake.state, 0x3ffcn, eight)).toStrictEqual(
      real.api.write(real.state, 0x3ffcn, eight),
    );
    expect(real.api.write(real.state, 0x3ffcn, eight)).toStrictEqual({ ok: true, bytes: eight });
    expect(fake.api.read(fake.state, 0x3ffcn, 8)).toStrictEqual(real.api.read(real.state, 0x3ffcn, 8));
    expect(real.api.read(real.state, 0x3ffcn, 8)).toStrictEqual({ ok: true, bytes: eight });

    // 跨区但权限不足 / 越过最后一个区：两边同样是 permission / unmapped。
    const two = Uint8Array.from([1, 2]);
    expect(fake.api.write(fake.state, 0x4fffn, two)).toStrictEqual(real.api.write(real.state, 0x4fffn, two));
    expect(real.api.write(real.state, 0x4fffn, two)).toStrictEqual({
      ok: false,
      reason: 'permission',
      addr: 0x4fffn,
      len: 2,
    });
    expect(fake.api.read(fake.state, 0x5ffen, 4)).toStrictEqual(real.api.read(real.state, 0x5ffen, 4));
    expect(real.api.read(real.state, 0x5ffen, 4)).toStrictEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x5ffen,
      len: 4,
    });
  });

  it('非零长度仍然逐字节校验：未映射 → unmapped，只读区写 → permission 两边一致', () => {
    const { real, fake } = fixtures();
    const one = Uint8Array.from([0x41]);

    expect(real.api.write(real.state, 0x9000n, one)).toStrictEqual({
      ok: false,
      reason: 'unmapped',
      addr: 0x9000n,
      len: 1,
    });
    expect(fake.api.write(fake.state, 0x9000n, one)).toStrictEqual(
      real.api.write(real.state, 0x9000n, one),
    );
    expect(fake.api.write(fake.state, 0x5000n, one)).toStrictEqual(
      real.api.write(real.state, 0x5000n, one),
    );
    // 内存层不认识 hidden：隐藏区对程序就是普通可写区（02 §3）。
    expect(real.api.check(real.state, 0x4000n, 1, 'w')).toStrictEqual({ ok: true });
    expect(fake.api.check(fake.state, 0x4000n, 1, 'w')).toStrictEqual({ ok: true });
  });
});

/**
 * 逐条对照表：真实内存 `src/memory/vma.ts` 的每条分支 ↔ 替身对应实现 ↔ 钉住它的用例。
 *
 * | 真实 `planAccess` 分支 | 替身 `planAccess` | 用例 |
 * |---|---|---|
 * | `len` 非法 → `RangeError` | 无（替身不接收非法长度） | 真实侧由 `src/memory/memory.test.ts` 钉住 |
 * | `len === 0` → 放行，`segments: []` | 同 | `write 零字节…`、`read / check / copy 的零长度…`、差分 `len0-*` |
 * | `addr` 按位宽掩蔽 | 同（`rawAddr & state.mask`） | 差分 `mask-*` |
 * | `end > mask + 1` → `unmapped` | 同 | 差分 `overflow-end` |
 * | 空洞 → `unmapped` | 同（`regionAtOrAfter` 返回 `undefined` 或 `start > pos`） | 差分 `hole-*` |
 * | 命中但缺权限 → `permission` | 同（`hasPerm`） | 差分 `perm-*` |
 * | 跨相邻 VMA → 切成多段 | 同（循环推进 `pos`） | `跨相邻 VMA…`、差分 `cross-*` |
 * | `hidden` 不参与判定 | 同（替身根本不读 `hidden`） | 差分 `hidden-*` |
 * | `write` / `copy` 整段先校验再生效 | 同（`scatterSegments` 在 `planAccess` 之后） | `跨相邻 VMA…` 的 permission 分支 + 读回全 0 |
 * | `copy` 重叠 = memmove | 同（先 `gather` 再 `scatter`） | 差分 `copy-overlap` |
 */
describe('内存替身可信度：与真实 `createMemory` 逐场景差分（同一组操作，结果逐字段相等）', () => {
  /** 一次操作：对给定的 api + state 跑同一个请求，返回原始结果对象。 */
  type Op = (api: MemoryApi, state: MemoryState) => unknown;

  const B = Uint8Array.from([1, 2, 3, 4]);

  const scenarios: readonly { readonly name: string; readonly run: Op; readonly expected: unknown }[] = [
    { name: 'len0-write-hidden', run: (a, s) => a.write(s, 0x4000n, EMPTY), expected: { ok: true, bytes: EMPTY } },
    { name: 'len0-write-hole', run: (a, s) => a.write(s, 0x9000n, EMPTY), expected: { ok: true, bytes: EMPTY } },
    { name: 'len0-write-rodata', run: (a, s) => a.write(s, 0x5000n, EMPTY), expected: { ok: true, bytes: EMPTY } },
    { name: 'len0-read-hole', run: (a, s) => a.read(s, 0x9000n, 0), expected: { ok: true, bytes: EMPTY } },
    { name: 'len0-check-x-hole', run: (a, s) => a.check(s, 0x9000n, 0, 'x'), expected: { ok: true } },
    {
      name: 'len0-copy-hole-to-hole',
      run: (a, s) => a.copy(s, 0x9000n, 0x8000n, 0),
      expected: { ok: true, bytes: EMPTY },
    },
    {
      name: 'mask-bit64-dropped',
      run: (a, s) => a.write(s, 0x1_0000_0000_0000_0000n, B),
      expected: { ok: false, reason: 'unmapped', addr: 0x0n, len: 4 },
    },
    {
      name: 'overflow-end',
      run: (a, s) => a.read(s, 0xffff_ffff_ffff_fffcn, 8),
      expected: { ok: false, reason: 'unmapped', addr: 0xffff_ffff_ffff_fffcn, len: 8 },
    },
    {
      name: 'hole-single-byte',
      run: (a, s) => a.read(s, 0x9000n, 1),
      expected: { ok: false, reason: 'unmapped', addr: 0x9000n, len: 1 },
    },
    {
      name: 'perm-write-rodata',
      run: (a, s) => a.write(s, 0x5000n, B),
      expected: { ok: false, reason: 'permission', addr: 0x5000n, len: 4 },
    },
    {
      name: 'perm-fetch-rw',
      run: (a, s) => a.check(s, 0x2000n, 1, 'x'),
      expected: { ok: false, reason: 'permission', addr: 0x2000n, len: 1 },
    },
    {
      name: 'hidden-fetch-is-permission-not-hidden',
      run: (a, s) => a.check(s, 0x4000n, 1, 'x'),
      expected: { ok: false, reason: 'permission', addr: 0x4000n, len: 1 },
    },
    {
      name: 'hidden-write-ok',
      run: (a, s) => a.write(s, 0x4000n, B),
      expected: { ok: true, bytes: B },
    },
    { name: 'cross-read-code-data', run: (a, s) => a.read(s, 0x1ffan, 8), expected: { ok: true, bytes: new Uint8Array(8) } },
    {
      name: 'cross-write-code-data-permission',
      run: (a, s) => a.write(s, 0x1ffan, B),
      expected: { ok: false, reason: 'permission', addr: 0x1ffan, len: 4 },
    },
    {
      name: 'cross-write-stack-hidden',
      run: (a, s) => a.write(s, 0x3ffcn, B),
      expected: { ok: true, bytes: B },
    },
    {
      name: 'cross-write-hidden-rodata-permission',
      run: (a, s) => a.write(s, 0x4fffn, Uint8Array.from([1, 2])),
      expected: { ok: false, reason: 'permission', addr: 0x4fffn, len: 2 },
    },
    {
      name: 'copy-overlap-memmove',
      run: (a, s) => {
        const written = a.write(s, 0x2000n, B);
        const copied = a.copy(s, 0x2000n, 0x2001n, 4);
        const back = a.read(s, 0x2000n, 5);
        return [written, copied, back];
      },
      expected: [
        { ok: true, bytes: B },
        { ok: true, bytes: B },
        { ok: true, bytes: Uint8Array.from([1, 1, 2, 3, 4]) },
      ],
    },
  ];

  it.each(scenarios)('$name：真实与替身逐字段相等，且等于登记的期望值', (scenario) => {
    const real = bothMemories(testKit({ code: code(0x90, 0x90) }).env).real;
    const fake = bothMemories(testKit({ code: code(0x90, 0x90) }).env).fake;

    const realResult = scenario.run(real.api, real.state);
    const fakeResult = scenario.run(fake.api, fake.state);

    expect(realResult).toStrictEqual(scenario.expected);
    expect(fakeResult).toStrictEqual(realResult);
  });
});

describe('零长度写原语在动作层的实测口径（04 §2）', () => {
  function start(): { env: EngineEnv; instance: ReturnType<typeof createDebugInstance> } {
    const kit = testKit({ code: code(0x90, 0x90) });
    return { env: kit.env, instance: createDebugInstance(kit.env) };
  }

  it('零字节写隐藏可写区：通过、不触碰内容，并算一次生效动作', () => {
    const { env, instance } = start();
    const outcome = instance.applyRequest([{ type: 'write_bytes', addr: '0x4000', hex: '' }]);

    expect(outcome.results).toStrictEqual([{ ok: true, action: 'write_bytes' }]);
    expect(outcome.executed).toBe(1);
    expect(outcome.failures).toBe(0);
    // 零字节 = 没有任何字节落笔：隐藏区初值原样。
    expect(memoryHex(env.memory, outcome.state.memory, 0x4000n, 2)).toBe('aabb');
    expect(instance.historyDepth()).toStrictEqual({ undo: 1, stepBack: 0 });
  });

  it('零字节写未映射区 / 只读区 / 越界地址：一律通过（不再做地址与权限判定）', () => {
    // 09 §7 第 8 条对账后统一到内存层规则：零长度不做任何地址判定，因此未映射、只读、
    // 隐藏、越界地址全都是「通过但不触碰字节」。改动前的口径是「未映射/只读拒、隐藏过」，
    // 那等于用动作层回答「这个地址是否已映射/可写」——正是该条说不该成为探测的事。
    const { env, instance } = start();
    const dataBefore = memoryHex(env.memory, instance.state().memory, 0x2000n, 2);
    const rodataBefore = memoryHex(env.memory, instance.state().memory, 0x5000n, 2);

    for (const addr of ['0x9000', '0x5000', '0x4000', '0xffffffffffffffff']) {
      const outcome = instance.applyRequest([{ type: 'write_bytes', addr, hex: '' }]);
      expect(outcome.results).toStrictEqual([{ ok: true, action: 'write_bytes' }]);
      expect(outcome.executed).toBe(1);
      expect(outcome.failures).toBe(0);
    }

    // 五个地址都不许落笔：可见区、只读区、隐藏区、未映射区内容逐字节不变。
    expect(memoryHex(env.memory, instance.state().memory, 0x2000n, 2)).toBe(dataBefore);
    expect(memoryHex(env.memory, instance.state().memory, 0x5000n, 2)).toBe(rodataBefore);
    expect(memoryHex(env.memory, instance.state().memory, 0x4000n, 2)).toBe('aabb');
    expect(instance.historyDepth()).toStrictEqual({ undo: 4, stepBack: 0 });
    expect(instance.failures()).toBe(0);
  });

  it('非空 write_bytes 的拒绝口径一个字都没变（隐藏 / 未映射 / 只读 / 跨区）', () => {
    // 这条是「只有零长度放行」的守门用例：如果零长度特例被误写成「整段跳过判定」，
    // 下面四条会立刻变红。
    const { env, instance } = start();
    const dataBefore = memoryHex(env.memory, instance.state().memory, 0x2000n, 2);

    const hidden = instance.applyRequest([{ type: 'write_bytes', addr: '0x4000', hex: 'ff' }]);
    expect(hidden.results[0]?.ok).toBe(false);
    expect(hidden.results[0]?.error?.code).toBe('hidden_address');
    expect(hidden.executed).toBe(0);
    expect(hidden.failures).toBe(1);
    expect(instance.historyDepth()).toStrictEqual({ undo: 0, stepBack: 0 });

    const unmapped = instance.applyRequest([{ type: 'write_bytes', addr: '0x9000', hex: 'ff' }]);
    expect(unmapped.results[0]?.ok).toBe(false);
    expect(unmapped.results[0]?.error?.code).toBe('inaccessible_address');
    expect(unmapped.executed).toBe(0);
    expect(unmapped.failures).toBe(2);

    const rodata = instance.applyRequest([{ type: 'write_bytes', addr: '0x5000', hex: 'ff' }]);
    expect(rodata.results[0]?.ok).toBe(false);
    expect(rodata.results[0]?.error?.code).toBe('inaccessible_address');
    expect(rodata.executed).toBe(0);
    expect(rodata.failures).toBe(3);

    // 跨出可写区（数据区末字节起 2 字节，压到栈区之外的空洞）也算 inaccessible_address。
    const crossing = instance.applyRequest([{ type: 'write_bytes', addr: '0x2fff', hex: 'ffff' }]);
    expect(crossing.results[0]?.ok).toBe(false);
    expect(crossing.results[0]?.error?.code).toBe('inaccessible_address');
    expect(crossing.executed).toBe(0);
    expect(crossing.failures).toBe(4);

    expect(instance.historyDepth()).toStrictEqual({ undo: 0, stepBack: 0 });
    expect(memoryHex(env.memory, instance.state().memory, 0x2000n, 2)).toBe(dataBefore);
    expect(memoryHex(env.memory, instance.state().memory, 0x4000n, 2)).toBe('aabb');
  });

  it('零字节写可见可写区：通过、内容不变；空 feed 也不追加 stdin', () => {
    const { env, instance } = start();

    const wrote = instance.applyRequest([{ type: 'write_bytes', addr: '0x2000', hex: '' }]);
    expect(wrote.results).toStrictEqual([{ ok: true, action: 'write_bytes' }]);
    expect(wrote.executed).toBe(1);
    expect(memoryHex(env.memory, wrote.state.memory, 0x2000n, 4)).toBe('00000000');

    const fed = instance.applyRequest([{ type: 'feed', hex: '' }]);
    expect(fed.results).toStrictEqual([{ ok: true, action: 'feed' }]);
    expect(fed.executed).toBe(1);
    expect(Array.from(fed.state.stdin.bytes)).toEqual([]);
    expect(fed.state.stdin.pos).toBe(0);
    expect(instance.failures()).toBe(0);
  });
});
