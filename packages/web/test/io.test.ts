import { describe, expect, it } from 'vitest';
import type { PublicChallenge } from '@pwn2block/shared';
import { EMPTY_DIFF, type ProjectionDiff } from '../src/viewmodel/diff';
import {
  FD_KIND_NAMES,
  SYSCALL_KIND_NAMES,
  buildFdRows,
  buildIoView,
  buildStdinModel,
  buildStdoutModel,
  buildSyscallAbi,
  buildSyscallRows,
} from '../src/viewmodel/io';
import { availableViews } from '../src/viewmodel/views';
import { SAMPLE_FDS, SAMPLE_SYSCALLS, makeChallenge, makeProjection } from './helpers';

/**
 * I/O 视图行投影（05 §2.6）。
 *
 * 两条重点：
 * - **高亮与置灰的判定是精确的**：高亮只覆盖"本次新增"的尾巴，`stdin` 只把 `pos` 之前置灰；
 * - **不下发的东西不许出现在模型里**：隐藏 VMA 的内容、虚拟文件的内容、私有包的任何字段。
 *   后者用"键白名单"正面断言，而不是"没看见可疑字符串"这种模糊检查。
 */

function asDiff(overrides: Partial<ProjectionDiff>): ProjectionDiff {
  return { ...EMPTY_DIFF, ...overrides };
}

describe('stdout 模型', () => {
  it('逐字节给 hex 与 ASCII 两列，不可打印字节显示为 .', () => {
    const model = buildStdoutModel('410a00ff');
    expect(model.bytes.map((byte) => byte.hex)).toEqual(['41', '0a', '00', 'ff']);
    expect(model.bytes.map((byte) => byte.char)).toEqual(['A', '.', '.', '.']);
    expect(model.ascii).toBe('A...');
    expect(model.spaced).toBe('41 0a 00 ff');
    expect(model.newRange).toBeUndefined();
    expect(model.bytes.every((byte) => !byte.isNew)).toBe(true);
  });

  it('变长且本轮有写入时，只高亮新增的尾巴', () => {
    const model = buildStdoutModel('41424344', { previousHex: '4142', changed: true });
    expect(model.newRange).toEqual({ from: 2, to: 4 });
    expect(model.bytes.map((byte) => byte.isNew)).toEqual([false, false, true, true]);
  });

  it('首份投影（没有上一份）不高亮任何字节', () => {
    const model = buildStdoutModel('4142', { changed: true });
    expect(model.newRange).toBeUndefined();
    expect(model.bytes.every((byte) => !byte.isNew)).toBe(true);
  });

  it('长度没变长（reset 变短）不高亮，也不会把旧位置当新增', () => {
    const shrunk = buildStdoutModel('41', { previousHex: '414243', changed: true });
    expect(shrunk.newRange).toBeUndefined();
    expect(buildStdoutModel('414243', { previousHex: '414243', changed: false }).newRange).toBeUndefined();
  });
});

describe('stdin 模型', () => {
  it('pos 之前的字节置灰，未读数量按总数减去已读算', () => {
    const model = buildStdinModel('41424344', 2);
    expect(model.bytes.map((byte) => byte.isRead)).toEqual([true, true, false, false]);
    expect(model.pos).toBe(2);
    expect(model.total).toBe(4);
    expect(model.unread).toBe(2);
  });

  it('pos 越界时钳到 [0, 长度]，不出现负的未读数', () => {
    expect(buildStdinModel('4142', 99).pos).toBe(2);
    expect(buildStdinModel('4142', 99).unread).toBe(0);
    expect(buildStdinModel('4142', -5).pos).toBe(0);
    expect(buildStdinModel('4142', -5).unread).toBe(2);
    // 非整数（坏数据）也不会算出半读的字节。
    expect(buildStdinModel('4142', 1.7).pos).toBe(1);
  });
});

