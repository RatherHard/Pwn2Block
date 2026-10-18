import { describe, expect, it } from 'vitest';
import {
  ALPHABETS,
  CYCLIC_SUBSEQUENCE_WIDTH,
  NODE,
  NODE_SPECS,
  WORKFLOW_FORMAT,
  WORKFLOW_VERSION,
  availableNodeSpecs,
  cyclicFind,
  cyclicSequence,
  deBruijnSequence,
  decodeInt,
  defaultParams,
  encodeInt,
  encodedValueSummary,
  emptyGraphDocument,
  nodeInputs,
  nodeOutput,
  nodeSpec,
  parseGraphDocument,
  pythonInputs,
  stageAvailable,
} from '../src/index';

/**
 * 节点目录、传输编码、存档 Schema 与定位序列工具的契约测试（07 §P1）。
 *
 * 断言尽量精确：这些都是前端表单、编译器与服务端共用的定义，改动必须让测试失败，
 * 而不是被"大致对得上"的模糊断言放过。
 */

const CONTEXT = { archBits: 64 } as const;

describe('节点目录', () => {
  it('每个节点都有稳定标识、版本与交付阶段', () => {
    const kinds = new Set<string>();
    for (const spec of NODE_SPECS) {
      expect(spec.kind).toBe(spec.kind.trim());
      expect(kinds.has(spec.kind)).toBe(false);
      kinds.add(spec.kind);
      expect(spec.version).toBeGreaterThanOrEqual(1);
      expect(['p2', 'p3', 'p4', 'p5', 'p7']).toContain(spec.stage);
      expect(spec.summary.length).toBeGreaterThan(0);
    }
    expect(kinds.size).toBeGreaterThan(15);
  });

  it('工具箱按阶段开放：p3 阶段不出现 Python 与定位序列节点', () => {
    const kinds = availableNodeSpecs('p3').map((spec) => spec.kind);
    expect(kinds).toContain(NODE.fill);
    expect(kinds).toContain(NODE.write);
    expect(kinds).not.toContain(NODE.python);
    expect(kinds).not.toContain(NODE.cyclic);
    expect(stageAvailable('p7', 'p3')).toBe(false);
    expect(stageAvailable('p2', 'p3')).toBe(true);
  });

  it('拼接节点的变参输入随 count 变化', () => {
    const spec = nodeSpec(NODE.concat);
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const params = { ...defaultParams(spec), count: 3 };
    const inputs = nodeInputs(spec, params, CONTEXT);
    expect(inputs.map((input) => input.name)).toEqual(['item0', 'item1', 'item2']);
    expect(inputs.every((input) => input.type === 'bytes' && input.required)).toBe(true);
  });

  it('按偏移组装每段都有偏移参数与输入口，且偏移可内填', () => {
    const spec = nodeSpec(NODE.assemble);
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    const params = { ...defaultParams(spec), count: 2 };
    const inputs = nodeInputs(spec, params, CONTEXT);
    expect(inputs.map((input) => input.name)).toEqual(['offset0', 'offset1', 'item0', 'item1']);
    // 偏移既可接线也可内填，所以不接不算缺输入。
    expect(inputs.find((input) => input.name === 'offset0')?.required).toBe(false);
    expect(inputs.find((input) => input.name === 'item0')?.required).toBe(true);
  });

  it('参数默认值：数量型节点派生参数也写进默认表', () => {
    const spec = nodeSpec(NODE.assemble);
    if (spec === undefined) throw new Error('目录缺少 assemble');
    expect(defaultParams(spec)).toEqual({ count: 2, fill: 0x90, offset0: 0, offset1: 8 });
  });

  it('地址节点输出字节，整数节点输出字节，比较节点输出布尔', () => {
    expect(nodeOutput(nodeSpec(NODE.address) as never, {})).toEqual({ name: 'out', label: '结果', type: 'bytes' });
    expect(nodeOutput(nodeSpec(NODE.compare) as never, {})?.type).toBe('bool');
  });

  it('条件选值的端口类型跟着 type 参数走', () => {
    const spec = nodeSpec(NODE.select);
    if (spec === undefined) throw new Error('目录缺少 select');
    const bytesInputs = nodeInputs(spec, { type: 'bytes' }, CONTEXT);
    expect(bytesInputs.map((input) => `${input.name}:${input.type}`)).toEqual(['cond:bool', 'a:bytes', 'b:bytes']);
    const textInputs = nodeInputs(spec, { type: 'text' }, CONTEXT);
    expect(textInputs.find((input) => input.name === 'a')?.type).toBe('text');
    expect(nodeOutput(spec, { type: 'int' })?.type).toBe('int');
  });

  it('Python 节点由 portList 参数声明命名输入', () => {
    const spec = nodeSpec(NODE.python);
    if (spec === undefined) throw new Error('目录缺少 python');
    expect(pythonInputs({ inputs: ['a:int', 'b:bytes'] }).map((input) => `${input.name}:${input.type}`)).toEqual([
      'a:int',
      'b:bytes',
    ]);
    expect(nodeOutput(spec, { outputType: 'bool' })?.type).toBe('bool');
    // 非法的名字直接忽略（校验器会报参数问题，这里不做半套解析）。
    expect(pythonInputs({ inputs: ['Bad:int'] })).toEqual([]);
  });
});

