import { describe, expect, it } from 'vitest';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { terminalReasonOf } from '../src/viewmodel/session';
import {
  MESSAGE_EXITED,
  MESSAGE_FAILED,
  buttonModel,
  disabledReasons,
  runMenuModel,
  type RunButtonModel,
  type RunMenuInput,
} from '../src/viewmodel/toolbar';
import { makeArtifact, repeatedActions } from './fake-api';
import { makeProjection } from './helpers';

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
    terminal: undefined,
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
    expect(buttonModel(never, 'step')?.disabledReason).toContain('还没有可运行的程序');
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

/** 八按钮可用性矩阵：id → 是否可用。 */
function enabledMatrix(model: readonly RunButtonModel[]): Readonly<Record<string, boolean>> {
  return Object.fromEntries(model.map((button) => [button.id, button.enabled]));
}

describe('终止态（failed / 已退出）禁执行类、放行回退类与提交（04 §1.1、05 §6、09 §8 第 10 条）', () => {
  /**
   * 判胜那一刻程序已经结束：`status` 是 `satisfied`，只有 `lastStop.reason === 'exit'`
   * 记得它退出了。这就是工具栏原来的盲区。
   */
  const SATISFIED_EXIT = makeProjection({
    status: 'satisfied',
    steps: 12,
    lastStop: { reason: 'exit', addr: '0x400003' },
  });
  /** 满足条件但程序还活着（停因是 `step`）：执行类动作必须照常可用。 */
  const SATISFIED_STEP = makeProjection({
    status: 'satisfied',
    steps: 9,
  });
  /** 判负：运行时异常 / 命中失败条件（03 §2.1），同样是终止态。 */
  const FAILED = makeProjection({
    status: 'failed',
    steps: 7,
    error: { code: 'memory_fault', message: '访问了未映射的地址' },
    lastStop: { reason: 'exception', addr: '0x400001' },
  });

  it('派生口径与引擎 isTerminal() 同源：failed 与「已退出」都是终止态，且优先报判负', () => {
    expect(terminalReasonOf(FAILED)).toBe('failed');
    expect(terminalReasonOf(SATISFIED_EXIT)).toBe('exited');
    expect(terminalReasonOf(makeProjection({ status: 'exited', lastStop: { reason: 'exit' } }))).toBe('exited');
    // `lastStop` 是可选的：只看 status 的那条路径也不能丢。
    expect(terminalReasonOf(makeProjection({ status: 'exited' }))).toBe('exited');
    expect(terminalReasonOf(makeProjection({ status: 'ready' }))).toBeUndefined();
    // 判负优先：退出那一刻命中失败条件时报「判负」，不报「已退出」。
    expect(terminalReasonOf(makeProjection({ status: 'failed', lastStop: { reason: 'exit' } }))).toBe('failed');
    expect(terminalReasonOf(SATISFIED_STEP)).toBeUndefined();
  });

  it('satisfied + lastStop.reason=exit：执行类三个按钮禁用，其余五个可用', () => {
    const model = runMenuModel(
      input({ history: { undo: 2, stepBack: 5 }, terminal: terminalReasonOf(SATISFIED_EXIT) }),
    );
    expect(enabledMatrix(model)).toEqual({
      compile: true,
      'trial-run': false,
      step: false,
      'run-n': false,
      'step-back': true,
      undo: true,
      reset: true,
      submit: true,
    });
    for (const id of ['trial-run', 'step', 'run-n'] as const) {
      expect(buttonModel(model, id)?.disabledReason).toBe(MESSAGE_EXITED);
    }
    // 禁用原因写出来而不只是置灰（05 §6）。
    expect(disabledReasons(model)).toEqual([
      `试运行：${MESSAGE_EXITED}`,
      `单步：${MESSAGE_EXITED}`,
      `运行 N 步：${MESSAGE_EXITED}`,
    ]);
  });

  it('status=failed：执行类三个按钮禁用且原因写「判负」，回退类与提交放行', () => {
    const model = runMenuModel(input({ history: { undo: 2, stepBack: 5 }, terminal: terminalReasonOf(FAILED) }));
    expect(enabledMatrix(model)).toEqual({
      compile: true,
      'trial-run': false,
      step: false,
      'run-n': false,
      'step-back': true,
      undo: true,
      reset: true,
      submit: true,
    });
    // 文案必须与「已退出」分开：判负未必是 exit 造成的（04 §1.1）。
    expect(disabledReasons(model)).toEqual([
      `试运行：${MESSAGE_FAILED}`,
      `单步：${MESSAGE_FAILED}`,
      `运行 N 步：${MESSAGE_FAILED}`,
    ]);
    expect(MESSAGE_FAILED).not.toBe(MESSAGE_EXITED);
    expect(MESSAGE_FAILED).toContain('已被判负');
    expect(MESSAGE_FAILED).not.toContain('已退出');
    // 出路照给：回退类与提交都要能点。
    for (const id of ['step-back', 'undo', 'reset', 'submit'] as const) {
      expect(buttonModel(model, id)?.enabled).toBe(true);
    }
  });

  it('satisfied 且没有 lastStop：八个按钮全部可用（satisfied 本身不限制动作）', () => {
    const model = runMenuModel(
      input({ history: { undo: 2, stepBack: 5 }, terminal: terminalReasonOf(SATISFIED_STEP) }),
    );
    expect(enabledMatrix(model)).toEqual({
      compile: true,
      'trial-run': true,
      step: true,
      'run-n': true,
      'step-back': true,
      undo: true,
      reset: true,
      submit: true,
    });
    expect(disabledReasons(model)).toEqual([]);
  });

  it('终止态优先于产物类原因：重编译也换不回执行权，但提交仍按产物口径说明', () => {
    const model = runMenuModel(input({ stale: true, terminal: 'exited' }));
    expect(buttonModel(model, 'trial-run')?.disabledReason).toBe(MESSAGE_EXITED);
    expect(buttonModel(model, 'step')?.disabledReason).toBe(MESSAGE_EXITED);
    expect(buttonModel(model, 'run-n')?.disabledReason).toBe(MESSAGE_EXITED);
    expect(buttonModel(model, 'submit')?.disabledReason).toBe(MESSAGE_STALE);
    expect(buttonModel(model, 'reset')?.enabled).toBe(true);

    // 没有产物时同理：先说清「程序已经退出」，而不是误导成「点编译就好」。
    const noArtifact = runMenuModel(input({ artifact: undefined, compileErrorCount: 0, terminal: 'exited' }));
    expect(buttonModel(noArtifact, 'step')?.disabledReason).toBe(MESSAGE_EXITED);
    expect(buttonModel(noArtifact, 'compile')?.enabled).toBe(true);

    // 判负也一样：编译失败 / 没产物都不是首要原因（05 §6 的优先级）。
    const failedNoArtifact = runMenuModel(input({ artifact: undefined, terminal: 'failed' }));
    expect(buttonModel(failedNoArtifact, 'step')?.disabledReason).toBe(MESSAGE_FAILED);
  });

  it('判题结果模式的原因优先于终止态：先告诉用户「回到调试」', () => {
    const model = runMenuModel(input({ mode: 'verdict', terminal: 'exited' }));
    expect(buttonModel(model, 'step')?.disabledReason).toContain('回到调试');
    expect(buttonModel(model, 'submit')?.enabled).toBe(true);
  });
});
