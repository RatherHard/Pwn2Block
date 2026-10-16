import { describe, expect, it } from 'vitest';
import { createInitialState } from '../src/env';
import { stepOnce } from '../src/execute';
import { readRegisters, withoutError } from '../src/state';
import { code, setRegisters, testKit } from './helpers/challenge';

/**
 * `state.ts` 两个未覆盖点的契约测试（D5 · BG04 复核）。
 *
 * **必须说清性质：这两处都不是闭环路径能走到的分支。**
 *
 * - `readRegisters`（`state.ts:42-43`）：全仓（engine / server / web / authoring / tests）
 *   **没有任何调用点**，它是一对 `writeRegisters` 的配套导出但目前是死代码。这里不伪造调用方，
 *   只把它对外承诺的契约（保持传入顺序、未声明寄存器回 `0n`）钉成精确断言。
 * - `withoutError`（`state.ts:98-102`）：唯一调用点是 `execute.ts` 的 `judge`，而进入 `judge`
 *   的状态一定满足 `status !== 'failed'`（`stepOnce` 对 `failed` / 已退出先早退），
 *   而**全仓唯一**写 `state.error` 的地方是 `failedState`，它同时把 `status` 置成 `failed`。
 *   因此「带 `error` 但 `status !== 'failed'`」在不变量被破坏前不可达：这是**防御分支**，
 *   不是缺陷。用例的输入取自**真实执行**产生的失败状态（真实取指异常），断言它的精确形状。
 *
 * 报告口径：这两条只把「导出函数的契约」补上，**不**等于闭环路径覆盖了那个不变量；
 * 覆盖率数字上升不代表防御分支的必要性被证明。
 */
describe('state.ts 契约：readRegisters（当前无调用方的导出）', () => {
  it('保持传入顺序，未声明的名字回 0n，值按位宽掩蔽', () => {
    const { env } = testKit({ code: code(0x90) });
    const state = setRegisters(env, createInitialState(env), { RAX: 0x10n, RBX: 0x3n });

    expect(readRegisters(state, ['RAX', 'NOPE', 'RBX'])).toEqual([0x10n, 0n, 0x3n]);
    expect(readRegisters(state, [])).toEqual([]);
  });

  it('32 位题目里读到的就是掩蔽域内的值', () => {
    const { env } = testKit({ archBits: 32, code: code(0x90) });
    const state = setRegisters(env, createInitialState(env), { RAX: 0xffff_ffffn });

    expect(readRegisters(state, ['RAX'])).toEqual([0xffff_ffffn]);
  });
});

describe('state.ts 契约：withoutError（防御分支的唯一入口是直接调用）', () => {
  it('真实取指异常产生的失败状态：清掉 error 只少一个字段，其余字段按引用保留', () => {
    const { env } = testKit({ code: code(0x90), initRegisters: { RIP: '0x9000' } });
    const failed = stepOnce(env, createInitialState(env)).state;

    // 不变量：真实路径里 error 一定伴随 status = failed（所以 judge 拿不到这种状态）。
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('invalid_ip');

    const cleared = withoutError(failed);
    expect('error' in cleared).toBe(false);
    expect(cleared.status).toBe('failed');
    expect(Object.keys(cleared).sort()).toEqual(
      Object.keys(failed)
        .filter((key) => key !== 'error')
        .sort(),
    );
    // 不可变：其余字段不重建（同引用），只有 error 被丢掉。
    expect(cleared.registers).toBe(failed.registers);
    expect(cleared.flags).toBe(failed.flags);
    expect(cleared.lastStop).toStrictEqual({ reason: 'exception', addr: 0x9000n });
  });

  it('本来就干净的状原样返回（同一引用），不产生新对象', () => {
    const { env } = testKit({ code: code(0x90) });
    const clean = createInitialState(env);

    expect('error' in clean).toBe(false);
    expect(withoutError(clean)).toBe(clean);
  });
});
