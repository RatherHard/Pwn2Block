import { describe, expect, it } from 'vitest';
import {
  MAX_PSEUDOCODE_CHARS,
  TEST_FLAG_SENTINEL,
  checkChallengePair,
  normalizePseudocode,
  parsePrivatePackage,
  parsePublicPackage,
  ret2winPrivate,
  ret2winPublic,
  type PrivateChallenge,
  type PublicChallenge,
} from '@pwn2block/shared';

const flagValue = TEST_FLAG_SENTINEL;

function privWith(overrides: Partial<PrivateChallenge>): unknown {
  return { ...ret2winPrivate, ...overrides };
}

function pubWith(overrides: Partial<PublicChallenge>): unknown {
  return { ...ret2winPublic, ...overrides };
}

function issuesOf(result: ReturnType<typeof checkChallengePair>): string[] {
  return result.ok ? [] : result.issues.map((item) => `${item.path}: ${item.message}`);
}

describe('题目包 Schema（反例）', () => {
  it('位宽只允许 32 / 64', () => {
    expect(parsePublicPackage(pubWith({ archBits: 16 as unknown as 64 })).ok).toBe(false);
  });

  it('权限字符非法时解析失败', () => {
    const result = parsePrivatePackage(
      privWith({
        vmas: [{ ...ret2winPrivate.vmas[0]!, perm: 'rwz' }],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('寄存器数量超上限时解析失败', () => {
    const many = Array.from({ length: 40 }, (_, i) => `R${i}`);
    const result = parsePrivatePackage(privWith({ registers: many }));
    expect(result.ok).toBe(false);
  });
});

describe('私有包语义校验（反例）', () => {
  it('VMA 未按 0x1000 对齐被报出', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        vmas: [{ ...ret2winPrivate.vmas[0]!, id: 'text', start: '0x400100' }, ret2winPrivate.vmas[1]!],
      }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('对齐'))).toBe(true);
  });

  it('VMA 区间重叠被报出', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        vmas: [
          ret2winPrivate.vmas[0]!,
          ret2winPrivate.vmas[1]!,
          { ...ret2winPrivate.vmas[1]!, id: 'stack2' },
        ],
      }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('重叠'))).toBe(true);
  });

  it('内容补丁越出本 VMA 被报出', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        vmas: [
          {
            ...ret2winPrivate.vmas[0]!,
            init: [{ at: '0x400ffc', hex: '4141414141414141' }],
          },
        ],
      }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('越出'))).toBe(true);
  });

  it('内容补丁刚好填满本 VMA 是合法的（边界不算越出）', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        vmas: [
          {
            ...ret2winPrivate.vmas[0]!,
            init: [{ at: '0x400ff8', hex: '4141414141414141' }],
          },
        ],
      }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('越出'))).toBe(false);
  });

  it('谓词嵌套超过 3 层被报出', () => {
    const deep = {
      not: { not: { not: { not: { reg_eq: { reg: 'FLAG', value: '0x1' } } } } },
    };
    const result = checkChallengePair(ret2winPublic, privWith({ win: deep }), { flagValue });
    expect(issuesOf(result).some((text) => text.includes('3 层'))).toBe(true);
  });

  it('谓词引用未声明的寄存器 / VMA 被报出', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        win: { reg_eq: { reg: 'RBX', value: '0x1' } },
        fail: [{ mem_contains: { vma: 'ghost', hex: '41' } }],
      }),
      { flagValue },
    );
    const text = issuesOf(result).join('\n');
    expect(text).toContain('RBX');
    expect(text).toContain('ghost');
  });

  it('角色寄存器必须在 registers 里声明', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({ roles: { sp: 'RSP', bp: 'RBP', ip: 'EIP' } }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('EIP'))).toBe(true);
  });

  it('flag 的环境变量引用格式必须规范', () => {
    const result = checkChallengePair(ret2winPublic, privWith({ flag: 'env:wrong' }), { flagValue });
    expect(issuesOf(result).some((text) => text.includes('env:FLAG_'))).toBe(true);
  });
});

describe('跨包校验（反例）', () => {
  it('公开包引用未声明的寄存器被报出', () => {
    const result = checkChallengePair(
      pubWith({ syscallAbi: { nr: 'RAX', args: ['RSI'], ret: 'RAX' } }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('RSI'))).toBe(true);
  });

  it('编码表里有 syscall 但没声明 syscalls 被报出', () => {
    const result = checkChallengePair(
      pubWith({ syscalls: undefined, syscallAbi: undefined }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('syscallAbi'))).toBe(true);
  });

  it('syscall 的 const 调用号必须在 syscalls 表里', () => {
    const result = checkChallengePair(
      pubWith({
        encoding: [
          { opcode: '0xc9', op: 'leave', operands: [] },
          { opcode: '0xc3', op: 'ret', operands: [] },
          { opcode: '0x0e', op: 'syscall', operands: ['const:7'] },
        ],
      }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('调用号 7'))).toBe(true);
  });

  it('set_reg 不得写 ip 角色', () => {
    const result = checkChallengePair(
      pubWith({
        syscalls: [
          {
            nr: 99,
            name: 'win',
            kind: 'custom',
            effects: [{ type: 'set_reg', reg: 'RIP', value: '0x400002' }],
          },
        ],
      }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('set_reg'))).toBe(true);
  });

  it('reveal 只能作用于 hidden VMA', () => {
    const result = checkChallengePair(
      pubWith({
        syscalls: [
          { nr: 99, name: 'win', kind: 'custom', effects: [{ type: 'reveal', vma: 'text' }] },
        ],
      }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('reveal'))).toBe(true);
  });

  it('fds 声明了虚拟文件但 files 里缺失被报出', () => {
    const result = checkChallengePair(
      pubWith({
        fds: [
          { fd: 1, name: 'stdout', kind: 'stdout' },
          { fd: 3, name: 'secret.txt', kind: 'file', size: 4 },
        ],
      }),
      ret2winPrivate,
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('fd 3'))).toBe(true);
  });

  it('文件内容长度必须等于公开的 size', () => {
    const result = checkChallengePair(
      pubWith({ fds: [{ fd: 3, name: 'secret.txt', kind: 'file', size: 8 }] }),
      privWith({ files: { '3': { hex: '41414141' } } }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('长度'))).toBe(true);
  });

  it('files 里出现没有 fd 声明的条目被报出', () => {
    const result = checkChallengePair(
      ret2winPublic,
      privWith({ files: { '9': { hex: '41414141' } } }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('fd 声明'))).toBe(true);
  });
});

