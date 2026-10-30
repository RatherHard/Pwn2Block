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
  it('does not expose manual layer controls in the toolbar', async () => {
    const panel = new CanvasPanelElement();
    panel.challenge = ret2winPublic;
    document.body.append(panel);
    const doc = canvas.newLogicDocument();
    panel.setDocument(doc);
    await settleLayer(panel);
    const ui = panel.shadowRoot!.querySelector<LogicCanvasElement>('pwn2block-logic-canvas')!;
    expect(ui.shadowRoot!.querySelector('.layer-list')).toBeNull();
    expect(ui.shadowRoot!.querySelector('.layer-list-actions')).toBeNull();
    expect(ui.shadowRoot!.querySelector('.toolbar')?.textContent).not.toContain('图层');
    panel.remove();
  });
});
