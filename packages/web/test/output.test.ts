import { describe, expect, it } from 'vitest';
import { outputEntries, TEXT_SATISFIED } from '../src/viewmodel/output';
import { MESSAGE_STALE } from '../src/viewmodel/program';
import { makeArtifact } from './fake-api';
import { makeProjection } from './helpers';

const ACTIONS = [{ type: 'write_bytes', addr: '0x7fffff00', hex: '4142' }, { type: 'ret' }] as const;

describe('输出区（05 §3、§5、§6）', () => {
  it('编译错误逐条列出，并带上出错积木', () => {
    const entries = outputEntries({
      artifact: undefined,
      errors: [
        { blockId: 'b1', message: '缺少输入 data' },
        { blockId: 'b2', message: '循环超过上限' },
      ],
      stale: false,
      results: [],
    });
    expect(entries[0]?.text).toContain('共 2 条错误');
    expect(entries[1]).toMatchObject({ label: '第 1 条', text: '缺少输入 data', blockId: 'b1' });
    expect(entries[2]?.blockId).toBe('b2');
  });

  it('没有积木位置的编译错误（blockId 为空串）不显示定位按钮', () => {
    const entries = outputEntries({
      artifact: undefined,
      errors: [{ blockId: '', message: '画布上需要一个「开始」积木' }],
      stale: false,
      results: [],
    });
    expect(entries[1]?.blockId).toBeUndefined();
  });

  it('动作结果区分成功 / 拒绝 / 异常', () => {
    const entries = outputEntries({
      artifact: makeArtifact(ACTIONS),
      errors: [],
      stale: false,
      results: [
        { ok: true, action: 'write_bytes' },
        { ok: false, action: 'push', error: { code: 'hidden_address', message: '目标落在隐藏区域' } },
        { ok: false, action: 'step', error: { code: 'memory_fault', message: '访问了未映射的地址' } },
      ],
    });
    expect(entries.map((entry) => entry.label)).toEqual(['成功', '拒绝', '异常']);
    expect(entries[1]?.text).toContain('第 2 个动作 push 被拒绝');
    expect(entries[1]?.detail).toContain('目标落在隐藏区域');
    expect(entries[1]?.detail).toContain('hidden_address');
    expect(entries[2]?.text).toContain('运行期异常');
  });

  it('被拒绝 / 异常的动作带上定位积木（05 §5、§6）：结果按游标对回产物', () => {
    const artifact = makeArtifact(ACTIONS, ['b0', 'b1']);
    const entries = outputEntries({
      artifact,
      errors: [],
      stale: false,
      cursor: 2,
      results: [
        { ok: true, action: 'write_bytes' },
        { ok: false, action: 'ret', error: { code: 'invalid_ip', message: '指令指针越界' } },
      ],
    });
    expect(entries[1]?.blockId).toBe('b1');
    // 少了游标就对不回产物：宁可没有定位按钮，也不指错积木（09 §3.4）。
    const withoutCursor = outputEntries({
      artifact,
      errors: [],
      stale: false,
      results: [{ ok: false, action: 'ret', error: { code: 'invalid_ip', message: '指令指针越界' } }],
    });
    expect(withoutCursor[0]?.blockId).toBeUndefined();
    // 动作类型对不上同样不定位。
    const mismatched = outputEntries({
      artifact,
      errors: [],
      stale: false,
      cursor: 1,
      results: [{ ok: false, action: 'pop', error: { code: 'empty_history', message: '栈是空的' } }],
    });
    expect(mismatched[0]?.blockId).toBeUndefined();
  });

  it('投影的 error.message 与 note 进错误解释（05 §5）', () => {
    const entries = outputEntries({
      artifact: makeArtifact(ACTIONS),
      errors: [],
      stale: false,
      results: [],
      projection: makeProjection({
        status: 'failed',
        error: { code: 'invalid_ip', message: '指令指针落在不可执行或未映射的地址', note: '先看清楚 ret 弹到哪去' },
      }),
    });
    const failed = entries.find((entry) => entry.label === '运行失败');
    expect(failed?.text).toContain('指令指针落在不可执行或未映射的地址');
    expect(failed?.detail).toContain('先看清楚 ret 弹到哪去');
    expect(failed?.detail).toContain('错误码 invalid_ip');
    expect(failed?.detail).toContain('后退一步');
  });

  it('satisfied 只提示已满足并引导去提交，不发 flag、不显示判胜依据（05 §6）', () => {
    const entries = outputEntries({
      artifact: makeArtifact(ACTIONS),
      errors: [],
      stale: false,
      results: [],
      projection: makeProjection({ status: 'satisfied' }),
    });
    const satisfied = entries.find((entry) => entry.label === '满足条件');
    expect(satisfied?.text).toBe(TEXT_SATISFIED);
    expect(satisfied?.text).toContain('提交判题');
    const json = JSON.stringify(entries);
    expect(json).not.toContain('flag');
    expect(json.toLowerCase()).not.toContain('win');
    expect(json).not.toContain('判胜依据');
  });

  it('exited 给出重来引导', () => {
    const entries = outputEntries({
      artifact: makeArtifact(ACTIONS),
      errors: [],
      stale: false,
      results: [],
      projection: makeProjection({ status: 'exited' }),
    });
    expect(entries[0]?.label).toBe('程序结束');
    expect(entries[0]?.text).toContain('撤销');
  });

  it('过期时提示重新编译，且不重复编译错误', () => {
    const entries = outputEntries({
      artifact: makeArtifact(ACTIONS),
      errors: [],
      stale: true,
      results: [],
      projection: makeProjection(),
    });
    expect(entries[0]?.label).toBe('已过期');
    expect(entries[0]?.text).toContain(MESSAGE_STALE);
  });

  it('什么都没有时给一条引导，而不是空白', () => {
    expect(outputEntries({ artifact: undefined, errors: [], stale: false, results: [] })[0]?.text).toContain(
      '会话还没开始',
    );
    expect(
      outputEntries({
        artifact: makeArtifact([]),
        errors: [],
        stale: false,
        results: [],
        projection: makeProjection(),
      })[0]?.text,
    ).toContain('试运行');
  });
});
