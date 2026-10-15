import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CreateSessionResponseSchema,
  SessionStateResponseSchema,
  SubmitResponseSchema,
  TEST_FLAG_SENTINEL,
  ret2winPrivate,
  ret2winPublic,
} from '@pwn2block/shared';
import type { ReplayFrameView } from '@pwn2block/shared';
import { buildApp } from '../src/app';

/**
 * 录像帧与提交动作的关联（08 §9.2「录像帧与提交动作关联」，A 定的约定）。
 *
 * 这里刻意**不注入 fake runtime**：走真实引擎 + 真实 HTTP，断言的是 `replaySubmit` 真实产出的帧序列。
 *
 * 核对结论（本文件即为证据）：
 * - `replay.initial` 是第 0 个动作之前的初态；
 * - `results.length` 恒等于 `kind === 'action'` 的帧数；
 * - 按出现顺序第 k 个 `action` 帧的 `label` 等于 `results[k].action`；
 * - `frames[i].index` 是**帧序号**（0 起），不是动作下标；
 * - 被拒绝 / 失败的动作照样占一个 `action` 帧并带 `error`，其后回放终止、不再有帧。
 *
 * **与 A 的约定 #3 / #4 不符的一条**：真实引擎里 `instruction` 帧压在**它自己**的 `action` 帧**之前**
 * （`packages/engine/src/replay.ts` 在动作执行完才 push 动作帧，`afterInstruction` 钩子在执行中先 push 指令帧）。
 * 所以「夹在两个 action 帧之间的 instruction 帧属于前一个 action」是反的：它属于**后一个** action。
 * 08 §9.2 / 04 §5.1 需要按真实行为修订（owner：A），本文件按真实行为断言，不改实现去迁就文档。
 */

const env = { FLAG_RET2WIN: TEST_FLAG_SENTINEL };

/**
 * ret2win + 一个展开成 `step` 的出题人积木 `go`。
 * 参考解法的 `gets` 只展开成 `write_bytes`（不执行指令），拿它测不出「积木触发的指令帧」，
 * 所以测试题目包补一个会执行指令的积木。
 */
const pubWithStepBlock = {
  ...ret2winPublic,
  authorBlocks: [
    ...ret2winPublic.authorBlocks,
    { id: 'go', label: '单步一次', params: [], expand: [{ type: 'step', count: 1 }] },
  ],
};

/** `gets` 溢出 + 覆盖返回地址（默认跳 0x400002 = `syscall win`）。 */
function getsAction(retAddr = '0200400000000000'): Record<string, unknown> {
  return {
    type: 'block',
    id: 'gets',
    args: { data: `${'41'.repeat(16)}${'42'.repeat(8)}${retAddr}` },
  };
}

let app: ReturnType<typeof buildApp>;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'pwn2block-replay-'));
  const challengeRoot = join(workDir, 'challenges');
  const challengeDir = join(challengeRoot, 'ret2win');
  mkdirSync(challengeDir, { recursive: true });
  writeFileSync(join(challengeDir, 'public.json'), JSON.stringify(pubWithStepBlock, null, 2));
  writeFileSync(join(challengeDir, 'private.json'), JSON.stringify(ret2winPrivate, null, 2));

  app = buildApp({ challengeDir: challengeRoot, presetDir: join(workDir, 'presets'), env });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(workDir, { recursive: true, force: true });
});

async function createSession(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sessions',
    payload: { challengeId: 'ret2win' },
  });
  expect(response.statusCode).toBe(200);
  return CreateSessionResponseSchema.parse(response.json()).sessionId;
}

type SubmitBody = ReturnType<typeof SubmitResponseSchema.parse>;

async function submit(actions: readonly unknown[]): Promise<SubmitBody> {
  const sessionId = await createSession();
  const response = await app.inject({
    method: 'POST',
    url: `/api/sessions/${sessionId}/submit`,
    payload: { actions },
  });
  expect(response.statusCode).toBe(200);
  return SubmitResponseSchema.parse(response.json());
}

function actionFrames(frames: readonly ReplayFrameView[]): ReplayFrameView[] {
  return frames.filter((frame) => frame.kind === 'action');
}

function shapeOf(frames: readonly ReplayFrameView[]): string[] {
  return frames.map((frame) => `${frame.kind}:${frame.label}`);
}

