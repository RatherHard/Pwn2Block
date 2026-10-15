import { describe, expect, it } from 'vitest';
import { buildEncodingLookup, type ChallengeVma, type EncodingItem } from '@pwn2block/shared';
import { assembleProgram, type AsmOptions, type AsmResult } from '../src/asm';
import { applyInitPatches, detectIndent } from '../src/private-init';

/**
 * 伪汇编器测试（E01）。
 *
 * 夹具自建，**不依赖仓库真实的 `challenges/`**：CI 里其它分支可能正在改它。
 * 覆盖：标签前向/后向引用、多段切换、`.byte` / `.ascii`、字面地址、字宽小端，
 * 以及全部错误路径（都必须中文报错且不返回半成品字节）。
 */

const VMAS: readonly ChallengeVma[] = [
  { id: 'text', kind: 'code', start: '0x400000', size: '0x1000', perm: 'rx', hidden: false },
  { id: 'data', kind: 'global', start: '0x600000', size: '0x1000', perm: 'rw', hidden: false },
  { id: 'tiny', kind: 'custom', label: '小段', start: '0x700000', size: '0x1000', perm: 'rw', hidden: false },
];

/** 一张够用的编码表：无操作数、imm、reg、const、mem 五种情况都有。 */
const ITEMS: readonly EncodingItem[] = [
  { opcode: '0xc9', op: 'leave', operands: [] },
  { opcode: '0xc3', op: 'ret', operands: [] },
  { opcode: '0xe9', op: 'jmp', operands: ['imm'], mnemonic: 'jmp addr' },
  { opcode: '0x74', op: 'je', operands: ['imm'] },
  { opcode: '0xe8', op: 'call', operands: ['imm'] },
  { opcode: '0xb8', op: 'mov', operands: ['reg:RAX', 'imm'] },
  { opcode: '0x8b', op: 'mov', operands: ['reg:RBX', 'mem:RBP+disp'] },
  { opcode: '0x50', op: 'push', operands: ['reg:RAX'] },
  { opcode: '0x5f', op: 'pop', operands: ['reg:RDI'] },
  { opcode: '0x0f', op: 'syscall', operands: [] },
  { opcode: '0x10', op: 'syscall', operands: ['const:60'], mnemonic: 'syscall exit' },
  { opcode: '0x11', op: 'syscall', operands: ['const:99'], mnemonic: 'syscall win' },
  { opcode: '0x90', op: 'nop', operands: [] },
];

const lookup = buildEncodingLookup(ITEMS, 8);
const lookup32 = buildEncodingLookup(ITEMS, 4);

/** 64 位小端字面量，省得在断言里数零。 */
function word64(value: bigint): string {
  let rest = value;
  const bytes: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    bytes.push((rest & 0xffn).toString(16).padStart(2, '0'));
    rest >>= 8n;
  }
  return bytes.join('');
}

function assemble(source: string, options: AsmOptions = {}): AsmResult {
  return assembleProgram(source, VMAS, { lookup, ...options });
}

function mustOk(source: string, options: AsmOptions = {}): Extract<AsmResult, { ok: true }> {
  const result = assemble(source, options);
  if (!result.ok) throw new Error(`期望汇编成功，实际报错：${result.message}`);
  return result;
}

function mustFail(source: string, options: AsmOptions = {}): string {
  const result = assemble(source, options);
  expect(result.ok, '期望汇编失败，但它成功了').toBe(false);
  return result.ok ? '' : result.message;
}

function hexOf(result: Extract<AsmResult, { ok: true }>, vmaId: string): string {
  const segment = result.segments.find((item) => item.vmaId === vmaId);
  return segment?.patches.map((patch) => patch.hex).join('') ?? '';
}