describe('flag 真值泄露检查（S05 语义）', () => {
  it('虚拟文件内容包含 flag 真值时拒绝加载', () => {
    const leaked = Buffer.from(flagValue, 'ascii').toString('hex');
    const result = checkChallengePair(
      pubWith({ fds: [{ fd: 3, name: 'secret.txt', kind: 'file', size: leaked.length / 2 }] }),
      privWith({ files: { '3': { hex: leaked } } }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('flag 真值'))).toBe(true);
  });

  it('隐藏 VMA 内容包含 flag 真值时拒绝加载（大小写变体也算）', () => {
    const leaked = Buffer.from(flagValue.toUpperCase(), 'ascii').toString('hex');
    const result = checkChallengePair(
      ret2winPublic,
      privWith({
        vmas: [
          ret2winPrivate.vmas[0]!,
          ret2winPrivate.vmas[1]!,
          {
            id: 'secret',
            kind: 'key',
            start: '0x600000',
            size: '0x1000',
            perm: 'r',
            hidden: true,
            init: [{ at: '0x600000', hex: leaked }],
          },
        ],
      }),
      { flagValue },
    );
    expect(issuesOf(result).some((text) => text.includes('flag 真值'))).toBe(true);
  });

  it('伪代码包含 flag 真值（大小写变体也算）或占位符时拒绝加载，文案不回显内容', () => {
    for (const pseudocode of [`puts("${flagValue.toUpperCase()}");`, 'char *f = "ENV:FLAG_X";']) {
      const result = checkChallengePair(ret2winPublic, ret2winPrivate, { flagValue, pseudocode });
      expect(result.ok).toBe(false);
      expect(issuesOf(result).every((text) => text.startsWith('pseudocode.c: '))).toBe(true);
      expect(issuesOf(result).join('\n')).not.toContain(flagValue.toUpperCase());
    }
  });

  it('字面 flag 也不能出现在伪代码里', () => {
    const result = checkChallengePair(ret2winPublic, privWith({ flag: 'flag{literal}' }), {
      pseudocode: 'puts("flag{literal}");',
    });
    expect(issuesOf(result)).toEqual(['pseudocode.c: 伪代码包含 flag 真值，拒绝加载']);
  });

  it('flag 以字面量写死时也能正常解析（本地题目包）', () => {
    const result = checkChallengePair(ret2winPublic, privWith({ flag: 'flag{literal}' }), {});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.flagRef).toEqual({ kind: 'literal', value: 'flag{literal}' });
  });
});

describe('伪代码（pseudocode.c）并入公开包', () => {
  it('没有伪代码时公开包不带 pseudocode 字段', () => {
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, { flagValue });
    expect(result.ok && 'pseudocode' in result.definition.pub).toBe(false);
  });

  it('规范化后并入：去 BOM、CRLF / CR 转 LF、去末尾空白，行首缩进保留', () => {
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, {
      flagValue,
      pseudocode: '\uFEFF  int main() {\r\n    vuln();\r}\r\n\n',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.pub.pseudocode).toBe('  int main() {\n    vuln();\n}');
  });

  it('public.json 里直接写 pseudocode 字段被拒绝', () => {
    const result = checkChallengePair(pubWith({ pseudocode: 'int main();' }), ret2winPrivate, { flagValue });
    expect(issuesOf(result)).toEqual([
      'pseudocode: 伪代码写在 pseudocode.c，public.json 里不要写 pseudocode 字段',
    ]);
  });

  it('只有空白的文件被拒绝', () => {
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, { flagValue, pseudocode: ' \r\n\t\n' });
    expect(issuesOf(result)).toEqual(['pseudocode.c: 伪代码文件为空：这道题不需要伪代码就删掉这个文件']);
  });

  it('长度以规范化后的字符数计：恰好上限通过，多一个字符被拒绝', () => {
    const atLimit = 'x'.repeat(MAX_PSEUDOCODE_CHARS);
    expect(checkChallengePair(ret2winPublic, ret2winPrivate, { flagValue, pseudocode: `${atLimit}\n` }).ok)
      .toBe(true);
    const result = checkChallengePair(ret2winPublic, ret2winPrivate, { flagValue, pseudocode: `${atLimit}x` });
    expect(issuesOf(result)).toEqual([
      `pseudocode.c: 伪代码有 ${MAX_PSEUDOCODE_CHARS + 1} 个字符，超过 ${MAX_PSEUDOCODE_CHARS} 的上限`,
    ]);
  });

  it('normalizePseudocode 不改动已规范的文本', () => {
    expect(normalizePseudocode('a\n\tb')).toBe('a\n\tb');
  });
});