describe('值的传输编码', () => {
  it('整数用十进制字符串，64 位地址不丢精度', () => {
    const value = (1n << 64n) - 1n;
    expect(encodeInt(value)).toEqual({ kind: 'int', value: '18446744073709551615' });
    expect(decodeInt(encodeInt(value))).toEqual({ ok: true, value });
  });

  it('负数与超长整数也走同一条无损通道', () => {
    expect(decodeInt({ kind: 'int', value: '-5' })).toEqual({ ok: true, value: -5n });
    expect(decodeInt({ kind: 'int', value: '01' }).ok).toBe(false);
    expect(decodeInt({ kind: 'text', text: 'x' }).ok).toBe(false);
  });

  it('摘要同时给十进制与十六进制，字节给长度与开头', () => {
    expect(encodedValueSummary({ kind: 'int', value: '64' })).toBe('64（0x40）');
    expect(encodedValueSummary({ kind: 'bool', value: false })).toBe('假');
    expect(encodedValueSummary({ kind: 'bytes', hex: '41414141' })).toBe('4 字节：41414141');
    expect(encodedValueSummary({ kind: 'bytes', hex: '' })).toBe('0 字节（空）');
  });
});

describe('图存档 Schema', () => {
  it('空图只有一个开始节点，且能被重新解析', () => {
    const document = emptyGraphDocument();
    expect(document.format).toBe(WORKFLOW_FORMAT);
    expect(document.version).toBe(WORKFLOW_VERSION);
    expect(document.nodes).toEqual([{ id: 'start', kind: 'start', params: {} }]);
    const parsed = parseGraphDocument(document);
    expect(parsed.ok).toBe(true);
  });

  it('版本不匹配时给出明确原因，而不是猜着读', () => {
    const parsed = parseGraphDocument({ ...emptyGraphDocument(), version: 99 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('99');
  });

  it('多出来的字段与非法 id 都会被拒绝（strictObject）', () => {
    const base = emptyGraphDocument();
    const extra = parseGraphDocument({ ...base, extra: true });
    expect(extra.ok).toBe(false);
    const badId = parseGraphDocument({
      ...base,
      nodes: [{ id: '有中文', kind: 'start', params: {} }],
    });
    expect(badId.ok).toBe(false);
  });

  it('参数允许字符串、数字与一组字符串', () => {
    const parsed = parseGraphDocument({
      format: WORKFLOW_FORMAT,
      version: WORKFLOW_VERSION,
      nodes: [
        { id: 'start', kind: 'start', params: {} },
        { id: 'py', kind: 'data.python', params: { inputs: ['a:int'], code: 'result = a', outputType: 'int' } },
      ],
      connections: [],
      main: ['py'],
      layout: {},
    });
    expect(parsed.ok).toBe(true);
  });
});

describe('定位序列工具（与 pwntools 对齐）', () => {
  it('小写字母的 de Bruijn 序列开头与 cyclic 一致', () => {
    expect(ALPHABETS.lower.length).toBe(26);
    expect(CYCLIC_SUBSEQUENCE_WIDTH).toBe(4);
    expect(cyclicSequence(ALPHABETS.lower, 16)).toBe('aaaabaaacaaadaaa');
    expect(deBruijnSequence(ALPHABETS.lower).length).toBe(26 ** 4);
  });

  it('大小写与数字字母表各自独立', () => {
    expect(cyclicSequence(ALPHABETS.upper, 8)).toBe('AAAABAAA');
    expect(cyclicSequence(ALPHABETS.digits, 16)).toBe('0000100020003000');
  });

  it('cyclic_find 的已知值：baaa → 4', () => {
    expect(cyclicFind(Uint8Array.from([0x62, 0x61, 0x61, 0x61]), ALPHABETS.lower)).toBe(4);
    expect(cyclicFind(Uint8Array.from([0x61, 0x61, 0x61, 0x61]), ALPHABETS.lower)).toBe(0);
  });

  it('跨接缝也能找到：序列是循环的', () => {
    const sequence = deBruijnSequence(ALPHABETS.lower);
    const tail = sequence.slice(sequence.length - 2) + sequence.slice(0, 2);
    const needle = Uint8Array.from([...tail].map((char) => char.charCodeAt(0)));
    expect(cyclicFind(needle, ALPHABETS.lower)).toBe(sequence.length - 2);
  });

  it('找不到时返回 undefined，而不是 -1', () => {
    // 字母表外的字节永远找不到（de Bruijn 序列只由字母表字符组成）。
    expect(cyclicFind(Uint8Array.from([0x30, 0x30, 0x30, 0x30]), ALPHABETS.lower)).toBeUndefined();
    expect(cyclicFind(new Uint8Array(), ALPHABETS.lower)).toBeUndefined();
  });
});
