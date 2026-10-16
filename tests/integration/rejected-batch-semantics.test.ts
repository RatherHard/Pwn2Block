import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@pwn2block/server';
import {
  ActionsResponseSchema,
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  TEST_FLAG_SENTINEL,
  flagEnvVarName,
  type Projection,
} from '@pwn2block/shared';

/**
 * **一批动作里出现拒绝时的粒度**（04 §2 与 §5 的交叉口径）。
 *
 * [04](../../docs/archive/mvp-2026-10-16/04-会话与API.md) §5 写的是「按顺序执行，遇到第一个被拒绝的动作、进入 `failed`
 * 或程序已退出即停止，**后续动作不执行**」，§2 写的是「不满足时**拒绝**，**状态不变**」。
 * 这两句合起来是**动作/积木粒度**的原子性，不是「整个请求回滚」：
 *
 * 1. 被拒绝的那个动作（含它所在的整块 `block`）**逐字段不变**；
 * 2. 它**之前**已经成功的动作**照常生效**（`executed` 就是「实际生效的动作数」，04 §5）；
 * 3. 它**之后**的动作**一律不执行**，哪怕后面那些本来是合法的。
 *
 * 为什么值得单独钉住：`tests/acceptance/s03-request-boundary.test.ts` 的「被拒绝的请求逐字段不变」
 * 用的是**单动作**请求（`actions` 只有一个元素），因此它对上面第 2、3 条**没有断言能力**——
 * 一个「整批回滚」的实现和一个「拒绝后继续跑」的实现都能让那组用例通过。而第 3 条正是前端
 * 512 分片「跨片保持首个拒绝即停」跨片语义的引擎侧对应物（05 §3），第 2 条决定了学习者
 * 在**同一个请求**里先写内存再撞拒绝时，那次成功的写入不会凭空消失。
 *
 * 缺陷 [BG06](../../tests/acceptance/README.md) 修的正是**第 1 条**在 `block` 展开路径上的漏洞
 * （被拒的多动作积木在调试实例上留半截写入）；本文件不重复那条，只补批量粒度。
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const challengeRoot = join(repoRoot, 'challenges');
const presetDir = join(repoRoot, 'presets');

/** 题 1 的目标槽：公开布局里的固定地址（`public.json` 的 `labels`），本题允许 `write_bytes`。 */
const TARGET_SLOT = 0x7fffff08n;
const SLOT_BYTES = 8;

type App = ReturnType<typeof buildApp>;
let app: App;
let sessionId: string;

/**
 * 从公开投影里取任意地址的字节。
 *
 * 偏移量**从投影自身的 `start` 算**，不硬编码段地址：题目换了布局这个文件也不用改，
 * 而硬编码的偏移一旦与实际不符，测试会安静地读到别处。
 */
function bytesAt(projection: Projection, addr: bigint, length: number): string {
  const end = addr + BigInt(length);
  const vma = projection.vmas.find(
    (candidate) =>
      candidate.hex !== undefined &&
      addr >= BigInt(candidate.start) &&
      end <= BigInt(candidate.start) + BigInt(candidate.size),
  );
  if (vma?.hex === undefined) throw new Error(`地址 ${addr.toString(16)} 不在任何公开 VMA 里`);
  const offset = Number(addr - BigInt(vma.start)) * 2;
  return vma.hex.slice(offset, offset + length * 2);
}

/** 角色寄存器（`sp`）的当前值：拒绝类动作不该改动它。 */
function spOf(projection: Projection): string {
  const name = projection.roles.sp;
  const register = projection.registers.find((candidate) => candidate.name === name);
  if (register === undefined) throw new Error(`投影里找不到角色寄存器 ${name}`);
  return register.value;
}

