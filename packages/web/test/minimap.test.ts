import { describe, expect, it } from 'vitest';
import type { canvas } from '@pwn2block/shared';
import { logicContentBounds, miniMapGeometry, miniMapPoint, miniMapViewportStyle } from '../src/canvas/minimap';

const graph = (nodes: readonly canvas.LogicNode[]): canvas.LogicGraph => ({ version: 1, nodes: [...nodes], edges: [] });

function constant(id: string, x: number, y: number): canvas.LogicNode {
  return { id, kind: 'constant', value: { type: 'int', text: '1' }, x, y };
}

describe('minimap geometry', () => {
  it('provides a stable empty-canvas extent', () => {
    expect(logicContentBounds(graph([]))).toEqual({ x: 0, y: 0, width: 640, height: 360 });
  });

  it('includes flow bend points outside node bounds', () => {
    const g = {
      ...graph([constant('a', 0, 0), constant('b', 100, 0)]),
      edges: [{ id: 'flow', kind: 'flow' as const, from: 'a', to: 'b', outlet: 'next' as const, points: [{ x: 900, y: 700 }] }],
    };
    const bounds = logicContentBounds(g);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(900);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(700);
  });

  it('contains every node with padding and maps the content origin to the map', () => {
    const g = graph([constant('a', 100, 50), constant('b', 700, 350)]);
    const bounds = logicContentBounds(g);
    expect(bounds.x).toBeLessThanOrEqual(100);
    expect(bounds.y).toBeLessThanOrEqual(50);
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(880);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(426);

    const geometry = miniMapGeometry(g, 500, 300, 200, 120, { x: 0, y: 0 }, 1);
    expect(miniMapPoint(geometry, { x: geometry.content.x, y: geometry.content.y })).toEqual({ x: 0, y: 0 });
  });

  it('uses a fixed quarter-size viewport handle and centers it on the visible stage', () => {
    const g = graph([constant('a', 0, 0)]);
    const geometry = miniMapGeometry(g, 400, 200, 200, 100, { x: -100, y: -40 }, 2);
    const viewport = miniMapViewportStyle(geometry);
    const center = miniMapPoint(geometry, { x: 150, y: 70 });
    expect(viewport.width).toBe(50);
    expect(viewport.height).toBe(25);
    expect(viewport.x + viewport.width / 2).toBeCloseTo(center.x);
    expect(viewport.y + viewport.height / 2).toBeCloseTo(center.y);
  });

  it('keeps the fixed viewport handle inside the minimap when the world extent grows', () => {
    const g = graph([constant('a', 0, 0)]);
    const geometry = miniMapGeometry(g, 400, 200, 200, 100, { x: -2400, y: -1400 }, 0.5);
    const viewport = miniMapViewportStyle(geometry);
    expect(viewport.x).toBeGreaterThanOrEqual(0);
    expect(viewport.y).toBeGreaterThanOrEqual(0);
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(200);
    expect(viewport.y + viewport.height).toBeLessThanOrEqual(100);
  });
});
