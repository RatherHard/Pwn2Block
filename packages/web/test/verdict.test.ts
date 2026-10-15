import { describe, expect, it } from 'vitest';
import { verdictModel } from '../src/viewmodel/verdict';
import { makeReplay, makeSubmitResponse } from './fake-api';

const ORIGINS = [
  { index: 0, blockId: 'b0' },
  { index: 1, blockId: 'b1' },
] as const;

describe('判题结论（05 §6 四种结论）', () => {
  it('通过：给出 flag 副本与通过横幅', () => {
    const response = makeSubmitResponse('won', {
      flag: 'flag{demo}',
      executed: 2,
      results: [
        { ok: true, action: 'block' },
        { ok: true, action: 'step' },
      ],
      replay: makeReplay([{ kind: 'action' }, { kind: 'action' }]),
    });
    const model = verdictModel({ response });
    expect(model.title).toBe('通过');
    expect(model.tone).toBe('ok');
    expect(model.flag).toBe('flag{demo}');
    expect(model.attempted).toBe(2);
    expect(model.executed).toBe(2);
    expect(model.emphasizeIncomplete).toBe(false);
  });

  it('通过但服务端没给 flag：不编造，也不说已通过得含糊', () => {
    const model = verdictModel({ response: makeSubmitResponse('won') });
    expect(model.flag).toBeUndefined();
    expect(model.detail).toContain('没有下发 flag');
  });

  it('编码不足：强调“跑完了但没达成目标，不是写错了”（05 §6）', () => {
    const model = verdictModel({
      response: makeSubmitResponse('incomplete', { replay: makeReplay([{ kind: 'action' }]) }),
    });
    expect(model.title).toBe('payload 跑完了，但没有达成目标');
    expect(model.emphasizeIncomplete).toBe(true);
    expect(model.tone).toBe('warn');
    expect(model.flag).toBeUndefined();
  });

  it('运行失败：显示命中的失败条件与出错动作，默认停在出事那一帧（09 §3.4 归属规则）', () => {
    const replay = makeReplay([
      { kind: 'action', label: 'write_bytes', status: 'ready' },
      { kind: 'instruction', label: 'leave' },
      { kind: 'instruction', label: 'ret' },
      {
        kind: 'action',
        label: 'step',
        status: 'failed',
        error: { code: 'invalid_ip', message: '指令指针落在不可执行或未映射的地址', note: '看看 ret 弹到哪去' },
      },
    ]);
    const model = verdictModel({ response: makeSubmitResponse('failed', { replay, executed: 2 }) });
    expect(model.title).toBe('运行失败');
    expect(model.tone).toBe('error');
    expect(model.failure?.message).toContain('指令指针');
    expect(model.failure?.note).toContain('ret');
    // 出事时正在执行的是第 2 个动作：中间那两条 instruction 属于它，不是第 1 个。
    expect(model.failure?.actionIndex).toBe(1);
    expect(model.failure?.frameLabel).toBe('step');
    expect(model.defaultPosition).toBe(4);
    expect(model.detail).toContain('第 2 个动作');
    expect(model.detail).toContain('命中的失败条件');
  });

  it('失败条件命中但那一帧不带 error：按归属规则说清是哪个动作执行期间', () => {
    const replay = makeReplay([
      { kind: 'action', label: 'block gets' },
      { kind: 'instruction', label: 'syscall win' },
      { kind: 'action', label: 'step', status: 'failed' },
    ]);
    const model = verdictModel({ response: makeSubmitResponse('failed', { replay }) });
    expect(model.defaultPosition).toBe(3);
    expect(model.failure?.actionIndex).toBe(1);
    expect(model.failure?.message).toContain('第 2 个动作执行期间');
  });

  it('被拒绝：说清是哪个动作被拒、为什么，并定位到积木（09 §3.4）', () => {
    const replay = makeReplay([{ kind: 'action' }, { kind: 'action' }]);
    const response = makeSubmitResponse('rejected', {
      replay,
      executed: 1,
      results: [
        { ok: true, action: 'write_bytes' },
        {
          ok: false,
          action: 'push',
          error: { code: 'hidden_address', message: '目标落在隐藏区域', note: '换个地址写' },
        },
      ],
    });
    const model = verdictModel({ response, origins: ORIGINS });
    expect(model.title).toBe('动作被拒绝');
    expect(model.tone).toBe('error');
    expect(model.rejected).toEqual({
      actionIndex: 1,
      action: 'push',
      blockId: 'b1',
      position: 2,
      message: '目标落在隐藏区域',
      note: '换个地址写',
      code: 'hidden_address',
    });
    expect(model.defaultPosition).toBe(2);
    expect(model.attempted).toBe(2);
    expect(model.executed).toBe(1);
  });

  it('被拒绝但没有来源表：仍然说清动作与原因，只是不定位积木', () => {
    const response = makeSubmitResponse('rejected', {
      results: [{ ok: false, action: 'pop', error: { code: 'empty_history', message: '栈是空的' } }],
    });
    const model = verdictModel({ response });
    expect(model.rejected?.blockId).toBeUndefined();
    expect(model.rejected?.actionIndex).toBe(0);
  });

  it('结果里没有拒绝项时不硬凑：结论只讲状态与失败条件', () => {
    const replay = makeReplay([{ kind: 'action', status: 'failed', error: { code: 'resource_limit', message: '指令数超上限' } }]);
    const model = verdictModel({ response: makeSubmitResponse('rejected', { replay }) });
    expect(model.rejected).toBeUndefined();
    expect(model.failure?.message).toContain('指令数超上限');
  });
});
