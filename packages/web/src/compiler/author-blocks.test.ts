import { describe, expect, it } from 'vitest';
import {
  expandBlock,
  ret2winPublic,
  type AuthorBlock,
  type BlockAction,
  type PublicChallenge,
} from '@pwn2block/shared';
import { authorBlockSpec } from '../blocks/catalog';
import { compileProgram } from './compile';
import type { CompiledAction, NormalizedBlock, NormalizedWorkspace } from './types';
import {
  AUTHOR_BLOCK_PREFIX,
  BLOCK_TYPES,
  MESSAGE_UNDECLARED_AUTHOR_BLOCK,
  authorBlockType,
} from './types';

/**
 * 出题人积木（03 §3、05 §3.1）。
 *
 * 一个题目接口的**三处**必须对上，否则学习者会撞上莫名其妙的失败：
 * - 工具箱里的输入槽名 = `params[].name`（05 §3.1）；
 * - 编译产物 `{ type: 'block', id, args }` 的 `args` 键 = `params[].name`；
 * - 该动作交给**服务端同一个展开器** `expandBlock` 必须能展开（否则就是"编译能过、提交必被拒"）。
 *
 * 最后一个文件末的性质用例把「编译期判定」与「服务端展开」钉在一起：编译通过 ⇒ 一定能展开；
 * 编译拒绝 ⇒ 服务端也会拒。这里的公开包用真实 fixture 展开，只覆盖 `authorBlocks` / `allowedActions`
 * 两个字段，所以它就是一份结构完整的 `PublicChallenge`，可以直接喂 `expandBlock`。
 */

let sequence = 0;

function blk(type: string, extras: Partial<NormalizedBlock> = {}): NormalizedBlock {
  sequence += 1;
  return { id: `${type}_${sequence}`, type, fields: {}, inputs: {}, ...extras };
}

const num = (value: number): NormalizedBlock =>
  blk(BLOCK_TYPES.mathNumber, { fields: { NUM: value } });

const address = (value: string): NormalizedBlock =>
  blk(BLOCK_TYPES.valueAddr, { fields: { ADDR: value } });

const rawBytes = (hex: string): NormalizedBlock =>
  blk(BLOCK_TYPES.bytesRaw, { fields: { HEX: hex } });

function programOf(chain: readonly NormalizedBlock[]): NormalizedWorkspace {
  let head: NormalizedBlock | undefined;
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const current = chain[i] as NormalizedBlock;
    head = { ...current, next: head };
  }
  return { blocks: [blk(BLOCK_TYPES.start, { next: head })] };
}

const authorBlocks: AuthorBlock[] = [
  {
    id: 'gets',
    label: 'gets(buf)',
    tooltip: '从 buf 起写入字节，不检查长度',
    params: [{ name: 'data', type: 'bytes' }],
    expand: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '$data' }],
  },
  {
    id: 'advance',
    label: 'advance(n)',
    params: [{ name: 'n', type: 'int' }],
    expand: [{ type: 'step', count: '$n' }],
  },
  {
    id: 'pusher',
    label: 'pusher(v)',
    params: [{ name: 'v', type: 'int' }],
    expand: [{ type: 'push', value: '$v' }],
  },
  {
    id: 'mismatch',
    label: 'mismatch(d)',
    params: [{ name: 'd', type: 'addr' }],
    expand: [{ type: 'write_bytes', addr: '0x1000', hex: '$d' }],
  },
  {
    id: 'poke',
    label: 'poke(a, d)',
    params: [
      { name: 'a', type: 'addr' },
      { name: 'd', type: 'bytes' },
    ],
    expand: [{ type: 'write_bytes', addr: '$a', hex: '$d' }],
  },
];

/** 结构完整的公开包（其余字段沿用 ret2win 的真实包）。 */
const challenge: PublicChallenge = {
  ...ret2winPublic,
  allowedActions: ['step', 'run', 'write_bytes', 'push'],
  authorBlocks,
};

function compileAuthor(
  type: string,
  inputs: Record<string, NormalizedBlock> = {},
  blockId = 'author_block',
): ReturnType<typeof compileProgram> {
  return compileProgram({
    program: programOf([blk(type, { id: blockId, inputs })]),
    challenge,
  });
}

function actionsOf(result: ReturnType<typeof compileProgram>): readonly CompiledAction[] {
  if (!result.ok) throw new Error(`期望编译成功，实际报错：${JSON.stringify(result.errors)}`);
  return result.actions;
}

function errorsOf(
  result: ReturnType<typeof compileProgram>,
): readonly { blockId: string; message: string }[] {
  if (result.ok) throw new Error('期望编译失败，实际成功');
  return result.errors;
}

/** 编译结果里的 `block` 动作（性质检查用）。 */
function blockActionsOf(result: ReturnType<typeof compileProgram>): readonly BlockAction[] {
  return actionsOf(result).filter((action): action is BlockAction => action.type === 'block');
}

