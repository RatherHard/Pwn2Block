import type { canvas } from '@pwn2block/shared';

/**
 * 画布渲染视图模型的类型（需求 §6.1、阶段三「纯函数视图模型 → Lit 组件」）。
 *
 * 这一层不碰 DOM，只把 `CanvasDocument` 算成「要画什么」：坐标全是**图坐标**（与 `document.layout`
 * 同坐标系），渲染组件拿到的每个数字都能直接写进 SVG / CSS，不需要再回查文档。
 *
 * 三个边界：
 * - 选中与悬停只影响高亮，不影响几何；`CanvasLayoutInput.selection` 只是把它带进来，渲染层自己用。
 * - `boxes` 里只有节点、关系方框与包络框；端口小方框在 `ports`（数据输入）与 `flowPorts`
 *   （流程进/出）里单独给（`kind: 'port'` 留给渲染层统一绘制，视图模型不重复发）。
 * - `previews` / `issuesByNode` 是给框里那几行文字用的**已算好的一行摘要**，不在这里重新求值。
 */

/** 图坐标里的矩形：左上角 + 宽高。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 图坐标里的一点（连线端点、方框中心）。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * 盒子种类。
 *
 * - `node`：大白框（需求 §6.1），标题是种类名或名字；
 * - `relation`：运算/转换的**中小彩色方框**，只显示运算名或转换名；
 * - `group`：组合包络（成员并集 + 12）；
 * - `envelope`：转换包络（内部结构并集 + 16）；
 * - `port`：保留给渲染层把端口小方框与盒子统一绘制，本模型把端口放在 `ports` 里。
 */
export type CanvasBoxKind = 'node' | 'relation' | 'group' | 'envelope' | 'port';

/** 配色档：渲染层按它挑 CSS 类名，不按节点种类硬编码颜色。 */
export type CanvasBoxTone = 'data' | 'variable' | 'flow' | 'convert' | 'method';

/** 校验严重度；只有 error 把行与端口标红，warning 目前只作提示。 */
export type NodeSeverity = 'error' | 'warning';

/** 画布上的一个盒子。坐标与尺寸都是「图坐标」（与 `document.layout` 同坐标系）。 */
export interface CanvasBox {
  /** 盒子的稳定标识：`node:<id>` / `relation:<id>` / `group:<id>` / `envelope:<id>`，可直接做 DOM key。 */
  readonly id: string;
  readonly nodeId: string;
  readonly kind: CanvasBoxKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 主标题（白框里的大字）：种类名、变量名、运算名或转换名。 */
  readonly title: string;
  /** 第二行：类型、成员数、预览摘要等；没有就是 `undefined`。 */
  readonly subtitle?: string;
  readonly tone: CanvasBoxTone;
}

/** 节点内的一行（就地编辑与只读展示共用）。 */
export interface CanvasRow {
  readonly nodeId: string;
  /** 左侧中文标签，例如「名称」「地址」「起点」。 */
  readonly label: string;
  /** 右侧文本：字面值、变量名、方法参数，或「未接线」「待执行」这类状态。 */
  readonly value: string;
  /** 简单内容就地编辑；复杂配置（编码、字节序、转换参数）走侧栏。 */
  readonly editable: boolean;
  /** 该节点在 `validateCanvasDocument` 里有 error 时标红（问题定位是节点级的，不分端口）。 */
  readonly severity?: NodeSeverity;
}

/** 一个数据输入端口（端口小方框在节点外侧，坐标即连线端点）。 */
export interface CanvasPortView {
  readonly nodeId: string;
  /** 端口稳定名，来自共享层 `inputRefsOf`（与侧栏、校验器同一份）。 */
  readonly name: string;
  readonly label: string;
  /** 端口小方框中心（也是连线端点）：落在盒子边界外 `PORT_GAP` 处。 */
  readonly x: number;
  readonly y: number;
  readonly connected: boolean;
  readonly severity?: NodeSeverity;
}

/** 流程连接点的方向：`in` 在盒顶上方、`out` 在盒底下方（需求 §6.1「外置流程连接点」）。 */
export type FlowPortDirection = 'in' | 'out';

/**
 * 一个流程连接点：流程进/出也画成盒子**外侧**的小方框，连线端点就是它的中心。
 *
 * 与数据端口分开建模的理由：数据端口来自 `inputRefsOf`（可拉线、可断线），流程连接点是
 * **只读装饰**——它由节点在流程序列里的位置决定，用户不能拉线改顺序，只能拖动节点改流程。
 */
export interface CanvasFlowPortView {
  readonly nodeId: string;
  readonly direction: FlowPortDirection;
  /** 小方框中心（也是连线端点）：`out` 在盒底下方、`in` 在盒顶上方，各 `FLOW_PORT_GAP`。 */
  readonly x: number;
  readonly y: number;
  /**
   * 这一端是否真的有流程线接上：`in` = 它在某条序列里且不是该序列的第一个，
   * `out` = 它在某条序列里且不是该序列的最后一个。首/尾各有一端为 `false`，渲染层不画空端。
   */
  readonly connected: boolean;
}

/** 一条连线：数据依赖，或流程顺序。 */
export interface CanvasEdgeView {
  readonly from: { readonly nodeId: string; readonly x: number; readonly y: number };
  readonly to: { readonly nodeId: string; readonly x: number; readonly y: number };
  /**
   * 途经的关系方框：连线从它出来、或要进到它里面。`undefined` 表示两端都是大白框，
   * 渲染层按两点位置决定直线还是直角（来源在目标右侧时走直角）。
   */
  readonly viaRect: Rect | undefined;
  readonly kind: 'data' | 'flow';
}

/** 一次布局的完整结果：渲染层只需读它。 */
export interface CanvasLayoutView {
  /** 节点、关系方框、包络框，按绘制顺序（包络在前=画在最底层）。 */
  readonly boxes: readonly CanvasBox[];
  readonly rowsByNode: ReadonlyMap<string, readonly CanvasRow[]>;
  readonly ports: readonly CanvasPortView[];
  /** 流程连接点：出现在任何流程序列里的节点各一个 `in`、一个 `out`；未接线的那端由渲染层跳过。 */
  readonly flowPorts: readonly CanvasFlowPortView[];
  readonly edges: readonly CanvasEdgeView[];
  /** nodeId → 一行摘要（值、「待执行」或「错误：…」）。 */
  readonly previews: ReadonlyMap<string, string>;
  /** nodeId → 该节点的问题说明（按 code 去重后的前两条）。 */
  readonly issuesByNode: ReadonlyMap<string, readonly string[]>;
  /** 流程节点的序列归属，直接来自 `analyzeFlow`。 */
  readonly regionOf: ReadonlyMap<string, canvas.FlowRegionRef>;
}

/** `layoutCanvas` 的输入。 */
export interface CanvasLayoutInput {
  readonly document: canvas.CanvasDocument;
  /** 题目的方法目录：校验与预览要用（方法名、参数名与类型）。 */
  readonly methods?: readonly canvas.CanvasMethodDecl[];
  /** 选中与悬停只影响高亮，不影响几何；传进来让调用方决定怎么画。 */
  readonly selection?: readonly string[];
}
