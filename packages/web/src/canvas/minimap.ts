import type { canvas } from '@pwn2block/shared';
import { logicBox } from './logic-editor';

export interface MiniMapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MiniMapGeometry {
  content: MiniMapRect;
  viewport: MiniMapRect;
  map: MiniMapRect;
  scale: number;
}

const MIN_CONTENT_WIDTH = 640;
const MIN_CONTENT_HEIGHT = 360;
const PADDING = 24;

function unionRect(a: MiniMapRect, b: MiniMapRect): MiniMapRect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function logicContentBounds(graph: canvas.LogicGraph): MiniMapRect {
  const boxes = graph.nodes.map((node) => logicBox(graph, node.id));
  const bendPoints = graph.edges.flatMap((edge) => edge.kind === 'flow' ? edge.points ?? [] : []);
  const extents = [
    ...boxes,
    ...bendPoints.map((point) => ({ x: point.x, y: point.y, width: 0, height: 0 })),
  ];
  if (!extents.length) return { x: 0, y: 0, width: MIN_CONTENT_WIDTH, height: MIN_CONTENT_HEIGHT };
  const bounds = extents.reduce<MiniMapRect>((result, box) => unionRect(result, box), extents[0]!);
  const width = Math.max(MIN_CONTENT_WIDTH, bounds.width + PADDING * 2);
  const height = Math.max(MIN_CONTENT_HEIGHT, bounds.height + PADDING * 2);
  return {
    x: bounds.x - Math.max(PADDING, (width - bounds.width) / 2),
    y: bounds.y - Math.max(PADDING, (height - bounds.height) / 2),
    width,
    height,
  };
}

export function miniMapGeometry(
  graph: canvas.LogicGraph,
  stageWidth: number,
  stageHeight: number,
  mapWidth: number,
  mapHeight: number,
  viewOffset: { x: number; y: number },
  viewScale: number,
): MiniMapGeometry {
  const content = logicContentBounds(graph);
  const map = { x: 0, y: 0, width: mapWidth, height: mapHeight };
  const scale = Math.min(mapWidth / content.width, mapHeight / content.height);
  const viewport = {
    x: -viewOffset.x / viewScale,
    y: -viewOffset.y / viewScale,
    width: stageWidth / viewScale,
    height: stageHeight / viewScale,
  };
  return { content, viewport, map, scale };
}

export function miniMapPoint(geometry: MiniMapGeometry, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (point.x - geometry.content.x) * geometry.scale,
    y: (point.y - geometry.content.y) * geometry.scale,
  };
}

export function miniMapViewportStyle(geometry: MiniMapGeometry): MiniMapRect {
  const topLeft = miniMapPoint(geometry, geometry.viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: geometry.viewport.width * geometry.scale,
    height: geometry.viewport.height * geometry.scale,
  };
}

