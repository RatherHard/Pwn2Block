import { describe, expect, it } from 'vitest';

import { canvas } from '@pwn2block/shared';

import {
  addNode,
  connect,
  createVariable,
  setAssignTarget,
  setValue,
} from '../src/canvas/editor';

/**
 * `assign` 的写入目标是变量声明，不是数据节点，所以它不走 `connect`。
 * 这一组用例锁住：选变量、改选、清空、以及「目标必须真的是声明」。
 */

function emptyDocument(): canvas.CanvasDocument {
  return {
    format: canvas.CANVAS_FORMAT,
    version: canvas.CANVAS_VERSION,
    nodes: [],
    layout: {},
    main: [],
  };
}

function withAssignAndVariable(): canvas.CanvasDocument {
  const declared = createVariable(emptyDocument(), 'v', 'total', 'int');
  expect(declared.issues).toEqual([]);
  const added = addNode(declared.document, 'assign', 'a', { x: 200, y: 0 });
  expect(added.issues).toEqual([]);
  const literal = addNode(added.document, 'value', 'one', { x: 200, y: 120 });
  expect(literal.issues).toEqual([]);
  return literal.document;
}

describe('setAssignTarget', () => {
  it('选中变量声明之后，赋值节点不再报未接线', () => {
    const edited = setAssignTarget(withAssignAndVariable(), 'a', 'v');
    expect(edited.issues).toEqual([]);

    const issues = canvas.validateCanvasDocument(edited.document).issues;
    // `a` 还没放进任何序列，所以另有 flow_error；这里只关心「未接线」这一条消失没有。
    expect(issues.filter((issue) => issue.nodeId === 'a').map((issue) => issue.code)).toContain('unconnected');

    const literal = setValue(edited.document, 'one', { kind: 'int', value: '1' });
    expect(literal.issues).toEqual([]);
    const connected = connect(literal.document, 'a', 'value', 'one');
    expect(connected.issues).toEqual([]);
    const result = canvas.validateCanvasDocument(connected.document);
    expect(result.issues.filter((issue) => issue.nodeId === 'a').map((issue) => issue.code)).not.toContain(
      'unconnected',
    );
  });

  it('改选另一个声明会替换旧目标', () => {
    const first = setAssignTarget(withAssignAndVariable(), 'a', 'v');
    const second = createVariable(first.document, 'w', 'other', 'int');
    const retarget = setAssignTarget(second.document, 'a', 'w');

    const node = retarget.document.nodes.find((candidate) => candidate.id === 'a');
    expect(node).toEqual({ kind: 'assign', id: 'a', target: 'w', value: canvas.UNCONNECTED });
  });

  it('写空串表示还没选变量，不报错但会被校验挡住', () => {
    const edited = setAssignTarget(withAssignAndVariable(), 'a', canvas.UNCONNECTED);
    expect(edited.issues).toEqual([]);
    const codes = canvas
      .validateCanvasDocument(edited.document)
      .issues.filter((issue) => issue.nodeId === 'a')
      .map((issue) => issue.code);
    expect(codes).toContain('unconnected');
  });

  it('目标不是变量声明时明确拒绝', () => {
    const document = withAssignAndVariable();
    const edited = setAssignTarget(document, 'a', 'one');
    expect(edited.issues[0]?.code).toBe('variable_error');
    expect(edited.document).toBe(document);
  });

  it('节点不存在或不是赋值节点时明确拒绝', () => {
    const document = withAssignAndVariable();
    expect(setAssignTarget(document, 'nope', 'v').issues[0]?.code).toBe('unknown_node');
    expect(setAssignTarget(document, 'v', 'v').issues[0]?.code).toBe('unknown_kind');
  });
});
