import { describe, expect, it } from 'vitest';
import {
  OP_NAMES,
  buildEncodingLookup,
  type EncodingItem,
  type OpName,
  type Operand,
} from '@pwn2block/shared';
import { checkChallenge, loadChallengeDefinition } from '../src/check';
import { clearPresetCache, loadPreset } from '../src/presets';
import { FIXTURES, REPO_ROOT, SENTINEL } from './helpers';

/** 加载默认编码表；失败直接让测试炸掉，后面的断言才有意义。 */
function presetItems(): readonly EncodingItem[] {
  const result = loadPreset('x86ish', REPO_ROOT);
  if (!result.ok) throw new Error(result.message);
  return result.items;
}

function operandsOf(op: OpName, operands: readonly Operand[]): EncodingItem | undefined {
  return buildEncodingLookup(presetItems(), 8).find(op, operands);
}

/**
 * 是否存在某个 op 的项，其操作数形态依次匹配 `shape`：
 * `'reg'` 匹配任意 `reg:R`，`'mem'` 匹配任意 `mem:R+disp`，其余按字面比较。
 * 形态覆盖比具体寄存器更重要——寄存器由出题人自己挑。
 */
function hasShape(op: OpName, shape: readonly string[]): boolean {
  return presetItems().some(
    (item) =>
      item.op === op &&
      item.operands.length === shape.length &&
      item.operands.every((operand, index) => {
        const want = shape[index];
        if (want === 'reg') return operand.startsWith('reg:');
        if (want === 'mem') return operand.startsWith('mem:');
        return operand === want;
      }),
  );
}

describe('presets/x86ish.json（02 §4.1 全覆盖）', () => {
  it('是合法 EncodingItem[]，且 opcode 不重复', () => {
    const items = presetItems();
    expect(items.length).toBeGreaterThan(40);
    expect(new Set(items.map((item) => item.opcode)).size).toBe(items.length);
    expect(() => buildEncodingLookup(items, 8)).not.toThrow();
  });

  it('覆盖全部内置作用', () => {
    const ops = new Set(presetItems().map((item) => item.op));
    for (const op of OP_NAMES) expect(ops.has(op), `缺少作用 ${op}`).toBe(true);
  });

  it('mov 覆盖 R,I / R,R / R,M / M,R 四种操作数形态', () => {
    expect(operandsOf('mov', ['reg:RAX', 'imm'])).toBeDefined();
    expect(operandsOf('mov', ['reg:RAX', 'reg:RCX'])).toBeDefined();
    expect(operandsOf('mov', ['reg:RAX', 'mem:RBP+disp'])).toBeDefined();
    expect(operandsOf('mov', ['mem:RBP+disp', 'reg:RAX'])).toBeDefined();
  });

  it('算术与位运算覆盖 R,R / R,I（算术另有 R,M）', () => {
    expect(hasShape('push', ['reg'])).toBe(true);
    expect(hasShape('push', ['imm'])).toBe(true);
    expect(hasShape('pop', ['reg'])).toBe(true);

    for (const op of ['add', 'sub', 'cmp'] as const) {
      expect(hasShape(op, ['reg', 'reg']), `${op} R,R`).toBe(true);
      expect(hasShape(op, ['reg', 'imm']), `${op} R,I`).toBe(true);
      expect(hasShape(op, ['reg', 'mem']), `${op} R,M`).toBe(true);
    }
    for (const op of ['and', 'or', 'xor'] as const) {
      expect(hasShape(op, ['reg', 'reg']), `${op} R,R`).toBe(true);
      expect(hasShape(op, ['reg', 'imm']), `${op} R,I`).toBe(true);
    }
    for (const op of ['shl', 'shr'] as const) {
      expect(hasShape(op, ['reg', 'imm']), `${op} R,I`).toBe(true);
      expect(hasShape(op, ['reg', 'reg']), `${op} R,R`).toBe(true);
    }
  });

  it('跳转 / 调用 / 返回覆盖内置语义', () => {
    expect(hasShape('jmp', ['imm'])).toBe(true);
    expect(hasShape('jmp', ['reg'])).toBe(true);
    expect(hasShape('jmp', ['mem'])).toBe(true);
    for (const op of ['je', 'jne', 'jb', 'jae'] as const) {
      expect(hasShape(op, ['imm']), `${op} I`).toBe(true);
    }
    expect(hasShape('call', ['imm'])).toBe(true);
    expect(hasShape('call', ['reg'])).toBe(true);
    expect(operandsOf('ret', [])).toBeDefined();
    expect(operandsOf('leave', [])).toBeDefined();
    expect(operandsOf('nop', [])).toBeDefined();
  });

  it('syscall 有无操作数形态，也有至少两个 const:N 形态', () => {
    const syscalls = presetItems().filter((item) => item.op === 'syscall');
    expect(syscalls.some((item) => item.operands.length === 0)).toBe(true);
    const consts = syscalls
      .map((item) => item.operands[0])
      .filter((operand): operand is Operand => operand !== undefined && operand.startsWith('const:'));
    expect(new Set(consts).size).toBeGreaterThanOrEqual(2);
    expect(consts).toContain('const:60');
  });

  it('opcode 贴近真实 x86（push / ret / leave / call / nop / pop）', () => {
    expect(operandsOf('push', ['reg:RAX'])?.opcode).toBe('0x50');
    expect(operandsOf('pop', ['reg:RAX'])?.opcode).toBe('0x58');
    expect(operandsOf('ret', [])?.opcode).toBe('0xc3');
    expect(operandsOf('leave', [])?.opcode).toBe('0xc9');
    expect(operandsOf('call', ['imm'])?.opcode).toBe('0xe8');
    expect(operandsOf('nop', [])?.opcode).toBe('0x90');
  });
});

