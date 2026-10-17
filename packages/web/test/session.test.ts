import { describe, expect, it } from 'vitest';
import {
  applyProjection,
  createPageState,
  setMode,
  statusLine,
  statusMarker,
  statusTextOf,
} from '../src/viewmodel/session';
import { SAMPLE_PROJECTION_AFTER, SAMPLE_PROJECTION_START } from '../src/fixtures/sample';
import { makeProjection } from './helpers';

describe('页面状态与状态栏文案（05 §1、§6）', () => {
  it('默认是调试模式，切到判题结果再切回来', () => {
    const state = createPageState(SAMPLE_PROJECTION_START);
    expect(state.mode).toBe('debug');
    expect(setMode(state, 'verdict').mode).toBe('verdict');
    expect(setMode(state, 'debug')).toBe(state);
  });

  it('新投影保留上一份用于差分', () => {
    const state = createPageState(SAMPLE_PROJECTION_START);
    const next = applyProjection(state, SAMPLE_PROJECTION_AFTER);
    expect(next.previous).toBe(SAMPLE_PROJECTION_START);
    expect(next.projection).toBe(SAMPLE_PROJECTION_AFTER);
    expect(applyProjection(next, SAMPLE_PROJECTION_AFTER)).toBe(next);
  });

  it('四种调试状态各有文案，判题结果模式另说', () => {
    expect(statusTextOf(makeProjection({ status: 'ready', steps: 3 }), 'debug').text).toContain('已执行 3 条指令');
    expect(statusTextOf(makeProjection({ status: 'satisfied' }), 'debug').text).toContain('已满足成功条件');
    expect(statusTextOf(makeProjection({ status: 'satisfied' }), 'debug').text).toContain('不发 flag');
    const failed = statusTextOf(
      makeProjection({
        status: 'failed',
        error: { code: 'memory_fault', message: '访问了未映射或权限不足的地址', note: '题目自定义说明' },
      }),
      'debug',
    );
    expect(failed.tone).toBe('error');
    expect(failed.text).toContain('题目自定义说明');
    expect(statusTextOf(makeProjection({ status: 'exited' }), 'debug').tone).toBe('warn');
    expect(statusTextOf(SAMPLE_PROJECTION_START, 'verdict').text).toContain('判题结果模式');
  });

  it('satisfied 且已退出时状态栏两件事都说（04 §1.1：退出事实不能被 status 抹掉）', () => {
    const satisfiedExit = statusTextOf(
      makeProjection({ status: 'satisfied', steps: 12, lastStop: { reason: 'exit', addr: '0x400003' } }),
      'debug',
    );
    expect(satisfiedExit.tone).toBe('ok');
    expect(satisfiedExit.text).toContain('已满足成功条件');
    expect(satisfiedExit.text).toContain('程序已经退出');
    expect(satisfiedExit.text).toContain('执行类动作会被拒绝');

    // 未退出的投影不带 lastStop，也不加这句话：satisfied 本身不限制任何动作。
    const satisfiedAlive = statusTextOf(
      makeProjection({ status: 'satisfied' }),
      'debug',
    );
    expect(satisfiedAlive.text).not.toContain('程序已经退出');
    expect(satisfiedAlive.text).toContain('不发 flag');
  });

  it('状态栏同时给出符号与模式名（05 §7：颜色不是唯一信息载体）', () => {
    expect(statusLine(SAMPLE_PROJECTION_START, 'debug')).toBe('调试模式 · 可继续执行');
    expect(statusLine(SAMPLE_PROJECTION_START, 'verdict')).toBe('判题结果 · 可继续执行');
    expect(statusMarker('ok')).not.toBe(statusMarker('error'));
    expect(statusMarker('error').length).toBeGreaterThan(0);
  });
});