describe('asm：标签与跳转目标', () => {
  it('前向引用、后向引用都算成绝对地址，imm 按 8 字节小端编码', () => {
    const result = mustOk(`.vma text
start:
    jmp forward
back:
    ret
forward:
    jmp back
`);
    expect(result.vmaId).toBe('text');
    expect(hexOf(result, 'text')).toBe(`e9${word64(0x40000an)}c3e9${word64(0x400009n)}`);
    expect(result.patches).toEqual([
      { at: '0x400000', hex: `e9${word64(0x40000an)}c3e9${word64(0x400009n)}` },
    ]);
  });

  it('地址清单按地址升序给出标签、绝对地址与所属 VMA', () => {
    const result = mustOk(`.vma text
start:
    jmp forward
back:
    ret
forward:
    jmp back
`);
    expect(result.listing).toEqual([
      { label: 'start', addr: '0x400000', vma: 'text' },
      { label: 'back', addr: '0x400009', vma: 'text' },
      { label: 'forward', addr: '0x40000a', vma: 'text' },
    ]);
  });

  it('跳转目标也可以手写字面地址（十六进制与十进制都行）', () => {
    const result = mustOk(`.vma text
    jmp 0x400010
    call 64
`);
    expect(hexOf(result, 'text')).toBe(`e9${word64(0x400010n)}e8${word64(64n)}`);
  });

  it('标签可以与指令写在同一行', () => {
    const result = mustOk(`.vma text
vuln: leave
win: syscall 99
lose: syscall 60
`);
    expect(hexOf(result, 'text')).toBe('c91110');
    expect(result.listing.map((entry) => entry.addr)).toEqual(['0x400000', '0x400001', '0x400002']);
  });

  it('注释与空行不影响结果', () => {
    const result = mustOk(`; 题目说明
.vma text

    leave   ; 弹栈
    ret
`);
    expect(hexOf(result, 'text')).toBe('c9c3');
  });
});

describe('asm：段与数据', () => {
  it('.vma 切段：各段基址取 private.json 的 start，补丁按段给', () => {
    const result = mustOk(`.vma text
entry:
    jmp blob
.vma data
blob:
    .byte 0xde, 0xad
    .ascii "hi"
`);
    expect(result.vmaId).toBe('text');
    expect(result.segments).toEqual([
      { vmaId: 'text', patches: [{ at: '0x400000', hex: `e9${word64(0x600000n)}` }] },
      { vmaId: 'data', patches: [{ at: '0x600000', hex: 'dead6869' }] },
    ]);
    expect(result.listing).toEqual([
      { label: 'entry', addr: '0x400000', vma: 'text' },
      { label: 'blob', addr: '0x600000', vma: 'data' },
    ]);
  });

  it('.byte 接受十六进制与十进制，.ascii 支持转义', () => {
    const result = mustOk(`.vma data
    .byte 0x00, 255, 1
    .ascii "a\\n\\x41b"
`);
    expect(hexOf(result, 'data')).toBe('00ff01610a4162');
  });

  it('标签可以直接当跳转目标跨段使用', () => {
    const result = mustOk(`.vma data
far:
    .byte 0x90
.vma text
    call far
`);
    expect(hexOf(result, 'text')).toBe(`e8${word64(0x600000n)}`);
  });
});

