import type { canvas } from '@pwn2block/shared';

/**
 * 阶段三新版画布的「节点目录」：**纯数据**的种类描述（需求 §2.2、§4、§5）。
 *
 * 目录只描述「有哪些节点、各有哪些数据输入、侧栏里能改哪些字段、内容画不画在框里」，
 * 不碰 DOM、不碰坐标、不碰求值。工具箱、侧栏、端口布局与连线提示都读同一份描述，
 * 各写一份必然漂移，而漂移的后果是「工具箱允许、校验器拒绝」这类互相打架的界面。
 *
 * 与语义层的分工：
 * - 端口类型来自 `shared/src/canvas/operators.ts` 的运算与转换目录，这里只做转述，不另写文案；
 * - 节点形状（`CanvasNode`）、默认值能否存档由 `schema.ts` 决定，目录的默认值必须能过它；
 * - 是否「还差什么」（未接线、空组合、类型不匹配）是 `validate.ts` 的事，目录不重复判断。
 */

/**
 * 工具箱里的分组。
 *
 * `value` / `collection` 的分界是「有没有内部结构」：一个字面值没有，组合、字典、
 * 下标、切片这些都在操作结构。`operator` 是关系/一元这种「贴在值上的运算」，
 * `convert` 单列是因为转换永远要显式经过，界面也单独给一组。
 */
export type CanvasNodeCategory = 'value' | 'operator' | 'collection' | 'convert' | 'variable' | 'flow' | 'method';

/** 一个数据输入端口。 */
export interface CanvasPortSpec {
  /** 端口的稳定名字（不随界面语言变）。来自 `inputRefsOf`：固定端口是属性名，成员类端口是「前缀 + 下标」。 */
  readonly name: string;
  /** 中文标签，端口悬停与侧栏显示。同样来自 `inputRefsOf`，目录不另写一份。 */
  readonly label: string;
  /** 接受的静态类型；`'any'` 表示不限制（列表元素、字典值、组合成员、方法参数）。 */
  readonly accepts: readonly canvas.ValueKind[] | 'any';
  /** 必填端口缺线时报错；可选端口（切片的开始/结束/步长）缺线只是「用默认值」。 */
  readonly required: boolean;
}

/** 下拉类字段的一个候选项：值写进节点属性，标签给界面显示。 */
export interface CanvasFieldOption {
  readonly value: string;
  readonly label: string;
}

/** 侧栏里可编辑的字段。`editor` 决定用哪种控件。 */
export type CanvasFieldEditor =
  | 'text'
  | 'int'
  | 'hex-bytes'
  | 'bool'
  | 'select'
  | 'relation-op'
  | 'unary-op'
  | 'convert'
  | 'group-mode'
  | 'variable-type'
  | 'binding-mode'
  | 'method'
  | 'decl-ref';

/**
 * 一个侧栏字段。
 *
 * `key` 与节点上的**属性同名**，界面按它读写节点；嵌套结构（转换参数、变量绑定）只给
 * 外层属性一个字段，细节由对应编辑器（`convert` / `binding-mode`）自己处理。
 */
export interface CanvasFieldSpec {
  readonly key: string;
  readonly label: string;
  readonly editor: CanvasFieldEditor;
  /** 下拉类字段的候选值；`select`/`relation-op` 等可以留空由界面自己算。 */
  readonly options?: readonly CanvasFieldOption[];
}

/** 十八种节点各一份种类描述。 */
export interface CanvasNodeSpec {
  readonly kind: canvas.CanvasNodeKind;
  /** 中文节点名（种类级，不随 op 变；具体运算名见 `relationLabelOf`）。 */
  readonly label: string;
  readonly category: CanvasNodeCategory;
  /** 一句话说明，用于工具箱与悬停。 */
  readonly description: string;
  /**
   * 数据输入，顺序与 `portsOf(createNode(kind, id))` 一致。
   *
   * 种类级端口取**默认实例**的端口：关系是默认运算、转换是默认参数、组合与方法是空成员，
   * 所以这里不写「某个 op 的端口」，那是实例级 `portsOf(node)` 的事。
   */
  readonly ports: readonly CanvasPortSpec[];
  readonly fields: readonly CanvasFieldSpec[];
  /** `true` = 内容直接画在节点里（字面值、运算符、摘要、变量名）；`false` = 只有标题与端口。 */
  readonly inline: boolean;
}

/**
 * 目录里手写的部分：端口不在这里写。
 *
 * 端口名与标签的唯一来源是 `shared/canvas/document.ts` 的 `inputRefsOf`（画布、校验器、求值器
 * 都读那一份），目录只补「这个端口吃什么类型」。所以 `ports` 由 `catalog.ts` 按默认实例装配，
 * 手写的话就会多出第二份端口名，两边一漂移界面就接不上线。
 */
export type CanvasNodeSpecBase = Omit<CanvasNodeSpec, 'ports'>;