describe('出题人积木：由 authorBlocks 动态生成（05 §3.1）', () => {
  it('输入槽名就是 params 名，一块不多一块不少', () => {
    for (const block of authorBlocks) {
      const spec = authorBlockSpec(block);
      expect(spec.type).toBe(`${AUTHOR_BLOCK_PREFIX}${block.id}`);
      expect(spec.type).toBe(authorBlockType(block.id));
      expect(spec.inputs?.map((input) => input.name)).toEqual(block.params.map((p) => p.name));
    }
  });

  it('编译认的输入槽与工具箱生成的是同一组名字', () => {
    const result = compileAuthor('author_gets', { data: rawBytes('aabb') }, 'gets_block');
    expect(actionsOf(result)).toEqual([{ type: 'block', id: 'gets', args: { data: 'aabb' } }]);

    // 换成工具箱里没有的槽名（旧存档 / 手写树）：编译期必须拒绝。
    const extra = compileAuthor(
      'author_gets',
      { data: rawBytes('aabb'), buf: num(1) },
      'gets_block',
    );
    expect(errorsOf(extra)).toEqual([
      { blockId: 'gets_block', message: '出题人积木 gets 没有声明参数 buf' },
    ]);
  });
});

describe('出题人积木：author_<id> → block 动作，参数原样带上（03 §3）', () => {
  it('bytes / int / addr 参数各按契约编码，展开留给服务端', () => {
    const result = compileAuthor('author_gets', { data: rawBytes('41'.repeat(4)) });
    expect(actionsOf(result)).toEqual([
      { type: 'block', id: 'gets', args: { data: '41414141' } },
    ]);
    // 客户端不发展开结果：请求体里既没有模板动作，也没有模板字段。
    const body = JSON.stringify(actionsOf(result));
    expect(body).not.toContain('write_bytes');
    expect(body).not.toContain('expand');
    expect(body).not.toContain('0x7fffff00');
  });

  it('空字节串是合法参数（服务端的 HexBytesSchema 允许空串）', () => {
    const result = compileAuthor('author_gets', { data: rawBytes('') });
    expect(actionsOf(result)).toEqual([{ type: 'block', id: 'gets', args: { data: '' } }]);
    expect(expandBlock(challenge, blockActionsOf(result)[0] as BlockAction)).toEqual({
      ok: true,
      actions: [{ type: 'write_bytes', addr: '0x7fffff00', hex: '' }],
    });
  });

  it('int / addr 参数编码成 0x 前缀字符串（与重载校验一致）', () => {
    const intResult = compileAuthor('author_pusher', { v: num(0x4142) });
    expect(actionsOf(intResult)).toEqual([
      { type: 'block', id: 'pusher', args: { v: '0x4142' } },
    ]);

    const addrResult = compileAuthor('author_poke', {
      a: address('0x1234'),
      d: rawBytes('41'),
    });
    expect(actionsOf(addrResult)).toEqual([
      { type: 'block', id: 'poke', args: { a: '0x1234', d: '41' } },
    ]);
    expect(expandBlock(challenge, { type: 'block', id: 'poke', args: { a: '0x1234', d: '41' } })).toEqual(
      { ok: true, actions: [{ type: 'write_bytes', addr: '0x1234', hex: '41' }] },
    );
  });

  it('出题人积木不受 allowedActions 限制（03 §3）', () => {
    const locked: PublicChallenge = { ...challenge, allowedActions: [] };
    const result = compileProgram({
      program: programOf([blk('author_gets', { inputs: { data: rawBytes('41') } })]),
      challenge: locked,
    });
    expect(actionsOf(result)).toEqual([{ type: 'block', id: 'gets', args: { data: '41' } }]);
  });
});

describe('出题人积木：编译期的四类拒绝', () => {
  it('未声明的 id', () => {
    const result = compileAuthor('author_nope', {}, 'nope_block');
    expect(errorsOf(result)).toEqual([
      { blockId: 'nope_block', message: MESSAGE_UNDECLARED_AUTHOR_BLOCK('nope') },
    ]);
  });

  it('缺参数', () => {
    expect(errorsOf(compileAuthor('author_gets')).map((error) => error.message)).toEqual([
      '出题人积木 gets 缺少参数输入：data',
    ]);
  });

  it('多参数', () => {
    expect(
      errorsOf(compileAuthor('author_gets', { data: rawBytes('41'), extra: num(1) })).map(
        (error) => error.message,
      ),
    ).toEqual(['出题人积木 gets 没有声明参数 extra']);
  });

  it('类型不符：bytes 槽给数值积木', () => {
    expect(errorsOf(compileAuthor('author_gets', { data: num(1) }))[0]?.message).toContain(
      '需要字节表达式',
    );
  });

  it('类型不符：int 槽给字节积木', () => {
    expect(errorsOf(compileAuthor('author_advance', { n: rawBytes('41') }))[0]?.message).toContain(
      '需要数值表达式',
    );
  });
});