async function sendActions(actions: readonly unknown[]): Promise<ReturnType<typeof ActionsResponseSchema.parse>> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/actions`,
    payload: { actions },
  });
  expect(response.statusCode, response.body).toBe(200);
  return ActionsResponseSchema.parse(response.json());
}

async function readProjection(): Promise<Projection> {
  const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
  expect(response.statusCode).toBe(200);
  return SessionStateResponseSchema.parse(response.json()).projection;
}

beforeAll(async () => {
  app = buildApp({
    challengeDir: challengeRoot,
    presetDir,
    // flag 真值只从环境变量注入（06 §6）：这里用测试哨兵，不写进仓库。
    env: { [flagEnvVarName('endian')]: TEST_FLAG_SENTINEL },
  });
  await app.ready();

  const created = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: 'endian' },
  });
  expect(created.statusCode).toBe(200);
  sessionId = CreateSessionResponseSchema.parse(created.json()).sessionId;
});

afterAll(async () => {
  if (app !== undefined) await app.close();
});

describe('一批动作里的拒绝：动作粒度原子，不是整批回滚（04 §2 / §5）', () => {
  it('成功动作在前、被拒动作在后：前面的照常生效，`executed` 只数生效的', async () => {
    const baseline = await readProjection();
    expect(bytesAt(baseline, TARGET_SLOT, SLOT_BYTES)).toBe('0000000000000000');
    const spBefore = spOf(baseline);

    // `pop` 不在题 1 的允许动作集里（`allowedActions` 没有它）→ 引擎级 `action_not_allowed`。
    const response = await sendActions([
      { type: 'write_bytes', addr: '0x7fffff08', hex: '41' },
      { type: 'pop' },
    ]);

    expect(response.executed, '只有第一条生效').toBe(1);
    expect(response.results).toHaveLength(2);
    expect(response.results[0]).toMatchObject({ ok: true, action: 'write_bytes' });
    expect(response.results[1]).toMatchObject({ ok: false, action: 'pop' });
    expect(response.results[1]?.error?.code).toBe('action_not_allowed');

    // 第 2 条：前面那次成功的写入必须留下（不是整批回滚）。
    expect(bytesAt(response.projection, TARGET_SLOT, SLOT_BYTES)).toBe('4100000000000000');
    // 第 1 条：被拒的动作自己没有改动状态（`pop` 不推栈指针）。
    expect(spOf(response.projection), '被拒的 pop 不该动 sp').toBe(spBefore);
    // 拒绝计入 `failures`（04 §4），且响应里的投影与后续 GET 一致。
    expect(response.projection.failures).toBe(baseline.failures + 1);
    expect(bytesAt(await readProjection(), TARGET_SLOT, SLOT_BYTES)).toBe('4100000000000000');
  });

  it('被拒动作在前、合法动作在后：后面的一律不执行，内存保持不变', async () => {
    const before = await readProjection();
    const spBefore = spOf(before);

    const response = await sendActions([
      { type: 'pop' },
      { type: 'write_bytes', addr: '0x7fffff08', hex: '42' },
    ]);

    // 第 3 条：遇到第一个拒绝就停，后面的合法动作也不执行（04 §5）。
    expect(response.executed).toBe(0);
    expect(response.results, '只回第一个动作的结果').toHaveLength(1);
    expect(response.results[0]).toMatchObject({ ok: false, action: 'pop' });
    expect(response.results[0]?.error?.code).toBe('action_not_allowed');

    // 42 一次都不该出现；上一次成功的 41 仍然在。
    expect(bytesAt(response.projection, TARGET_SLOT, SLOT_BYTES)).toBe('4100000000000000');
    expect(spOf(response.projection)).toBe(spBefore);
    expect(response.projection.failures).toBe(before.failures + 1);
    expect(bytesAt(await readProjection(), TARGET_SLOT, SLOT_BYTES)).toBe('4100000000000000');
  });

  it('回退类动作没有被这批拒绝拖垮：`undo` 仍能把那次成功的写入退掉（04 §2）', async () => {
    const before = await readProjection();

    const response = await sendActions([{ type: 'undo' }]);

    expect(response.executed).toBe(1);
    expect(response.results[0]).toMatchObject({ ok: true, action: 'undo' });
    expect(bytesAt(response.projection, TARGET_SLOT, SLOT_BYTES), '回到全零').toBe('0000000000000000');
    // 回退自身不计 `failures`（04 §4）。
    expect(response.projection.failures).toBe(before.failures);
  });
});
