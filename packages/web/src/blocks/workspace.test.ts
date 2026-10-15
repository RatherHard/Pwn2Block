import { describe, expect, it } from 'vitest';
import { ret2winPublic } from '@pwn2block/shared';
import { BLOCK_TYPES, CONCAT_ITEM_PREFIX, FIELDS, INPUTS } from '../compiler/types';
import { compileProgram } from '../compiler/compile';
import type { NormalizedBlock, NormalizedWorkspace } from '../compiler/types';
import { BLOCK_SPECS } from './catalog';
import type { BlocklyBlockLike, BlocklyFieldLike, BlocklyInputLike } from './workspace';
import {
  WorkspaceNormalizationError,
  normalizeWorkspace,
} from './workspace';

/**
 * 适配器测试：全部用假 Blockly 对象，**不依赖 DOM**（vitest 环境是 node）。
 * 假对象的结构与 Blockly v13 的公共 API 一致：`inputList[].fieldRow`、`connection.targetBlock()`、
 * `getNextBlock()`、`isEnabled()`。
 */

type FieldPair = readonly [name: string, value: unknown];

interface FakeBlockSpec {
  readonly id: string;
  readonly type: string;
  readonly fields?: readonly FieldPair[];
  readonly inputs?: readonly (readonly [string, FakeBlockLike])[];
  readonly next?: FakeBlockLike;
  readonly enabled?: boolean;
}

interface FakeBlockLike extends BlocklyBlockLike {
  readonly nextBlock: FakeBlockLike | null;
}

function fakeField(name: string | undefined, value: unknown): BlocklyFieldLike {
  return { name, getValue: () => value };
}

function fakeBlock(spec: FakeBlockSpec): FakeBlockLike {
  const fieldList: BlocklyFieldLike[] = (spec.fields ?? []).map(([name, value]) =>
    fakeField(name, value),
  );
  // 未命名的标签字段（Blockly 的 FieldLabel）也要占位，验证适配器会跳过它们。
  fieldList.push(fakeField(undefined, '标签'));

  const inputList: BlocklyInputLike[] = [
    { name: 'FIELDS', connection: null, fieldRow: fieldList },
  ];
  for (const [name, child] of spec.inputs ?? []) {
    inputList.push({ name, connection: { targetBlock: () => child } });
  }

  return {
    id: spec.id,
    type: spec.type,
    inputList,
    nextBlock: spec.next ?? null,
    getNextBlock: () => spec.next ?? null,
    isEnabled: () => spec.enabled ?? true,
  };
}

function fakeWorkspace(topBlocks: readonly FakeBlockLike[], onGetTopBlocks?: (ordered?: boolean) => void) {
  return {
    getTopBlocks: (ordered?: boolean) => {
      onGetTopBlocks?.(ordered);
      return [...topBlocks];
    },
  };
}

describe('适配器：归一化积木树', () => {
  it('顶层链、字段、输入槽与 next 一起归一化', () => {
    const number = fakeBlock({
      id: 'n1',
      type: BLOCK_TYPES.mathNumber,
      fields: [['NUM', 3]],
    });
    const step = fakeBlock({
      id: 's1',
      type: BLOCK_TYPES.actionStep,
      inputs: [[INPUTS.count, number]],
    });
    const start = fakeBlock({ id: 'st1', type: BLOCK_TYPES.start, next: step });

    const program: NormalizedWorkspace = normalizeWorkspace(fakeWorkspace([start]));
    expect(program).toEqual({
      blocks: [
        {
          id: 'st1',
          type: 'start',
          fields: {},
          inputs: {},
          next: {
            id: 's1',
            type: 'action_step',
            fields: {},
            inputs: {
              COUNT: { id: 'n1', type: 'math_number', fields: { NUM: 3 }, inputs: {} },
            },
          },
        },
      ],
    });
  });

  it('未连接的输入槽不出现在 inputs 里，数字字段保留数字', () => {
    const intBlock = fakeBlock({
      id: 'b1',
      type: BLOCK_TYPES.bytesInt,
      fields: [['WIDTH', 2]],
    });
    const program = normalizeWorkspace(fakeWorkspace([intBlock]));
    expect(program.blocks[0]).toEqual({
      id: 'b1',
      type: 'bytes_int',
      fields: { WIDTH: 2 },
      inputs: {},
    });
  });

  it('布尔字段转成字符串，未命名标签字段被忽略', () => {
    const block = fakeBlock({
      id: 'g1',
      type: BLOCK_TYPES.bytesString,
      fields: [
        ['TEXT', 'AB'],
        ['FLAG', true],
        ['OFF', false],
        ['NIL', null],
      ],
    });
    expect(normalizeWorkspace(fakeWorkspace([block])).blocks[0]?.fields).toEqual({
      TEXT: 'AB',
      FLAG: 'true',
      OFF: 'false',
    });
  });

  it('被禁用的积木视为未连接，禁用的顶层积木整棵跳过', () => {
    const disabledChild = fakeBlock({ id: 'x1', type: BLOCK_TYPES.mathNumber, enabled: false });
    const step = fakeBlock({
      id: 's1',
      type: BLOCK_TYPES.actionStep,
      inputs: [[INPUTS.count, disabledChild]],
      next: fakeBlock({ id: 'x2', type: BLOCK_TYPES.actionRet, enabled: false }),
    });
    const disabledTop = fakeBlock({ id: 'x3', type: BLOCK_TYPES.actionRet, enabled: false });

    const program = normalizeWorkspace(fakeWorkspace([step, disabledTop]));
    expect(program.blocks).toHaveLength(1);
    expect(program.blocks[0]).toEqual({
      id: 's1',
      type: 'action_step',
      fields: {},
      inputs: {},
    });
  });

  it('getTopBlocks 以 ordered = true 调用，顺序稳定', () => {
    const ordered: (boolean | undefined)[] = [];
    const first = fakeBlock({ id: 'a1', type: BLOCK_TYPES.start });
    const second = fakeBlock({ id: 'b1', type: BLOCK_TYPES.actionRet });
    const program = normalizeWorkspace(
      fakeWorkspace([first, second], (value) => ordered.push(value)),
    );
    expect(ordered).toEqual([true]);
    expect(program.blocks.map((block) => block.id)).toEqual(['a1', 'b1']);
  });

  it('自环的积木链抛错，不留半截数据', () => {
    const spec: FakeBlockSpec = { id: 'loop1', type: BLOCK_TYPES.controlsIf };
    const looping = fakeBlock(spec);
    // 人为造一个自环（正常 Blockly 画布不可能出现）
    (spec as unknown as { next?: FakeBlockLike }).next = looping;
    const start = fakeBlock({ id: 'st1', type: BLOCK_TYPES.start, next: looping });

    let code = '';
    try {
      normalizeWorkspace(fakeWorkspace([start]));
    } catch (error) {
      code = error instanceof WorkspaceNormalizationError ? error.code : '非预期错误';
    }
    expect(code).toBe('cycle');
  });

  it('同一个块 id 被引用两次也抛错', () => {
    const shared = fakeBlock({ id: 'dup1', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 1]] });
    const second = fakeBlock({
      id: 'w2',
      type: BLOCK_TYPES.actionPush,
      inputs: [[INPUTS.value, shared]],
    });
    const first = fakeBlock({
      id: 'w1',
      type: BLOCK_TYPES.actionPush,
      inputs: [[INPUTS.value, shared]],
      next: second,
    });
    const start = fakeBlock({ id: 'st1', type: BLOCK_TYPES.start, next: first });

    expect(() => normalizeWorkspace(fakeWorkspace([start]))).toThrow(WorkspaceNormalizationError);
  });

  it('积木缺少 id 抛错', () => {
    const block = fakeBlock({ id: '', type: BLOCK_TYPES.start });
    expect(() => normalizeWorkspace(fakeWorkspace([block]))).toThrow(WorkspaceNormalizationError);
  });
});