describe('出题人积木：参数形式没错但展开不可能成功时，编译期就拒（缺陷回归）', () => {
  it('int 参数撞模板 step.count 的下界：编译期报错并指出出题人积木', () => {
    const result = compileAuthor('author_advance', { n: num(0) }, 'advance_block');
    const error = errorsOf(result)[0];
    expect(error?.blockId).toBe('advance_block');
    expect(error?.message).toContain('出题人积木 advance 的参数无法展开');
    // 服务端展开的判定与这里一致：确实会 invalid_arguments。
    const denied = expandBlock(challenge, { type: 'block', id: 'advance', args: { n: '0x0' } });
    expect(denied.ok).toBe(false);
  });

  it('int 参数撞上界：10001 被拒、恰好 10000 通过（边界精确）', () => {
    expect(
      errorsOf(compileAuthor('author_advance', { n: num(10001) }))[0]?.message,
    ).toContain('无法展开');
    const boundary = compileAuthor('author_advance', { n: num(10000) });
    expect(actionsOf(boundary)).toEqual([{ type: 'block', id: 'advance', args: { n: '0x2710' } }]);
    expect(expandBlock(challenge, { type: 'block', id: 'advance', args: { n: '0x2710' } })).toEqual({
      ok: true,
      actions: [{ type: 'step', count: 10000 }],
    });
  });

  it('参数类型与模板槽位不匹配（出题人包写错）也不会放过：编译期拒，服务端同样拒', () => {
    const result = compileAuthor('author_mismatch', { d: address('0x1234') });
    expect(errorsOf(result)[0]?.message).toContain('无法展开');
    expect(
      expandBlock(challenge, { type: 'block', id: 'mismatch', args: { d: '0x1234' } }).ok,
    ).toBe(false);
  });

  it('大整数进 push 模板是合法的：不要过度拒绝', () => {
    const result = compileAuthor('author_pusher', { v: num(Number.MAX_SAFE_INTEGER) });
    const action = blockActionsOf(result)[0] as BlockAction;
    expect(action).toEqual({ type: 'block', id: 'pusher', args: { v: '0x1fffffffffffff' } });
    expect(expandBlock(challenge, action).ok).toBe(true);
  });
});

interface AlignmentCase {
  readonly name: string;
  readonly type: string;
  readonly inputs: Record<string, NormalizedBlock>;
  /** 与编译产物等价的动作（编译期拒绝时用它验证服务端也会拒）。 */
  readonly equivalent: BlockAction;
}

describe('出题人积木：编译期判定与服务端 expandBlock 口径一致', () => {
  const cases: readonly AlignmentCase[] = [
    {
      name: 'bytes 参数正常',
      type: 'author_gets',
      inputs: { data: rawBytes('aabb') },
      equivalent: { type: 'block', id: 'gets', args: { data: 'aabb' } },
    },
    {
      name: 'bytes 参数为空',
      type: 'author_gets',
      inputs: { data: rawBytes('') },
      equivalent: { type: 'block', id: 'gets', args: { data: '' } },
    },
    {
      name: 'int 参数合法',
      type: 'author_advance',
      inputs: { n: num(3) },
      equivalent: { type: 'block', id: 'advance', args: { n: '0x3' } },
    },
    {
      name: 'int 参数越上界',
      type: 'author_advance',
      inputs: { n: num(20000) },
      equivalent: { type: 'block', id: 'advance', args: { n: '0x4e20' } },
    },
    {
      name: '未声明的 id',
      type: 'author_nope',
      inputs: {},
      equivalent: { type: 'block', id: 'nope', args: {} },
    },
    {
      name: '缺参数',
      type: 'author_gets',
      inputs: {},
      equivalent: { type: 'block', id: 'gets', args: {} },
    },
    {
      name: '多参数',
      type: 'author_gets',
      inputs: { data: rawBytes('41'), extra: num(1) },
      equivalent: { type: 'block', id: 'gets', args: { data: '41', extra: '0x1' } },
    },
  ];

  for (const item of cases) {
    it(`${item.name}：编译通过 ⇔ 服务端能展开`, () => {
      const result = compileProgram({
        program: programOf([blk(item.type, { inputs: item.inputs })]),
        challenge,
      });
      const expansion = expandBlock(challenge, item.equivalent);
      if (result.ok) {
        // 编译放行的每一个 block 动作都必须真的能展开，否则就是"编译能过、提交必被拒"。
        const actions = blockActionsOf(result);
        expect(actions).toHaveLength(1);
        for (const action of actions) expect(expandBlock(challenge, action).ok).toBe(true);
        return;
      }
      expect(errorsOf(result).length).toBeGreaterThan(0);
      expect(expansion.ok).toBe(false);
    });
  }
});