describe('asm：操作数形态与字宽', () => {
  it('syscall 三种形态各走各的编码项', () => {
    const result = mustOk(`.vma text
    syscall
    syscall 60
    syscall 99
`);
    expect(hexOf(result, 'text')).toBe('0f1011');
  });

  it('寄存器操作数大小写不敏感，固定寄存器写在 opcode 里', () => {
    const result = mustOk(`.vma text
    mov RAX, 0x1
    push rax
    pop rdi
`);
    expect(hexOf(result, 'text')).toBe(`b8${word64(1n)}505f`);
  });

  it('内存操作数支持 [REG]、[REG+disp]、[REG-disp]', () => {
    const result = mustOk(`.vma text
    mov rbx, [rbp]
    mov rbx, [rbp+0x10]
    mov rbx, [rbp-8]
`);
    expect(hexOf(result, 'text')).toBe(`8b${word64(0n)}8b${word64(0x10n)}8b${'f8ffffffffffffff'}`);
  });

  it('32 位题目的 imm / disp 按 4 字节小端', () => {
    const result = mustOk(
      `.vma text
    mov rax, 0x400002
    jmp 0x400010
`,
      { lookup: lookup32 },
    );
    expect(hexOf(result, 'text')).toBe('b802004000e910004000');
  });

  it('立即数按字宽掩蔽负数（[rbp-8] 是二补数）', () => {
    const result = mustOk(`.vma text
    mov rbx, [rbp-1]
`, { lookup: buildEncodingLookup(ITEMS, 2) });
    expect(hexOf(result, 'text')).toBe('8bffff');
  });
});

describe('asm：错误一律中文报错，不返回半成品字节', () => {
  it('未定义的标签', () => {
    expect(mustFail('.vma text\n    jmp nowhere\n')).toContain('未定义的标签：nowhere');
  });

  it('内容出现在 .vma 之前', () => {
    expect(mustFail('    ret\n.vma text\n    leave\n')).toContain('任何 .vma 段之前');
  });

  it('.vma 引用了不存在的段', () => {
    expect(mustFail('.vma nope\n    ret\n')).toContain('不存在的 VMA：nope');
  });

  it('一个段重复声明', () => {
    const message = mustFail('.vma text\n    ret\n.vma text\n    leave\n');
    expect(message).toContain('段 text 重复声明');
  });

  it('完全没有 .vma 段', () => {
    expect(mustFail('; 只有注释\n')).toContain('没有 .vma 段');
  });

  it('段里一个字节都没有', () => {
    expect(mustFail('.vma text\nempty:\n')).toContain('没有任何字节');
  });

  it('指令不在编码表里', () => {
    expect(mustFail('.vma text\n    frobnicate\n')).toContain('不在编码表里');
  });

  it('操作数形态不符时列出本题可用形态', () => {
    const message = mustFail('.vma text\n    mov rax, rcx\n', { registers: ['RAX', 'RCX'] });
    expect(message).toContain('操作数形态不符');
    expect(message).toContain('reg:RAX, imm');
  });

  it('未声明的调用号也算操作数形态不符', () => {
    expect(mustFail('.vma text\n    syscall 1\n')).toContain('操作数形态不符');
  });

  it('指令带多余操作数时报操作数形态不符', () => {
    expect(mustFail('.vma text\n    ret rax\n', { registers: ['RAX'] })).toContain('操作数形态不符');
  });

  it('超出 VMA 大小', () => {
    const blob = 'A'.repeat(4097);
    const message = mustFail(`.vma tiny\n    .ascii "${blob}"\n`);
    expect(message).toContain('越出 VMA tiny 的大小');
  });

  it('刚好写满 VMA 是允许的', () => {
    const blob = 'A'.repeat(4096);
    const result = mustOk(`.vma tiny\n    .ascii "${blob}"\n`);
    expect(hexOf(result, 'tiny')).toHaveLength(4096 * 2);
  });

  it('标签重复定义', () => {
    expect(mustFail('.vma text\nwin:\n    ret\nwin:\n    leave\n')).toContain('标签「win」重复定义');
  });

  it('标签名与寄存器同名', () => {
    expect(mustFail('.vma text\nrax:\n    ret\n')).toContain('与本题的寄存器同名');
  });

  it('.byte 的值超出一个字节', () => {
    expect(mustFail('.vma text\n    .byte 0x100\n')).toContain('不是 0x00–0xff');
  });

  it('不支持的伪指令', () => {
    expect(mustFail('.vma text\n    .org 0x10\n')).toContain('不支持的伪指令');
  });

  it('.ascii 的非 ASCII 字符与未知转义都报错', () => {
    expect(mustFail('.vma text\n    .ascii "中"\n')).toContain('只支持 ASCII');
    expect(mustFail('.vma text\n    .ascii "a\\qb"\n')).toContain('不支持的转义');
  });

  it('立即数超过字宽', () => {
    expect(mustFail('.vma text\n    jmp 0x100000000\n', { lookup: lookup32 })).toContain('超出 4 字节字宽');
  });

  it('内存操作数里的寄存器不在编码表里', () => {
    expect(mustFail('.vma text\n    mov rbx, [rcx]\n')).toContain('[rcx]');
  });

  it('逗号写错导致空操作数', () => {
    expect(mustFail('.vma text\n    jmp 0x1,\n')).toContain('操作数不能为空');
  });

  it('缺少编码表时明确报错，而不是猜', () => {
    const result = assembleProgram('.vma text\n    ret\n', VMAS);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('缺少编码表');
  });

  it('字宽不合法时报错', () => {
    const result = assembleProgram('.vma text\n    ret\n', VMAS, { lookup: buildEncodingLookup(ITEMS, 0) });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('字宽不合法');
  });
});

