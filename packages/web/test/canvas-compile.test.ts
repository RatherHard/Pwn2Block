import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import type { AuthorBlock } from '@pwn2block/shared';
import { compileCanvas, compileCanvasWithSteps } from '../src/canvas/compile';

/**
 * 新版画布 → `WorkflowArtifact` 的接缝测试（阶段二收尾，阶段三换画布的验收前提）。
 *
 * 断言只看产物语义：动作、来源、预览、轨迹、修订号，以及**失败不发布部分动作**。
 * 不比较整段中文文案，只断言「原文保留」与「问题定位到哪个节点」。
 */

/** 题目声明的一个方法：一个整数参数 `v`，展开成一条 `push`（展开由服务端做，这里只用于本地预检）。 */
const EMIT: AuthorBlock = {
  id: 'emit',
  label: 'emit(v)',
  params: [{ name: 'v', type: 'int' }],
  expand: [{ type: 'push', value: '$v' }],
};

// 局部构造器（不导出）：只写测试关心的字段，坐标一律空表。

function docOf(
  nodes: readonly canvas.CanvasNode[],
  main: readonly string[] = [],
): canvas.CanvasDocument {
  return { format: canvas.CANVAS_FORMAT, version: canvas.CANVAS_VERSION, nodes, layout: {}, main };
}

function intLit(id: string, value: number): canvas.CanvasNode {
  return { kind: 'value', id, value: { kind: 'int', value: String(value) } };
}

function start(id = 'start'): canvas.CanvasNode {
  return { kind: 'start', id };
}

function loop(id: string, count: string, body: readonly string[]): canvas.CanvasNode {
  return { kind: 'loop', id, count, body };
}

function callMethod(id: string, block: string, args: Readonly<Record<string, string>>): canvas.CanvasNode {
  return { kind: 'method', id, block, args };
}

function decl(id: string, name: string): canvas.CanvasNode {
  return { kind: 'var-decl', id, name, type: 'int', binding: { mode: 'none' } };
}

function ref(id: string, declId: string): canvas.CanvasNode {
  return { kind: 'var-ref', id, decl: declId };
}

function assign(id: string, target: string, value: string): canvas.CanvasNode {
  return { kind: 'assign', id, target, value };
}

describe('compileCanvas：成功路径', () => {
  it('空文档产出空产物，修订号原样抄入', () => {
    const document = canvas.emptyCanvasDocument();
    const result = compileCanvas({ document, documentRevision: 42 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.actions).toEqual([]);
    expect(result.artifact.origins).toEqual([]);
    expect(result.artifact.previews).toEqual([]);
    expect(result.artifact.trace).toEqual([]);
    expect(result.artifact.originsVersion).toBe(1);
    expect(result.artifact.documentRevision).toBe(42);
    expect(result.warnings).toEqual([]);
  });

  it('两轮循环各生成一条动作，来源带轮次并与动作下标对齐', () => {
    const document = docOf(
      [start(), intLit('two', 2), loop('loop1', 'two', ['emit1']), callMethod('emit1', 'emit', { v: 'two' })],
      ['start', 'loop1'],
    );
    const result = compileCanvasWithSteps({
      document,
      authorBlocks: [EMIT],
      documentRevision: 7,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.actions).toEqual([
      { type: 'block', id: 'emit', args: { v: '0x2' } },
      { type: 'block', id: 'emit', args: { v: '0x2' } },
    ]);
    expect(result.artifact.origins).toEqual([
      { index: 0, nodeId: 'emit1', path: ['main'], rounds: { loop1: 0 } },
      { index: 1, nodeId: 'emit1', path: ['main'], rounds: { loop1: 1 } },
    ]);
    expect(result.artifact.documentRevision).toBe(7);

    // 步骤表只在这里出现：产物里没有 `steps` 这个字段。
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.rounds['loop1']).toBe(0);
    expect(result.steps[1]?.rounds['loop1']).toBe(1);
    expect(result.steps[0]?.actionIndex).toBe(0);
    expect(Object.hasOwn(result.artifact, 'steps')).toBe(false);
  });

  it('轨迹按动作步骤逐条记录，超过 256 条即截断', () => {
    // 单个循环最多 256 轮（`CANVAS_MAX_LOOP_ITERATIONS`），所以用「每轮两条方法」凑到 512 步：
    // 300 轮那个写法在数据层就通不过单循环上限，压根到不了轨迹截断这一步。
    const document = docOf(
      [
        start(),
        intLit('many', 256),
        loop('loop1', 'many', ['emit1', 'emit2']),
        callMethod('emit1', 'emit', { v: 'many' }),
        callMethod('emit2', 'emit', { v: 'many' }),
      ],
      ['start', 'loop1'],
    );
    const result = compileCanvas({ document, authorBlocks: [EMIT], documentRevision: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.actions).toHaveLength(512);
    expect(result.artifact.trace).toHaveLength(256);
    expect(result.artifact.trace[0]).toEqual({
      nodeId: 'emit1',
      path: ['main'],
      message: '动作 block',
      rounds: { loop1: 0 },
    });
    // 截断只影响轨迹：来源表仍是逐条完整的。
    expect(result.artifact.origins).toHaveLength(512);
    expect(result.artifact.origins[511]?.rounds).toEqual({ loop1: 255 });
  });

  it('预览只收算得出来的值，依赖流程赋值的引用不给预览', () => {
    const document = docOf(
      [start(), intLit('lit', 7), decl('v', 'v'), ref('ref1', 'v'), assign('set-v', 'v', 'lit')],
      ['start', 'set-v'],
    );
    const result = compileCanvas({ document, documentRevision: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.previews).toEqual([
      { nodeId: 'lit', type: 'canvas', summary: '7（0x7）' },
    ]);
    expect(result.artifact.previews.some((preview) => preview.nodeId === 'ref1')).toBe(false);
  });

  it('算不出来的数据节点产出错误摘要，文案保留求值器的原文', () => {
    // 纯数据图（没有流程节点）：`main` 为空是合法的，不该因为「还没搭流程」而失败。
    const document = docOf([
      { kind: 'value', id: 'text', value: { kind: 'string', value: 'ab' } },
      intLit('far', 5),
      { kind: 'index', id: 'at', target: 'text', index: 'far' },
    ]);
    const result = compileCanvas({ document, documentRevision: 0 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const preview = result.artifact.previews.find((item) => item.nodeId === 'at');
    expect(preview?.type).toBe('canvas');
    expect(preview?.summary.startsWith('错误：')).toBe(true);
  });
});

describe('compileCanvas：失败路径', () => {
  it('循环次数为负：映射成 eval_failed 并定位到循环节点', () => {
    const document = docOf([start(), intLit('neg', -1), loop('loop1', 'neg', [])], ['start', 'loop1']);
    const result = compileCanvas({ document, documentRevision: 3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe('eval_failed');
    expect(result.issues[0]?.nodeId).toBe('loop1');
    expect(result.issues[0]?.severity).toBe('error');
    expect(result.issues[0]?.message).toContain('循环次数不能为负，收到 -1');
  });

  it('题库没声明的方法：只有一条 invalid 档的问题，不发布动作', () => {
    const document = docOf(
      [start(), callMethod('emit1', 'nope', {})],
      ['start', 'emit1'],
    );
    const result = compileCanvasWithSteps({ document, authorBlocks: [EMIT], documentRevision: 0 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.severity).toBe('error');
    expect(result.issues[0]?.code).toBe('eval_failed');
    expect(result.issues[0]?.nodeId).toBe('emit1');
    expect(result.issues[0]?.message).toContain('题目没有声明方法 nope');
  });
});