describe('syscall 速查表', () => {
  const challenge = makeChallenge({
    syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
    syscalls: SAMPLE_SYSCALLS,
    fds: SAMPLE_FDS,
  });

  it('每条给十进制与十六进制调用号、中文类别，以及 custom 的效果摘要', () => {
    const rows = buildSyscallRows(challenge);
    expect(rows.map((row) => row.nr)).toEqual([60, 99]);
    expect(rows[0]).toMatchObject({
      nrText: '60 (0x3c)',
      name: 'exit',
      kind: 'exit',
      kindName: '退出',
      doc: 'exit(code)',
      effectsText: '',
    });
    // custom 的效果按 `类型 → 摘要` 逐条拼出来，前端不解释语义。
    expect(rows[1]?.effectsText).toBe('FLAG ← 0x1；退出');
    expect(rows[1]?.kindName).toBe(SYSCALL_KIND_NAMES.custom);
  });

  it('效果摘要覆盖内置的四类原语，未知组合不会静默为空', () => {
    const rows = buildSyscallRows(
      makeChallenge({
        syscalls: [
          {
            nr: 1,
            name: 'all',
            kind: 'custom',
            effects: [
              { type: 'set_reg', reg: 'FLAG', value: '0x1' },
              { type: 'reveal', vma: 'key' },
              // `src` / `dst` 都是地址（`HexSchema`），不是 VMA id。
              { type: 'copy', src: '0x7fffff00', dst: '0x80000000', len: 8 },
              // `code` 是十六进制字符串（`HexSchema`），不是数字。
              { type: 'exit', code: '0x2' },
            ],
          },
        ],
      }),
    );
    expect(rows[0]?.effectsText).toBe(
      'FLAG ← 0x1；揭示 VMA「key」；复制 0x7fffff00 → 0x80000000（8 字节）；退出（code 0x2）',
    );
  });

  it('没有声明 syscalls 的题目给空表，而不是报错', () => {
    expect(buildSyscallRows(makeChallenge())).toEqual([]);
  });

  it('fd 表只给公开布局：有 size 才显示大小，大小按地址口吻写成十六进制', () => {
    const rows = buildFdRows(
      makeChallenge({
        fds: [
          { fd: 0, name: 'stdin', kind: 'stdin' },
          { fd: 3, name: 'flag.txt', kind: 'file', size: 64 },
        ],
      }),
    );
    expect(rows[0]).toEqual({ fd: 0, name: 'stdin', kind: 'stdin', kindName: '标准输入' });
    // `size` 是字节数（number），展示沿用地址/长度的十六进制写法。
    expect(rows[1]?.sizeText).toBe('0x40');
    expect(rows[1]?.kindName).toBe(FD_KIND_NAMES.file);
  });

  it('syscallAbi 缺失时返回 undefined，存在时复制参数而不是共享引用', () => {
    expect(buildSyscallAbi(makeChallenge())).toBeUndefined();
    const challengeWithAbi = makeChallenge({ syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' } });
    const abi = buildSyscallAbi(challengeWithAbi);
    expect(abi).toEqual({ nr: 'RAX', args: ['RDI'], ret: 'RAX' });
    const source = challengeWithAbi.syscallAbi?.args;
    expect(abi?.args).not.toBe(source);
  });
});

describe('I/O 视图模型', () => {
  const challenge = makeChallenge({
    syscallAbi: { nr: 'RAX', args: ['RDI'], ret: 'RAX' },
    syscalls: SAMPLE_SYSCALLS,
    fds: SAMPLE_FDS,
  });

  it('投影里没有流时不给 stdout / stdin，但速查表照给', () => {
    const model = buildIoView({ projection: makeProjection(), challenge });
    expect(model.stdout).toBeUndefined();
    expect(model.stdin).toBeUndefined();
    expect(model.abi).toEqual({ nr: 'RAX', args: ['RDI'], ret: 'RAX' });
    expect(model.syscalls).toHaveLength(2);
    expect(model.fds).toHaveLength(2);
  });

  it('差分与上一份投影一起决定 stdout 高亮区间', () => {
    const previous = makeProjection({ stdout: { hex: '4142' } });
    const projection = makeProjection({ stdout: { hex: '414243' } });
    const model = buildIoView({
      projection,
      previous,
      diff: asDiff({ stdoutChanged: true }),
      challenge,
    });
    expect(model.stdout?.newRange).toEqual({ from: 2, to: 3 });
    expect(model.stdout?.bytes.map((byte) => byte.isNew)).toEqual([false, false, true]);
    expect(model.stdout?.ascii).toBe('ABC');
  });

  it('没有差分信息时不高亮（例如回放逐帧渲染）', () => {
    const previous = makeProjection({ stdout: { hex: '4142' } });
    const projection = makeProjection({ stdout: { hex: '414243' } });
    const model = buildIoView({ projection, previous, diff: asDiff({ stdoutChanged: false }), challenge });
    expect(model.stdout?.newRange).toBeUndefined();
  });

  it('stdin 的读位置来自真实投影', () => {
    const model = buildIoView({
      projection: makeProjection({ stdin: { hex: '414243', pos: 1 } }),
      challenge,
    });
    expect(model.stdin?.pos).toBe(1);
    expect(model.stdin?.bytes.map((byte) => byte.isRead)).toEqual([true, false, false]);
  });
});

describe('I/O 视图：不下发的东西不出现', () => {
  it('fd 行只有公开布局四个键，虚拟文件内容没有通道进来', () => {
    const challenge: PublicChallenge = makeChallenge({
      fds: [{ fd: 3, name: 'flag.txt', kind: 'file', size: 64 }],
    });
    const model = buildIoView({ projection: makeProjection(), challenge });
    expect(Object.keys(model.fds[0] ?? {}).sort()).toEqual(['fd', 'kind', 'kindName', 'name', 'sizeText']);
    // 公开包里根本没有内容字段，模型里自然不会有——正面确认键集合，而不是"没看见"。
    expect(JSON.stringify(model)).not.toContain('flag{');
  });

  it('隐藏 VMA 的内容不进 I/O 模型：只出现公开包与投影里已有的流', () => {
    const projection = makeProjection({
      vmas: [
        { id: 'text', kind: 'code', start: '0x400000', size: '0x1000', perm: 'rx', hidden: false, hex: 'c9c3' },
        // 隐藏区只有布局，没有 hex。
        { id: 'key', kind: 'key', start: '0x80000000', size: '0x1000', perm: 'rw', hidden: true },
      ],
      stdout: { hex: '4142' },
    });
    const model = buildIoView({ projection, challenge: makeChallenge({ syscalls: SAMPLE_SYSCALLS }) });
    const json = JSON.stringify(model);
    expect(json).not.toContain('key');
    expect(json).not.toContain('0x80000000');
    // 只有投影里真实存在的 stdout 被渲染。
    expect(model.stdout?.ascii).toBe('AB');
    expect(model.stdin).toBeUndefined();
  });
});

describe('I/O 视图的出现条件（05 §2.6）', () => {
  it('题目只声明 syscalls（没有 fd）时也要出现：否则速查表看不到', () => {
    const projection = makeProjection();
    expect(availableViews(projection, makeChallenge({ syscalls: SAMPLE_SYSCALLS }))).toContain('io');
    expect(availableViews(projection, makeChallenge({ fds: SAMPLE_FDS }))).toContain('io');
  });

  it('题目什么都不声明且投影里也没有流时不出现', () => {
    expect(availableViews(makeProjection(), makeChallenge())).not.toContain('io');
  });

  it('拿不到公开包时，投影里有流就仍然出现（回放旧帧的兼容分支）', () => {
    expect(availableViews(makeProjection({ stdout: { hex: '41' } }))).toContain('io');
    expect(availableViews(makeProjection())).not.toContain('io');
  });
});