describe('录像帧与提交动作的关联（08 §9.2）', () => {
  it('不变式 1 / 2：动作帧数与 results 一一对应，第 k 帧的 label 是第 k 个提交动作的类型', async () => {
    const body = await submit([getsAction(), { type: 'step', count: 3 }]);
    const frames = actionFrames(body.replay.frames);

    expect(body.results.map((item) => item.action)).toEqual(['block', 'step']);
    expect(frames).toHaveLength(body.results.length);
    frames.forEach((frame, k) => {
      expect(frame.label).toBe(body.results[k]?.action);
    });
  });

  it('frames[i].index 是帧序号（0 起），不是动作下标', async () => {
    const body = await submit([getsAction(), { type: 'step', count: 3 }]);
    const frames = body.replay.frames;

    // 帧序号连续，等于数组下标。
    expect(frames.map((frame) => frame.index)).toEqual(frames.map((_, i) => i));
    // 真正的动作帧被指令帧推后：第 2 个动作帧的 index 是 4，不是 1。
    expect(actionFrames(frames).map((frame) => frame.index)).toEqual([0, 4]);
    expect(body.results).toHaveLength(2);
  });

  it('不变式 3：replay.initial 是第 0 个动作之前的初态，没有任何执行痕迹', async () => {
    const body = await submit([getsAction(), { type: 'step', count: 3 }]);
    const sessionId = await createSession();
    const fresh = SessionStateResponseSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` })).json(),
    ).projection;

    expect(body.replay.initial.steps).toBe(0);
    expect(body.replay.initial.status).toBe('ready');
    expect(body.replay.initial).not.toHaveProperty('lastStop');
    expect(body.replay.initial).not.toHaveProperty('error');
    // 与题目初态逐字段一致（包括 roles，04 §4）。
    expect(body.replay.initial.registers).toEqual(fresh.registers);
    expect(body.replay.initial.vmas).toEqual(fresh.vmas);
    expect(body.replay.initial.roles).toEqual(ret2winPrivate.roles);
  });

  it('不变式 4（按真实行为）：积木触发的 instruction 帧紧贴它自己的 action 帧之前', async () => {
    const body = await submit([
      getsAction(),
      { type: 'block', id: 'go', args: {} },
      { type: 'step' },
      { type: 'step' },
    ]);
    const frames = body.replay.frames;

    // 积木原样当一个动作（不展开），它自己执行的那条指令产生紧邻其前的 instruction 帧。
    expect(body.results.map((item) => item.action)).toEqual(['block', 'block', 'step', 'step']);
    expect(shapeOf(frames)).toEqual([
      'action:block',
      'instruction:leave',
      'action:block',
      'instruction:ret',
      'action:step',
      'instruction:syscall win',
      'action:step',
    ]);
    // 每个 instruction 帧后面紧跟的就是产生它的那个 action 帧。
    frames.forEach((frame, i) => {
      if (frame.kind === 'instruction') expect(frames[i + 1]?.kind).toBe('action');
    });
    // 帧序列以 action 帧收尾：不会有悬空的 instruction 帧。
    expect(frames.at(-1)?.kind).toBe('action');
    expect(frames.filter((frame) => frame.kind === 'instruction').map((frame) => frame.steps)).toEqual([
      1, 2, 3,
    ]);
    expect(body.verdict).toBe('won');
  });

  it('不变式 5：被拒绝的动作占一个 action 帧并带 error，其后不再有帧', async () => {
    // 控制类动作在判题实例里被拒（04 §5.1）：前一个合法动作照常占帧，拒绝帧是最后一帧。
    const control = await submit([getsAction(), { type: 'undo' }]);
    expect(control.verdict).toBe('rejected');
    expect(control.results.map((item) => item.ok)).toEqual([true, false]);
    expect(actionFrames(control.replay.frames)).toHaveLength(control.results.length);
    const lastControl = control.replay.frames.at(-1);
    expect(lastControl?.kind).toBe('action');
    expect(lastControl?.label).toBe('undo');
    expect(lastControl?.error?.code).toBe('action_not_allowed');

    // 未允许的动作：唯一的动作帧就是带 error 的拒绝帧。
    const notAllowed = await submit([{ type: 'write_bytes', addr: '0x7fffff00', hex: '41' }]);
    expect(notAllowed.verdict).toBe('rejected');
    expect(shapeOf(notAllowed.replay.frames)).toEqual(['action:write_bytes']);
    expect(notAllowed.replay.frames[0]?.error?.code).toBe('action_not_allowed');

    // 未声明的积木：同样是「一帧 + error」。
    const unknown = await submit([{ type: 'block', id: 'nope', args: {} }]);
    expect(unknown.verdict).toBe('rejected');
    expect(shapeOf(unknown.replay.frames)).toEqual(['action:block']);
    expect(unknown.replay.frames[0]?.error?.code).toBe('unknown_action');
  });

  it('不变式 5（失败路径）：运行期异常的动作帧带 error，且它是最后一帧', async () => {
    // 返回地址改成 0x400004：leave / ret 之后取到未编码的字节，实例进入 failed。
    const body = await submit([getsAction('0400400000000000'), { type: 'step', count: 3 }]);
    const frames = body.replay.frames;

    expect(body.verdict).toBe('failed');
    expect(actionFrames(frames)).toHaveLength(body.results.length);
    // 异常那条指令产生的帧照常出现，随后才是带 error 的动作帧，并且录像到此为止。
    expect(shapeOf(frames)).toEqual([
      'action:block',
      'instruction:leave',
      'instruction:ret',
      'instruction:??',
      'action:step',
    ]);
    const last = frames.at(-1);
    expect(last?.kind).toBe('action');
    expect(last?.label).toBe('step');
    expect(last?.error?.code).toBe('invalid_instruction');
  });
});
