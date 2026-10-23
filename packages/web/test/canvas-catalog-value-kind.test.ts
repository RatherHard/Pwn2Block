import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import { createNode, defaultEncodedValue, specOf } from '../src/canvas/catalog';

/**
 * 字面值种类的目录侧验收：零值必须合法，且「切种类」只该有一个侧栏字段。
 *
 * 这一份与 `canvas-catalog.test.ts` 分开，是因为目录本身已经有一套 18 种节点的验收；
 * 这里只咬「字面值换种类」这一件事的两条前提——五个零值都过 schema/校验，
 * 以及侧栏就一个 `kind` 字段（载荷在框里改，种类在这儿改）。
 */

describe('字面值：零值与种类字段', () => {
  it('五个标量的零值逐一对应，都能解码', () => {
    expect(defaultEncodedValue('byte')).toEqual({ kind: 'byte', hex: '' });
    expect(defaultEncodedValue('int')).toEqual({ kind: 'int', value: '0' });
    expect(defaultEncodedValue('double')).toEqual({ kind: 'double', value: 0 });
    expect(defaultEncodedValue('string')).toEqual({ kind: 'string', value: '' });
    expect(defaultEncodedValue('bool')).toEqual({ kind: 'bool', value: false });
    for (const kind of canvas.SCALAR_VALUE_KINDS) {
      expect(canvas.decodeScalarValue(defaultEncodedValue(kind)).ok).toBe(true);
    }
  });

  it('每种零值都能存成字面值节点，且校验不给该节点添问题（空字节串/空文本合法）', () => {
    for (const kind of canvas.SCALAR_VALUE_KINDS) {
      const node: canvas.ValueNode = { id: 'n1', kind: 'value', value: defaultEncodedValue(kind) };
      const parsed = canvas.parseCanvasDocument({ ...canvas.emptyCanvasDocument(), nodes: [node] });
      if (!parsed.ok) throw new Error(`${kind} 的零值节点没能过 schema：${parsed.message}`);
      const own = canvas
        .validateCanvasDocument(parsed.document)
        .issues.filter((issue) => issue.nodeId === 'n1');
      expect(own, `零值 ${kind} 在校验里多了问题`).toEqual([]);
    }
  });

  it('新建字面值默认是整数 0，侧栏只有种类这一个字段', () => {
    expect(createNode('value', 'n1')).toEqual({ id: 'n1', kind: 'value', value: { kind: 'int', value: '0' } });
    expect(specOf('value').fields.map((field) => field.key)).toEqual(['kind']);
  });
});
