import { describe, expect, it } from 'vitest';
import { MAX_IO_BYTES, bytesToHex, hexToBytes } from '@pwn2block/shared';
import type { InputState } from '@pwn2block/shared';
import { createIo } from './index';

/**
 * `IoApi` 的纯实现（G02，02 §5.3）。
 *
 * 断言全部精确到字节、读位置与错误码：I/O 边界（4KB）和 EOF 语义是判题正确性的一部分，
 * 模糊断言会让“超一个字节应当整段拒绝”这类要求失去证据。
 */

const io = createIo();

/** 造一段定长字节，默认全 `0x41`。 */
function fill(length: number, value = 0x41): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function stdinOf(hex: string, pos: number): InputState {
  return { bytes: hexToBytes(hex), pos };
}

describe('createIo().feed：stdin 缓冲上限 4KB', () => {
  it('追加到上限刚好通过，读位置不变，入参不被原地修改', () => {
    const stdin = { bytes: fill(MAX_IO_BYTES - 1, 0x01), pos: 3 };
    const outcome = io.feed(stdin, new Uint8Array([0x02]));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stdin.bytes.length).toBe(MAX_IO_BYTES);
    expect(bytesToHex(outcome.stdin.bytes.subarray(MAX_IO_BYTES - 1))).toBe('02');
    expect(outcome.stdin.bytes[0]).toBe(0x01);
    expect(outcome.stdin.pos).toBe(3);

    // 纯函数：传入的缓冲与对象保持原样。
    expect(stdin.bytes.length).toBe(MAX_IO_BYTES - 1);
    expect(outcome.stdin).not.toBe(stdin);
    expect(outcome.stdin.bytes).not.toBe(stdin.bytes);
  });

  it('超一个字节整段拒绝，原缓冲一个字节都不变', () => {
    const stdin = { bytes: fill(MAX_IO_BYTES, 0x01), pos: 7 };
    const before = stdin.bytes.slice();

    const outcome = io.feed(stdin, new Uint8Array([0x02]));

    expect(outcome).toEqual({ ok: false, code: 'stdin_overflow' });
    expect(stdin.bytes.length).toBe(MAX_IO_BYTES);
    expect(bytesToHex(stdin.bytes)).toBe(bytesToHex(before));
    expect(stdin.pos).toBe(7);
  });

  it('分两次追加：正好补齐通过，再多一个字节被拒且中间状态不变', () => {
    const empty: InputState = { bytes: new Uint8Array(0), pos: 0 };
    const first = io.feed(empty, fill(MAX_IO_BYTES / 2, 0x0a));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = io.feed(first.stdin, fill(MAX_IO_BYTES / 2, 0x0b));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.stdin.bytes.length).toBe(MAX_IO_BYTES);
    expect(second.stdin.bytes[MAX_IO_BYTES / 2 - 1]).toBe(0x0a);
    expect(second.stdin.bytes[MAX_IO_BYTES / 2]).toBe(0x0b);

    const third = io.feed(second.stdin, new Uint8Array([0x0c]));
    expect(third).toEqual({ ok: false, code: 'stdin_overflow' });
    expect(second.stdin.bytes.length).toBe(MAX_IO_BYTES);
    expect(second.stdin.bytes[MAX_IO_BYTES - 1]).toBe(0x0b);
  });

  it('空追加在满缓冲上仍然通过（上限判定是“超过”而不是“达到”）', () => {
    const stdin = { bytes: fill(MAX_IO_BYTES, 0x01), pos: MAX_IO_BYTES };
    const outcome = io.feed(stdin, new Uint8Array(0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stdin.bytes.length).toBe(MAX_IO_BYTES);
    expect(outcome.stdin.pos).toBe(MAX_IO_BYTES);
  });
});

