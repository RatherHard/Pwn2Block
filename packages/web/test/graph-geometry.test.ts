import { describe, expect, it } from 'vitest';
import { NODE } from '@pwn2block/shared';
import {
  HEADER_HEIGHT,
  NODE_WIDTH,
  PORT_ROW,
  boxContains,
  edgePath,
  fitViewport,
  hitTest,
  nodeBox,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type NodeBox,
} from '../src/graph/geometry';
import type { ParamValue, PortContext } from '@pwn2block/shared';
import { wfNode } from './workflow-helpers';

/**
 * 画布几何（06 §3）：节点尺寸、端口方位、正交走线、命中与视口变换。
 *
 * 端口方位是需求里的硬约束：数据端口在左右、控制流端口在上下；这里用坐标断言把它钉住。
 */

const CONTEXT: PortContext = { archBits: 64 };

function boxOf(kind: string, id = 'node', params?: Readonly<Record<string, ParamValue>>): NodeBox {
  const box = nodeBox(wfNode(id, kind, params), { x: 100, y: 50 }, { context: CONTEXT });
  if (box === undefined) throw new Error(`无法生成 ${kind} 的框`);
  return box;
}

describe('节点框与端口方位', () => {
  it('数据输入在左边缘、输出在右边缘', () => {
    const box = boxOf(NODE.concat, 'cat', { count: 2 });
    expect(box.inputs.map((port) => port.x)).toEqual([100, 100]);
    expect(box.outputs[0]?.x).toBe(100 + NODE_WIDTH);
    expect(box.inputs[0]?.y).toBe(50 + HEADER_HEIGHT + PORT_ROW / 2);
    expect(box.inputs[1]?.y).toBe(50 + HEADER_HEIGHT + PORT_ROW * 1.5);
  });

  it('执行节点有上下两个控制流端口，数据节点没有', () => {
    const write = boxOf(NODE.write, 'write');
    expect(write.execIn?.flow).toBe('exec');
    expect(write.execOut?.flow).toBe('exec');
    expect(write.execIn?.x).toBe(100 + NODE_WIDTH / 2);
    expect(write.execOut?.y).toBe(50 + write.height);

    const fill = boxOf(NODE.fill, 'fill');
    expect(fill.execIn).toBeUndefined();
    expect(fill.execOut).toBeUndefined();
  });

  it('端口多时框会变高，端口不会被压出框外', () => {
    const small = boxOf(NODE.fill, 'a');
    const big = boxOf(NODE.concat, 'b', { count: 4 });
    expect(big.height).toBeGreaterThan(small.height);
    for (const port of big.inputs) {
      expect(port.y).toBeLessThan(big.y + big.height);
      expect(port.y).toBeGreaterThan(big.y + HEADER_HEIGHT);
    }
  });

  it('错误节点带标记，选中状态传给渲染', () => {
    const box = nodeBox(wfNode('write', NODE.write), { x: 0, y: 0 }, {
      context: CONTEXT,
      selection: ['write'],
      errorNodes: ['write'],
    });
    expect(box?.selected).toBe(true);
    expect(box?.error).toBe(true);
  });
});

describe('走线与命中', () => {
  it('数据边走正交折线：先横后竖再横', () => {
    const box = boxOf(NODE.fill, 'fill');
    const target = boxOf(NODE.write, 'write');
    const path = edgePath(box.outputs[0] as never, target.inputs[0] as never);
    expect(path.startsWith('M ')).toBe(true);
    expect(path.split('L')).toHaveLength(4);
  });

  it('执行边纵向走，从上一个的下边到下一个的上边', () => {
    const first = boxOf(NODE.feed, 'feed');
    const second = boxOf(NODE.run, 'run');
    const path = edgePath(first.execOut as never, second.execIn as never);
    expect(path).toContain(`${first.execOut?.x}`);
    expect(path.split('L')).toHaveLength(4);
  });

  it('命中测试端口优先：边框附近的点先接到端口', () => {
    const box = boxOf(NODE.fill, 'fill');
    const port = box.outputs[0];
    expect(port).toBeDefined();
    const hit = hitTest([box], { x: port?.x ?? 0, y: port?.y ?? 0 });
    expect(hit?.port?.port).toBe('out');

    const inside = hitTest([box], { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    expect(inside?.nodeId).toBe('fill');
    expect(inside?.port).toBeUndefined();
    expect(hitTest([box], { x: box.x - 40, y: box.y - 40 })).toBeUndefined();
  });

  it('框内判定包含边界', () => {
    const box = boxOf(NODE.fill, 'fill');
    expect(boxContains(box, { x: box.x, y: box.y })).toBe(true);
    expect(boxContains(box, { x: box.x + box.width, y: box.y + box.height })).toBe(true);
    expect(boxContains(box, { x: box.x - 1, y: box.y })).toBe(false);
  });
});

describe('视口变换', () => {
  it('屏幕与世界坐标互为逆变换', () => {
    const viewport = { x: 60, y: -20, zoom: 1.5 };
    const world = { x: 133, y: 47 };
    const screen = worldToScreen(world, viewport);
    const back = screenToWorld(screen, viewport);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });

  it('以指针为锚点缩放：锚点在屏幕上的位置不变', () => {
    const viewport = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 200, y: 120 };
    const zoomed = zoomAt(viewport, anchor, -1);
    expect(zoomed.zoom).toBeGreaterThan(1);
    const worldBefore = screenToWorld(anchor, viewport);
    const screenAfter = worldToScreen(worldBefore, zoomed);
    expect(screenAfter.x).toBeCloseTo(anchor.x);
    expect(screenAfter.y).toBeCloseTo(anchor.y);
  });

  it('缩放有上下限，到达边界后不再变化', () => {
    let viewport = { x: 0, y: 0, zoom: 1 };
    for (let index = 0; index < 30; index += 1) viewport = zoomAt(viewport, { x: 0, y: 0 }, -1);
    expect(viewport.zoom).toBeLessThanOrEqual(2);
    const capped = zoomAt(viewport, { x: 0, y: 0 }, -1);
    expect(capped).toBe(viewport);
  });

  it('适应窗口把内容居中', () => {
    const boxes = [boxOf(NODE.fill, 'a'), boxOf(NODE.write, 'b')];
    const viewport = fitViewport(boxes, { width: 800, height: 600 });
    const minX = Math.min(...boxes.map((box) => box.x));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const center = (minX + maxX) / 2;
    expect(worldToScreen({ x: center, y: 0 }, viewport).x).toBeCloseTo(400, 0);
    expect(viewport.zoom).toBeLessThanOrEqual(2);
  });

  it('没有节点时不动视口', () => {
    expect(fitViewport([], { width: 800, height: 600 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
