import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { compileGraph } from '../src/workflow/compile';
import type { WorkflowArtifact, WorkflowContext } from '../src/workflow/types';
import { WORKFLOW_CONTEXT, wfEdge, wfNode, workflow } from './workflow-helpers';

/**
 * 图编译（06 §2、§4.1；07 §P2 验证项）：同样的图得到同样的动作，失败时不发布部分产物。
 *
 * 断言精确到动作与字节，不做「包含某字段」的模糊判断——payload 的字节错了，判题就会失败。
 */

async function compile(
  document: ReturnType<typeof workflow>,
  context: WorkflowContext = WORKFLOW_CONTEXT,
  revision = 1,
): Promise<ReturnType<typeof compileGraph> extends Promise<infer T> ? T : never> {
  return compileGraph({ document, context, documentRevision: revision });
}

function artifactOf(outcome: Awaited<ReturnType<typeof compileGraph>>): WorkflowArtifact {
  if (!outcome.ok) throw new Error(`编译失败：${outcome.issues.map((issue) => issue.message).join('; ')}`);
  return outcome.artifact;
}

function basicPayloadGraph(): ReturnType<typeof workflow> {
  return workflow({
    nodes: [
      wfNode('fill', NODE.fill, { byte: 0x41, count: 4 }),
      wfNode('addr', NODE.address, { value: 0x400000 }),
      wfNode('cat', NODE.concat, { count: 2 }),
      wfNode('write', NODE.write, { addr: 0x400100 }),
      wfNode('run', NODE.run, { maxSteps: 100 }),
    ],
    edges: [
      wfEdge('fill', 'cat', 'item0'),
      wfEdge('addr', 'cat', 'item1'),
      wfEdge('cat', 'write', 'data'),
    ],
    main: ['fill', 'addr', 'cat', 'write', 'run'],
  });
}

describe('编译：基础题完整路径', () => {
  it('填充 + 地址 + 拼接 → 一条 write_bytes 与一条 run', async () => {
    const outcome = await compile(basicPayloadGraph());
    const artifact = artifactOf(outcome);
    expect(artifact.actions).toEqual([
      { type: 'write_bytes', addr: '0x400100', hex: '414141410000400000000000' },
      { type: 'run', maxSteps: 100 },
    ]);
    expect(artifact.origins).toEqual([
      { index: 0, nodeId: 'write', path: ['main'] },
      { index: 1, nodeId: 'run', path: ['main'] },
    ]);
    expect(artifact.originsVersion).toBe(1);
    expect(artifact.documentRevision).toBe(1);
  });

  it('地址按题目位宽小端编码：0x400000 → 0000400000000000', async () => {
    const outcome = await compile(basicPayloadGraph());
    const address = artifactOf(outcome).previews.find((preview) => preview.nodeId === 'addr');
    expect(address?.type).toBe('bytes');
    expect(address?.hex).toBe('0000400000000000');
    expect(address?.length).toBe(8);
  });

  it('拼接预览给出每段的来源、偏移与长度', async () => {
    const outcome = await compile(basicPayloadGraph());
    const concat = artifactOf(outcome).previews.find((preview) => preview.nodeId === 'cat');
    expect(concat?.segments).toEqual([
      { port: 'item0', offset: 0, length: 4 },
      { port: 'item1', offset: 4, length: 8 },
    ]);
    expect(concat?.hex).toBe('414141410000400000000000');
  });

  it('输入数据与执行指令是两个动作，顺序就是画布顺序', async () => {
    const document = workflow({
      nodes: [
        wfNode('hex', NODE.hex, { hex: 'cafebabe' }),
        wfNode('feed', NODE.feed),
        wfNode('step', NODE.step, { count: 3 }),
      ],
      edges: [wfEdge('hex', 'feed', 'data')],
      main: ['feed', 'step'],
    });
    const artifact = artifactOf(await compile(document));
    expect(artifact.actions).toEqual([
      { type: 'feed', hex: 'cafebabe' },
      { type: 'step', count: 3 },
    ]);
  });

  it('编译失败时不发布任何动作', async () => {
    const document = workflow({
      nodes: [wfNode('write', NODE.write, { addr: 0x401000 })],
      edges: [],
      main: ['write'],
    });
    const outcome = await compile(document);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.map((issue) => issue.code)).toContain('missing_input');
    expect('artifact' in outcome).toBe(false);
  });
});

