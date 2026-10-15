import { describe, expect, it } from 'vitest';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { buttonModel, disabledReasons, runMenuModel, type RunMenuInput } from '../src/viewmodel/toolbar';
import { makeArtifact, repeatedActions } from './fake-api';

const ACTIONS = [{ type: 'ret' }, { type: 'ret' }] as const;
const CHALLENGE_ACTIONS = ['write_bytes', 'push', 'pop', 'call', 'ret', 'step', 'run'] as const;

function input(overrides: Partial<RunMenuInput> = {}): RunMenuInput {
  return {
    mode: 'debug',
    hasSession: true,
    sessionExpired: false,
    artifact: makeArtifact(ACTIONS),
    stale: false,
    compileErrorCount: 0,
    history: { undo: 0, stepBack: 0 },
    cursor: 0,
    allowedActions: CHALLENGE_ACTIONS,
    ...overrides,
  };
}

describe('运行菜单的可用性与禁用原因（05 §1、§3、§6）', () => {
  it('会话就绪且产物新鲜时，八个按钮都可用', () => {
    const model = runMenuModel(input({ history: { undo: 1, stepBack: 3 } }));
    expect(model.map((button) => button.id)).toEqual([
      'compile',
      'trial-run',
      'step',
      'run-n',
      'step-back',
      'undo',
      'reset',
      'submit',
    ]);
    expect(disabledReasons(model)).toEqual([]);
  });

  it('没有会话时全部禁用，并说明原因', () => {
    const model = runMenuModel(input({ hasSession: false }));
    expect(model.every((button) => !button.enabled)).toBe(true);
    expect(buttonModel(model, 'step')?.disabledReason).toContain('先在上面选一道题');
  });

  it('会话失效时全部禁用，并指向「重新开始」', () => {
    const model = runMenuModel(input({ sessionExpired: true }));
    expect(buttonModel(model, 'submit')?.enabled).toBe(false);
    expect(buttonModel(model, 'submit')?.disabledReason).toContain('重新开始');
  });

  it('产物过期（stale）时禁止试运行与提交，并提示重新编译', () => {
    const model = runMenuModel(input({ stale: true }));
    for (const id of ['trial-run', 'step', 'submit'] as const) {
      expect(buttonModel(model, id)?.enabled).toBe(false);
      expect(buttonModel(model, id)?.disabledReason).toBe(MESSAGE_STALE);
    }
    // 编译与回退类不受影响。
    expect(buttonModel(model, 'compile')?.enabled).toBe(true);
    expect(buttonModel(model, 'reset')?.enabled).toBe(true);
  });

  it('从未编译 vs 编译失败给出不同原因', () => {
    const never = runMenuModel(input({ artifact: undefined, compileErrorCount: 0 }));
    expect(buttonModel(never, 'step')?.disabledReason).toContain('还没有编译产物');
    const failed = runMenuModel(input({ artifact: undefined, compileErrorCount: 2 }));
    expect(buttonModel(failed, 'step')?.disabledReason).toContain('编译失败');
  });

  it('回退按钮在无可退时禁用，并区分「历史为空」与「已退到指令窗口之外」', () => {
    const empty = runMenuModel(input({ history: { undo: 0, stepBack: 0 } }));
    expect(buttonModel(empty, 'step-back')?.disabledReason).toBe('历史为空，没有可回退的指令');
    expect(buttonModel(empty, 'undo')?.disabledReason).toBe('历史为空，没有可撤销的提交');

    const outsideWindow = runMenuModel(input({ history: { undo: 2, stepBack: 0 } }));
    expect(buttonModel(outsideWindow, 'step-back')?.disabledReason).toContain('64 条指令窗口之外');
    expect(buttonModel(outsideWindow, 'undo')?.enabled).toBe(true);
  });

  it('程序区动作已用完时，退化提交 run / step 也要看 allowedActions（05 §3）', () => {
    const exhausted = { artifact: makeArtifact(ACTIONS), cursor: 2 };
    const allowed = runMenuModel(input(exhausted));
    expect(buttonModel(allowed, 'trial-run')?.enabled).toBe(true);
    expect(buttonModel(allowed, 'step')?.enabled).toBe(true);

    const notAllowed = runMenuModel(
      input({ ...exhausted, allowedActions: ['write_bytes', 'push', 'ret'] }),
    );
    expect(buttonModel(notAllowed, 'trial-run')?.disabledReason).toContain('不允许 run');
    expect(buttonModel(notAllowed, 'step')?.disabledReason).toContain('不允许 step');
  });

  it('本题不允许 step 时「运行 N 步」禁用', () => {
    const model = runMenuModel(input({ allowedActions: ['ret'] }));
    expect(buttonModel(model, 'run-n')?.enabled).toBe(false);
    expect(buttonModel(model, 'run-n')?.disabledReason).toContain('不允许 step');
  });

  it('空程序不允许提交（服务端请求体至少一个动作）', () => {
    const model = runMenuModel(input({ artifact: makeArtifact([]) }));
    expect(buttonModel(model, 'submit')?.disabledReason).toContain('没有动作');
    // 试运行仍然可用：序列用完会退化成 run（05 §3）。
    expect(buttonModel(model, 'trial-run')?.enabled).toBe(true);
  });

  it('判题结果模式下前七个按钮禁用但「提交判题」保持可用（提交不限次数）', () => {
    const model = runMenuModel(input({ mode: 'verdict' }));
    for (const id of ['trial-run', 'step', 'run-n', 'step-back', 'undo', 'reset'] as const) {
      expect(buttonModel(model, id)?.enabled).toBe(false);
      expect(buttonModel(model, id)?.disabledReason).toContain('回到调试');
    }
    expect(buttonModel(model, 'compile')?.enabled).toBe(true);
    expect(buttonModel(model, 'submit')?.enabled).toBe(true);
  });

  it('禁用原因清单是纯文本，不依赖颜色（05 §7）', () => {
    const reasons = disabledReasons(runMenuModel(input({ history: { undo: 0, stepBack: 0 } })));
    expect(reasons.some((text) => text.startsWith('撤销：'))).toBe(true);
    expect(reasons.some((text) => text.startsWith('后退一步：'))).toBe(true);
  });

  it('大程序（600 个动作）不影响按钮可用性判定', () => {
    const model = runMenuModel(
      input({ artifact: makeArtifact(repeatedActions(600)), cursor: 599 }),
    );
    expect(buttonModel(model, 'submit')?.enabled).toBe(true);
    expect(buttonModel(model, 'trial-run')?.enabled).toBe(true);
  });
});
