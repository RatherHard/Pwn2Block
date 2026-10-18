/**
 * 会话控制器单测的共用夹具：等待工具、假 API 调用的筛选、开局与「编译」快捷方式。
 *
 * 文件名不是 `*.test.ts`，所以不会被 vitest 收成测试文件。拆出来是为了让
 * `controller.test.ts` 与 `controller-run.test.ts` 共用同一套时序约定，而不是各抄一份。
 */
import type { Action, ActionsResponse } from '@pwn2block/shared';
import type { CompiledAction } from '../src/compiler/types';
import { createSessionController, type SessionController } from '../src/viewmodel/controller';
import {
  createFakeApi,
  createFakeTracker,
  makeArtifact,
  type FakeApi,
  type FakeApiOptions,
  type FakeTracker,
} from './fake-api';
import { makeProjection } from './helpers';

export async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`等待超时：${label}`);
}

export async function flush(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

export interface Harness {
  readonly api: FakeApi;
  readonly tracker: FakeTracker;
  readonly controller: SessionController;
}

export function actionsCalls(api: FakeApi): readonly { readonly actions?: readonly unknown[] }[] {
  return api.calls.filter((call) => call.method === 'actions');
}

export function methods(api: FakeApi): readonly string[] {
  return api.calls.map((call) => call.method);
}

export async function open(options: FakeApiOptions = {}): Promise<Harness> {
  const api = createFakeApi(options);
  const tracker = createFakeTracker();
  const controller = createSessionController({ api: api.client, tracker: tracker.tracker });
  controller.start('ret2win');
  await until(() => controller.state.phase === 'ready', '会话就绪');
  return { api, tracker, controller };
}

/** 让假追踪器产出指定动作，并让控制器发布这份快照（真实路径是 compile 一次）。 */
export function compileInto(
  tracker: FakeTracker,
  controller: SessionController,
  actions: readonly CompiledAction[],
): void {
  tracker.setArtifact(makeArtifact(actions));
  controller.compile({ blocks: [] });
}

export interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}

/** 手动放行的闸门：配合 `api.gate()` 把某一个请求的响应扣住。 */
export function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function isReset(actions: readonly Action[]): boolean {
  return actions.length === 1 && actions[0]?.type === 'reset';
}

/**
 * 只自定义「运行」分片的响应：运行总是先发 `[reset]`，它照常成功，
 * 否则为分片准备的「被拒 / 终止态」响应会让本轮在 reset 之后就停下。
 */
export function respondToChunks(api: FakeApi, respond: (actions: readonly Action[]) => ActionsResponse): void {
  api.setActionsResponse((actions) =>
    isReset(actions)
      ? {
          results: [{ ok: true, action: 'reset' }],
          executed: 1,
          projection: makeProjection(),
          history: { undo: 1, stepBack: 0 },
        }
      : respond(actions),
  );
}

/**
 * 点「运行」并把**第一片**的响应扣住：reset 照常放行，第一片发出后撤掉闸门，
 * 之后的请求不受影响。返回第一片的放行开关。
 */
export async function holdFirstChunk(api: FakeApi, controller: SessionController): Promise<Deferred> {
  const base = actionsCalls(api).length;
  const reset = deferred();
  const chunk = deferred();
  api.gate(reset.promise);
  controller.run({ kind: 'run-all' });
  await until(() => actionsCalls(api).length === base + 1, 'reset 发出');
  api.gate(chunk.promise);
  reset.release();
  await until(() => actionsCalls(api).length === base + 2, '第一片发出');
  api.gate(undefined);
  return chunk;
}
