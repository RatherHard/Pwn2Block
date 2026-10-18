import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import { createEditor, undo } from '../src/graph/editor';
import { exportDocument, importDocument } from '../src/graph/transfer';
import { wfEdge, wfNode, workflow } from './workflow-helpers';

/** 图的导出与导入（07 §P2/P3）：先校验再替换，失败时原图不动。 */

function editor() {
  return createEditor(
    workflow({
      nodes: [wfNode('hex', NODE.hex, { hex: '4142' }), wfNode('push', NODE.push)],
      edges: [wfEdge('hex', 'push', 'value')],
      main: ['push'],
    }),
  );
}

describe('图导入导出', () => {
  it('导出再导入得到同一份文档，且可撤销回原图', () => {
    const state = editor();
    const text = exportDocument(state.document);
    const other = createEditor(workflow({ nodes: [], edges: [], main: [] }));
    const result = importDocument(other, text);
    if (!result.ok) throw new Error(result.message);
    expect(result.state.document.nodes).toEqual(state.document.nodes);
    expect(result.state.document.connections).toEqual(state.document.connections);
    expect(result.state.document.main).toEqual(state.document.main);
    expect(undo(result.state).document.nodes.map((node) => node.id)).not.toContain('hex');
  });

  it('坏 JSON 只报原因，原图不变', () => {
    const state = editor();
    const result = importDocument(state, '{not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('JSON');
    expect(state.document.nodes.map((node) => node.id)).toContain('hex');
  });

  it('版本号不认识时拒绝并保留原图', () => {
    const state = editor();
    const raw = { ...state.document, version: 999 };
    const result = importDocument(state, JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('保留原图');
    expect(state.document.nodes.map((node) => node.id)).toContain('hex');
  });
});
