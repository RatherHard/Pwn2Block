// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { canvas, ret2winPublic } from '@pwn2block/shared';
import { CanvasPanelElement } from '../src/components/canvas-panel';
import type { LogicCanvasElement } from '../src/components/logic-canvas';

async function settleLayer(panel: CanvasPanelElement): Promise<void> {
  await panel.updateComplete;
  await panel.updateComplete;
  await panel.shadowRoot?.querySelector<LogicCanvasElement>('pwn2block-logic-canvas')?.updateComplete;
}

describe('logic layer UI', () => {
  it('moves a complete structure and records only layerOrder', async () => {
    const panel = new CanvasPanelElement();
    panel.challenge = ret2winPublic;
    document.body.append(panel);
    const doc = canvas.newLogicDocument();
    const graph: canvas.LogicGraph = {
      version: 1,
      nodes: [
        ...doc.logic!.nodes,
        { id: 'a', kind: 'constant', value: { type: 'int', text: '1' }, x: 40, y: 220 },
        { id: 'b', kind: 'constant', value: { type: 'int', text: '2' }, x: 280, y: 220 },
      ],
      edges: [],
    };
    panel.setDocument({ ...doc, logic: graph });
    await settleLayer(panel);
    const ui = panel.shadowRoot!.querySelector<LogicCanvasElement>('pwn2block-logic-canvas')!;
    const before = panel.document!.logic;
    ui.locate('a');
    await ui.updateComplete;
    const top = ui.shadowRoot!.querySelectorAll<HTMLButtonElement>('.layer-list-actions button')[2]!;
    top.click();
    await settleLayer(panel);
    expect(panel.document!.logic).toBe(before);
    expect(panel.document!.logicView?.layerOrder).toEqual(['start', 'b', 'a']);
    ui.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toolbar > button')[2]!.click();
    await settleLayer(panel);
    expect(panel.document!.logicView?.layerOrder).toEqual(['start']);
    ui.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toolbar > button')[3]!.click();
    await settleLayer(panel);
    expect(panel.document!.logicView?.layerOrder).toEqual(['start', 'b', 'a']);
    panel.remove();
  });
});