describe('编译：数据节点规则', () => {
  it('整数编码支持大端与 32 位宽，溢出时报错而不是截断', async () => {
    const document = workflow({
      nodes: [
        wfNode('int', NODE.int, { width: 4, endian: 'big', value: 0x400000 }),
        wfNode('write', NODE.write, { addr: 0x401000 }),
      ],
      edges: [wfEdge('int', 'write', 'data')],
      main: ['int', 'write'],
    });
    const artifact = artifactOf(await compile(document));
    expect(artifact.actions[0]).toEqual({ type: 'write_bytes', addr: '0x401000', hex: '00400000' });

    const overflow = workflow({
      nodes: [wfNode('bad', NODE.int, { width: 1, value: 0x100 })],
      edges: [],
      main: ['bad'],
    });
    const outcome = await compile(overflow);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.nodeId).toBe('bad');
    expect(outcome.issues[0]?.message).toContain('放不进 1 字节');
  });

  it('文本按编码转换，Latin-1 越界时报错', async () => {
    const ok = workflow({
      nodes: [
        wfNode('text', NODE.text, { text: 'A中', encoding: 'utf-8' }),
        wfNode('feed', NODE.feed),
      ],
      edges: [wfEdge('text', 'feed', 'data')],
      main: ['feed'],
    });
    expect(artifactOf(await compile(ok)).actions[0]).toEqual({ type: 'feed', hex: '41e4b8ad' });

    const bad = workflow({
      nodes: [wfNode('text', NODE.text, { text: '中', encoding: 'latin1' })],
      edges: [],
      main: ['text'],
    });
    const outcome = await compile(bad);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe('eval_failed');
    expect(outcome.issues[0]?.message).toContain('latin1');
  });

  it('字节转整数按位宽检查长度，长度不符时明确报错', async () => {
    const bytes = wfNode('bytes', NODE.hex, { hex: '4142' });
    const decode = wfNode('decode', NODE.bytesToInt, { width: 4 });
    const document = workflow({
      nodes: [bytes, decode],
      edges: [wfEdge('bytes', 'decode', 'bytes')],
      main: ['decode'],
    });
    const outcome = await compile(document);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.nodeId).toBe('decode');
    expect(outcome.issues[0]?.message).toContain('字节长度 2 与位宽 4 不一致');
  });

  it('截取越界时报出偏移、长度与总长度', async () => {
    const document = workflow({
      nodes: [wfNode('bytes', NODE.hex, { hex: '4142' }), wfNode('slice', NODE.slice, { offset: 1, length: 4 })],
      edges: [wfEdge('bytes', 'slice', 'bytes')],
      main: ['slice'],
    });
    const outcome = await compile(document);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toContain('偏移 1 + 长度 4 超过字节长度 2');
  });

  it('按偏移组装：空隙填 fill，重叠时报错', async () => {
    const assembled = workflow({
      nodes: [
        wfNode('a', NODE.hex, { hex: '4141' }),
        wfNode('b', NODE.hex, { hex: '4242' }),
        wfNode('asm', NODE.assemble, { count: 2, fill: 0x90, offset0: 0, offset1: 4 }),
        wfNode('write', NODE.write),
      ],
      edges: [wfEdge('a', 'asm', 'item0'), wfEdge('b', 'asm', 'item1'), wfEdge('asm', 'write', 'data')],
      main: ['a', 'b', 'asm', 'write'],
    });
    expect(artifactOf(await compile(assembled)).actions[0]).toEqual({
      type: 'write_bytes',
      addr: '0x0',
      hex: '414190904242',
    });

    const overlap = workflow({
      nodes: [
        wfNode('a', NODE.hex, { hex: '41414141' }),
        wfNode('b', NODE.hex, { hex: '4242' }),
        wfNode('asm', NODE.assemble, { count: 2, offset0: 0, offset1: 2 }),
      ],
      edges: [wfEdge('a', 'asm', 'item0'), wfEdge('b', 'asm', 'item1')],
      main: ['asm'],
    });
    const outcome = await compile(overlap);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toContain('重叠');
  });

  it('条件选值只求值被选中的候选值（未选中分支即使会报错也不执行）', async () => {
    const document = workflow({
      nodes: [
        wfNode('cmp', NODE.compare, { op: 'EQ', a: 1, b: 1 }),
        wfNode('left', NODE.hex, { hex: 'aaaa' }),
        // 2 字节里取 8 字节：真被求值就会报「越界」。
        wfNode('short', NODE.hex, { hex: 'bb' }),
        wfNode('right', NODE.slice, { offset: 0, length: 8 }),
        wfNode('pick', NODE.select, { type: 'bytes' }),
        wfNode('write', NODE.write),
      ],
      edges: [
        wfEdge('cmp', 'pick', 'cond'),
        wfEdge('left', 'pick', 'a'),
        wfEdge('short', 'right', 'bytes'),
        wfEdge('right', 'pick', 'b'),
        wfEdge('pick', 'write', 'data'),
      ],
      main: ['cmp', 'left', 'pick', 'write'],
    });
    const artifact = artifactOf(await compile(document));
    expect(artifact.actions[0]).toEqual({ type: 'write_bytes', addr: '0x0', hex: 'aaaa' });
  });
});

describe('编译：出题人积木与取消', () => {
  const gets: AuthorBlock = {
    id: 'gets',
    label: '溢出输入',
    params: [{ name: 'data', type: 'bytes' }],
    expand: [{ type: 'feed', hex: '$data' }],
  };

  it('出题人积木只发 {id, args}，展开仍归服务端', async () => {
    const document = workflow({
      nodes: [
        wfNode('hex', NODE.hex, { hex: '41414141' }),
        wfNode('author', NODE.author, { id: 'gets' }),
      ],
      edges: [wfEdge('hex', 'author', 'data')],
      main: ['author'],
    });
    const artifact = artifactOf(
      await compile(document, { ...WORKFLOW_CONTEXT, authorBlocks: [gets] }),
    );
    expect(artifact.actions).toEqual([{ type: 'block', id: 'gets', args: { data: '41414141' } }]);
  });

  it('取消信号在编译前生效时返回 cancelled，不发布产物', async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await compileGraph({
      document: basicPayloadGraph(),
      context: WORKFLOW_CONTEXT,
      documentRevision: 1,
      signal: controller.signal,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.code).toBe('cancelled');
  });
});