describe('presets 读取与报错', () => {
  it('缓存在同一进程里生效', () => {
    clearPresetCache();
    const first = loadPreset('x86ish', REPO_ROOT);
    const second = loadPreset('x86ish', REPO_ROOT);
    expect(first).toBe(second);
  });

  it('非法 JSON 显式报错', () => {
    clearPresetCache();
    const result = loadPreset('broken', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('不是合法 JSON');
  });

  it('Schema 不合法显式报错', () => {
    clearPresetCache();
    const result = loadPreset('bad-shape', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('不符合 EncodingItem[]');
  });

  it('opcode 重复显式报错', () => {
    clearPresetCache();
    const result = loadPreset('duplicate', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('重复声明');
  });

  it('preset 名不合法（路径穿越）被拒绝', () => {
    const result = loadPreset('../secrets', REPO_ROOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('preset 名不合法');
  });

  it('文件不存在时给出读取失败原因', () => {
    clearPresetCache();
    const result = loadPreset('nope', FIXTURES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('读取编码表失败');
  });
});

describe('题目引用 preset', () => {
  it('加载时展开成完整编码表并建出查询视图', () => {
    const loaded = loadChallengeDefinition('preset-user', {
      root: FIXTURES,
      presetRoot: REPO_ROOT,
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.issues)).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.definition.encoding.length).toBe(presetItems().length);
    expect(loaded.definition.lookup.byOpcode(0x50)?.op).toBe('push');
    expect(loaded.definition.lookup.wordBytes).toBe(8);
    expect(loaded.definition.flagRef).toEqual({ kind: 'env', envVar: 'FLAG_PRESET_USER', resolved: SENTINEL });
  });

  it('preset 取不到时给出编码表问题，不做静默降级', () => {
    const report = checkChallenge('preset-user', {
      root: FIXTURES,
      presetRoot: REPO_ROOT,
      env: { FLAG_PRESET_USER: SENTINEL },
    });
    expect(report.ok).toBe(true);

    const broken = checkChallenge('broken', { root: FIXTURES, env: { FLAG_BROKEN: SENTINEL } });
    expect(broken.ok).toBe(false);
    const paths = broken.issues.map((item) => item.path);
    expect(paths).toContain('presets/bad-shape.json');
    expect(paths).toContain('vmas.text.start');
  });
});