describe('asm：写回 private.json 的 init', () => {
  const PRIVATE = `{
  "registers": ["RAX"],
  "vmas": [
    {
      "id": "text",
      "init": [{ "at": "0x400000", "hex": "ffff" }]
    },
    {
      "id": "stack",
      "init": [{ "at": "0x7fffff10", "hex": "aabb" }]
    }
  ]
}
`;

  it('只替换 program.asm 声明的段，其余 VMA 的 init 原样保留', () => {
    const applied = applyInitPatches(PRIVATE, [{ vmaId: 'text', patches: [{ at: '0x400000', hex: 'c9c3' }] }]);
    expect(applied.ok, applied.ok ? '' : applied.message).toBe(true);
    if (!applied.ok) return;
    expect(applied.changed).toBe(true);
    const parsed = JSON.parse(applied.text) as { vmas: { id: string; init: unknown }[] };
    expect(parsed.vmas).toEqual([
      { id: 'text', init: [{ at: '0x400000', hex: 'c9c3' }] },
      { id: 'stack', init: [{ at: '0x7fffff10', hex: 'aabb' }] },
    ]);
    expect(applied.text.endsWith('\n')).toBe(true);
  });

  it('内容一致时 changed 为 false（CLI 据此不写盘，手写排版也保留）', () => {
    const applied = applyInitPatches(PRIVATE, [{ vmaId: 'text', patches: [{ at: '0x400000', hex: 'ffff' }] }]);
    expect(applied.ok, applied.ok ? '' : applied.message).toBe(true);
    if (!applied.ok) return;
    expect(applied.changed).toBe(false);
    expect(JSON.parse(applied.text)).toEqual(JSON.parse(PRIVATE));
  });

  it('缩进沿用文件里已有的风格', () => {
    const four = '{\n    "vmas": [\n        {\n            "id": "text"\n        }\n    ]\n}\n';
    expect(detectIndent(four)).toBe('    ');
    const applied = applyInitPatches(four, [{ vmaId: 'text', patches: [] }]);
    expect(applied.ok, applied.ok ? '' : applied.message).toBe(true);
    if (!applied.ok) return;
    expect(applied.text).toContain('\n    "vmas"');
  });

  it('段不在 private.json 里时报错', () => {
    const applied = applyInitPatches(PRIVATE, [{ vmaId: 'nowhere', patches: [] }]);
    expect(applied.ok).toBe(false);
    expect(applied.ok ? '' : applied.message).toContain('不存在的 VMA：nowhere');
  });

  it('private.json 不是合法 JSON 时报错', () => {
    const applied = applyInitPatches('{oops', []);
    expect(applied.ok).toBe(false);
    expect(applied.ok ? '' : applied.message).toContain('不是合法 JSON');
  });
});