describe('createIo().readStdin：min(count, 剩余) 与 EOF', () => {
  it('count 小于剩余时精确取 count 字节并推进读位置', () => {
    const stdin = stdinOf('0102030405', 1);
    const outcome = io.readStdin(stdin, 2);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bytesToHex(outcome.bytes)).toBe('0203');
    expect(outcome.stdin.pos).toBe(3);
    // 缓冲本身不改动，只推进位置；传入对象保持原值。
    expect(outcome.stdin.bytes).toBe(stdin.bytes);
    expect(stdin.pos).toBe(1);
  });

  it('count 大于剩余时取 min(count, 剩余)，位置推到末尾', () => {
    const stdin = stdinOf('0102030405', 3);
    const outcome = io.readStdin(stdin, 10);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bytesToHex(outcome.bytes)).toBe('0405');
    expect(outcome.stdin.pos).toBe(5);
  });

  it('读到结尾返回 0 字节且读位置不动', () => {
    const stdin = stdinOf('0102', 2);
    const outcome = io.readStdin(stdin, 8);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.bytes.length).toBe(0);
    expect(outcome.stdin).toBe(stdin);
    expect(outcome.stdin.pos).toBe(2);
  });

  it('count = 0 不取字节也不推进位置', () => {
    const stdin = stdinOf('0102', 1);
    const outcome = io.readStdin(stdin, 0);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.bytes.length).toBe(0);
    expect(outcome.stdin.pos).toBe(1);
  });

  it('返回的字节是副本：改动它不会污染 stdin 缓冲', () => {
    const stdin = stdinOf('0102030405', 0);
    const outcome = io.readStdin(stdin, 2);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    outcome.bytes[0] = 0xff;
    expect(bytesToHex(stdin.bytes)).toBe('0102030405');
  });
});

describe('createIo().appendStdout：累计 4KB 边界', () => {
  it('追加到上限刚好通过', () => {
    const stdout = fill(MAX_IO_BYTES - 1, 0x41);
    const outcome = io.appendStdout(stdout, new Uint8Array([0x42]));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.stdout.length).toBe(MAX_IO_BYTES);
    expect(outcome.stdout[MAX_IO_BYTES - 1]).toBe(0x42);
    expect(outcome.stdout[0]).toBe(0x41);
    expect(stdout.length).toBe(MAX_IO_BYTES - 1);
    expect(outcome.stdout).not.toBe(stdout);
  });

  it('超一个字节整段拒绝，一个字节都不追加', () => {
    const stdout = fill(MAX_IO_BYTES, 0x41);
    const outcome = io.appendStdout(stdout, new Uint8Array([0x42]));

    expect(outcome).toEqual({ ok: false, code: 'resource_limit' });
    expect(stdout.length).toBe(MAX_IO_BYTES);
    expect(stdout[MAX_IO_BYTES - 1]).toBe(0x41);
  });

  it('一次写满 4KB 通过，第二次追加被拒', () => {
    const first = io.appendStdout(new Uint8Array(0), fill(MAX_IO_BYTES, 0x68));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.stdout.length).toBe(MAX_IO_BYTES);
    expect(bytesToHex(first.stdout.subarray(0, 2))).toBe('6868');

    expect(io.appendStdout(first.stdout, new Uint8Array([0x69]))).toEqual({
      ok: false,
      code: 'resource_limit',
    });
    expect(first.stdout.length).toBe(MAX_IO_BYTES);
  });

  it('空追加返回等长副本', () => {
    const stdout = hexToBytes('4142');
    const outcome = io.appendStdout(stdout, new Uint8Array(0));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bytesToHex(outcome.stdout)).toBe('4142');
    expect(outcome.stdout).not.toBe(stdout);
  });
});

describe('createIo().readFile：只读、偏移推进与末尾', () => {
  const content = hexToBytes('0011223344556677');

  it('从偏移读 count 字节并推进偏移', () => {
    const outcome = io.readFile(content, 2, 3);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bytesToHex(outcome.bytes)).toBe('223344');
    expect(outcome.offset).toBe(5);
  });

  it('count 超过剩余时只读剩余，偏移停在文件末尾', () => {
    const outcome = io.readFile(content, 6, 8);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(bytesToHex(outcome.bytes)).toBe('6677');
    expect(outcome.offset).toBe(8);
  });

  it('已在末尾时返回 0 字节，偏移不动', () => {
    const outcome = io.readFile(content, 8, 4);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.bytes.length).toBe(0);
    expect(outcome.offset).toBe(8);
  });

  it('虚拟文件只读：内容不被读操作修改，返回的字节是副本', () => {
    const outcome = io.readFile(content, 0, 2);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    outcome.bytes[0] = 0xff;
    expect(bytesToHex(content)).toBe('0011223344556677');
  });
});