describe('适配器接编译器：ret2win 全链路（无 DOM）', () => {
  it('假 Blockly 画布 → 归一化 → 编译出 03 §4 的动作序列', () => {
    const author = fakeBlock({
      id: 'gets1',
      type: 'author_gets',
      inputs: [
        [
          'data',
          fakeBlock({
            id: 'cat1',
            type: BLOCK_TYPES.bytesConcat,
            inputs: [
              [
                'item0',
                fakeBlock({
                  id: 'pad1',
                  type: BLOCK_TYPES.bytesPadding,
                  inputs: [
                    [INPUTS.byte, fakeBlock({ id: 'b1', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 0x41]] })],
                    [INPUTS.count, fakeBlock({ id: 'c1', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 16]] })],
                  ],
                }),
              ],
              [
                'item1',
                fakeBlock({
                  id: 'pad2',
                  type: BLOCK_TYPES.bytesPadding,
                  inputs: [
                    [INPUTS.byte, fakeBlock({ id: 'b2', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 0x42]] })],
                    [INPUTS.count, fakeBlock({ id: 'c2', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 8]] })],
                  ],
                }),
              ],
              [
                'item2',
                fakeBlock({
                  id: 'addr1',
                  type: BLOCK_TYPES.bytesAddr,
                  inputs: [
                    [INPUTS.value, fakeBlock({ id: 'v1', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 0x400002]] })],
                  ],
                }),
              ],
            ],
          }),
        ],
      ],
    });
    const step = fakeBlock({
      id: 'step1',
      type: BLOCK_TYPES.actionStep,
      inputs: [[INPUTS.count, fakeBlock({ id: 'n2', type: BLOCK_TYPES.mathNumber, fields: [['NUM', 3]] })]],
      next: author,
    });
    const start = fakeBlock({ id: 'start1', type: BLOCK_TYPES.start, next: step });

    const program = normalizeWorkspace(fakeWorkspace([start]));
    const result = compileProgram({ program, challenge: ret2winPublic });
    expect(result).toEqual({
      ok: true,
      actions: [
        { type: 'step', count: 3 },
        {
          type: 'block',
          id: 'gets',
          args: { data: `${'41'.repeat(16)}${'42'.repeat(8)}0200400000000000` },
        },
      ],
    });
  });
});

describe('适配器：与积木目录一致', () => {
  it('目录里的每个积木类型都是编译器认识的类型', () => {
    const knownTypes = new Set<string>(Object.values(BLOCK_TYPES));
    for (const spec of BLOCK_SPECS) {
      expect(knownTypes.has(spec.type)).toBe(true);
    }
  });

  it('目录里的字段名与输入槽名都在冻结契约里（item0 / item1 变参除外）', () => {
    const knownFields = new Set<string>(Object.values(FIELDS));
    const knownInputs = new Set<string>(Object.values(INPUTS));
    for (const spec of BLOCK_SPECS) {
      for (const field of spec.fields ?? []) {
        expect(knownFields.has(field.name)).toBe(true);
      }
      for (const input of spec.inputs ?? []) {
        const isVariadic = new RegExp(`^${CONCAT_ITEM_PREFIX}\\d+$`).test(input.name);
        expect(isVariadic || knownInputs.has(input.name)).toBe(true);
      }
    }
  });

  it('归一化后的积木只带契约里的四个键', () => {
    const sample: NormalizedBlock = {
      id: 'x',
      type: BLOCK_TYPES.start,
      fields: {},
      inputs: {},
    };
    expect(Object.keys(sample).sort()).toEqual(['fields', 'id', 'inputs', 'type']);
  });
});
