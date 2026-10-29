import { structureLayout } from './view-model-structure';
import { canvas } from '@pwn2block/shared';
import { type NodeDeck, resolveBoxLayout } from './view-model-boxes';
import { buildDataEdges, buildFlowEdges, buildFlowPorts, buildPorts } from './view-model-edges';
import { buildEnvelopeBoxes } from './view-model-envelope';
import { buildIssueIndex, buildPreviewMap, buildPreviewSummaries } from './view-model-preview';
import { rowsOfNode, subtitleOfNode, titleOfNode, withSeverity } from './view-model-rows';
import type { CanvasLayoutInput, CanvasLayoutView, CanvasRow } from './view-model-types';

/**
 * 新版画布的渲染视图模型（需求 §6.1、§7；阶段三「纯函数视图模型 → Lit 组件」）。
 *
 * 只做一件事：`CanvasDocument` → `CanvasLayoutView`。没有 DOM、没有时间、没有随机数，所以同一个输入
 * 两次调用必然完全相等（测试锁住这一点）。渲染组件不再自己算坐标：位置、尺寸、端口、连线、预览与问题
 * 全部从这里取，组件的职责只剩「把盒子画出来、把事件写回文档」。
 *
 * 几何知识的分布：
 * - 尺寸与端口常量、网格兜底 → `view-model-geometry.ts`；
 * - 大白框 / 关系方框的区分、标题、行、配色 → `view-model-rows.ts`；
 * - 盒子位置（含关系方框的递归中点） → `view-model-boxes.ts`；
 * - 包络（组合 +12、转换 +16） → `view-model-envelope.ts`；
 * - 端口、数据边、流程边、流程连接点 → `view-model-edges.ts`；
 * - 预览与问题分组 → `view-model-preview.ts`。
 *
 * 绘制顺序：包络在前（画在最底层），然后大白框，最后关系方框（压在连线上方）。
 */
export * from './view-model-types';
export {
  ENVELOPE_PADDING,
  FLOW_PORT_GAP,
  GROUP_PADDING,
  NODE_MIN_HEIGHT,
  NODE_MIN_WIDTH,
  NODE_ROW_HEIGHT,
  PORT_FIRST_Y,
  PORT_GAP,
  PORT_STEP,
  nodeBoxSize,
  rectOfNode,
  relationBoxSize,
} from './view-model-geometry';

/** 把文档算成一整张视图；`selection` 只影响渲染层高亮，不参与几何，所以这里不读它。 */
export function layoutCanvas(input: CanvasLayoutInput): CanvasLayoutView {
  const document = input.document;
  const nodes = canvas.nodeMapOf(document);
  const previewMap = buildPreviewMap(document);
  const previews = buildPreviewSummaries(previewMap);
  const issues = buildIssueIndex(document, input.methods);
  const rowsContext = { nodes, methods: input.methods, previews: previewMap };

  const rowsByNode = new Map<string, readonly CanvasRow[]>();
  const decks = new Map<string, NodeDeck>();
  for (const node of nodes.values()) {
    const severity = issues.severityOf(node.id);
    rowsByNode.set(node.id, withSeverity(rowsOfNode(node, rowsContext), severity));
    decks.set(node.id, { title: titleOfNode(node, rowsContext), subtitle: subtitleOfNode(node, rowsContext) });
  }

  const rawLayout = resolveBoxLayout(document, nodes, rowsByNode, decks);
  const rawEnvelopes = buildEnvelopeBoxes(document, nodes, (nodeId) => rawLayout.rectOf.get(nodeId));
  const { layout, envelopes } = structureLayout(nodes, rawLayout, rawEnvelopes);

  return {
    boxes: [...envelopes, ...layout.nodeBoxes, ...layout.relationBoxes],
    rowsByNode,
    ports: buildPorts(nodes, layout, issues.severityOf),
    flowPorts: buildFlowPorts(document, layout),
    edges: [...buildDataEdges(nodes, layout), ...buildFlowEdges(document, nodes, layout)],
    previews,
    issuesByNode: issues.issuesByNode,
    regionOf: canvas.analyzeFlow(document, { methods: input.methods }).regionOf,
  };
}
