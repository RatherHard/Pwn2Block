import { canvas } from '@pwn2block/shared';
import type { CanvasFieldOption, CanvasNodeCategory, CanvasNodeSpecBase } from './catalog-types';

/**
 * 目录的**数据部分**：选项表、默认值、十八个种类描述。
 *
 * 顺序就是工具箱顺序，同一分类连续排：**值 → 集合（组合/字典/下标/按键/切片/重复）→ 运算
 * （关系/一元）→ 转换 → 变量 → 流程 → 方法**。先给「怎么造值、怎么拼结构」，再给「怎么算、
 * 怎么转」，最后是变量与流程；`method` 自成一组放在最后。这条顺序只影响工具箱列表，
 * 与 `CANVAS_NODE_KINDS` 的枚举顺序无关（那个顺序管存档与遍历）。
 *
 * 这里**没有端口**：端口名与标签的唯一来源是共享层的 `inputRefsOf`，目录只补类型，
 * 所以 `ports` 在 `catalog.ts` 里按默认实例装配（见 `CanvasNodeSpecBase` 的注释）。
 */

// ---------------------------------------------------------------------------
// 值种类与默认值
// ---------------------------------------------------------------------------

/**
 * 字面值能切换的种类。
 *
 * 只有标量：列表由组合产生、字典由字典节点产生（需求 §2.1），所以「往字面值里塞列表」既不是
 * 存档形状、也不是界面该给的选择。变量声明的类型选择另用 `VARIABLE_TYPE_OPTIONS`。
 */
export const VALUE_KIND_OPTIONS: readonly { readonly value: canvas.ScalarKind; readonly label: string }[] =
  canvas.SCALAR_VALUE_KINDS.map((kind) => ({ value: kind, label: canvas.VALUE_KIND_LABELS[kind] }));

/** 变量声明的类型：可以是任意值种类，初值由组合或字典节点提供。 */
const VARIABLE_TYPE_OPTIONS: readonly { readonly value: canvas.ValueKind; readonly label: string }[] =
  canvas.VALUE_KINDS.map((kind) => ({ value: kind, label: canvas.VALUE_KIND_LABELS[kind] }));

/** 组合模式：合并为串要求成员同类型，组成列表不要求。 */
const GROUP_MODE_OPTIONS: readonly CanvasFieldOption[] = canvas.GROUP_MODES.map((mode) => ({
  value: mode,
  label: canvas.GROUP_MODE_LABELS[mode],
}));

/** 变量的初始化关系（需求 §3.1–3.2）：不初始化允许存在，真正读取时才报错。 */
const BINDING_MODE_OPTIONS: readonly CanvasFieldOption[] = [
  { value: 'none', label: '未初始化' },
  { value: 'initial', label: '初始值' },
  { value: 'derived', label: '派生绑定' },
];

/**
 * 转换节点的默认参数：4 字节小端无符号。
 *
 * 选它是因为 CTF 里最常见的两个动作——把整数写成栈上的地址、把整数直接送上栈——
 * 都是 4 字节小端；宽度与端序在侧栏可改，默认值只负责「刚拖出来就能接」。
 */
export const DEFAULT_CONVERSION: canvas.ConversionSpec = {
  kind: 'int-to-bytes',
  width: 4,
  endian: 'little',
  signed: false,
};

/**
 * 某一种值种类的最小字面量：切换字面值种类时用它，**不保留上一类的载荷**。
 *
 * 列表与字典不是字面值（`EncodedScalarValue` 里没有它们），传进来就是调用方的 bug；
 * 这里显式抛错而不是悄悄退回整数 0——静默改数据比崩溃更难查。
 */
export function defaultEncodedValue(kind: canvas.ValueKind): canvas.EncodedScalarValue {
  switch (kind) {
    case 'byte':
      return { kind: 'byte', hex: '' };
    case 'int':
      return { kind: 'int', value: '0' };
    case 'double':
      return { kind: 'double', value: 0 };
    case 'string':
      return { kind: 'string', value: '' };
    case 'bool':
      return { kind: 'bool', value: false };
    case 'list':
    case 'dict':
      throw new Error(`${canvas.VALUE_KIND_LABELS[kind]}不是字面值，字面值节点承载不了它`);
  }
}

/** 工具箱分组的中文名。 */
export const CANVAS_CATEGORY_LABELS: Readonly<Record<CanvasNodeCategory, string>> = {
  value: '值',
  operator: '运算',
  collection: '集合',
  convert: '转换',
  variable: '变量',
  flow: '流程',
  method: '方法',
};

// ---------------------------------------------------------------------------
// 十八个种类
// ---------------------------------------------------------------------------

/**
 * 目录顺序即工具箱顺序；`ports` 由 `catalog.ts` 按默认实例装配。
 *
 * `inline` 的判据是「框里还有没有内容」：字面值、运算符、转换摘要、组合成员、变量名要画，
 * 只有端口和标题的不画。侧栏字段只列**真要在侧栏改**的：字面值在框里直接编辑、切片参数是端口，
 * 都不进侧栏（需求 §6.1「简单内容节点内编辑，编码/字节序进侧栏」）。
 */
export const CANVAS_SPEC_BASES: readonly CanvasNodeSpecBase[] = [
  {
    kind: 'value',
    label: canvas.CANVAS_NODE_KIND_LABELS.value,
    category: 'value',
    description: '直接写一个标量：字节串、整数、浮点数、文本或布尔',
    // 字面值在框里直接编辑；切换种类用 `VALUE_KIND_OPTIONS` + `defaultEncodedValue`。
    fields: [],
    inline: true,
  },
  {
    kind: 'group',
    label: canvas.CANVAS_NODE_KIND_LABELS.group,
    category: 'collection',
    description: '把几个值按行列摆在一起，合并为串或组成列表',
    fields: [{ key: 'mode', label: '组合模式', editor: 'group-mode', options: GROUP_MODE_OPTIONS }],
    inline: true,
  },
  {
    kind: 'dict',
    label: canvas.CANVAS_NODE_KIND_LABELS.dict,
    category: 'collection',
    description: '按键存放若干个值；键是字面量，值接别的节点',
    fields: [],
    inline: true,
  },
  {
    kind: 'index',
    label: canvas.CANVAS_NODE_KIND_LABELS.index,
    category: 'collection',
    description: '按下标取出列表、字节串或文本里的一项',
    fields: [],
    inline: false,
  },
  {
    kind: 'lookup',
    label: canvas.CANVAS_NODE_KIND_LABELS.lookup,
    category: 'collection',
    description: '按键从字典里取出对应的值；键不存在时求值失败',
    fields: [],
    inline: false,
  },
  {
    kind: 'slice',
    label: canvas.CANVAS_NODE_KIND_LABELS.slice,
    category: 'collection',
    description: '按开始、结束与步长截取一段，三段都可以省略',
    // 三段是可选**端口**而不是侧栏参数：省略即默认，接上就是表达式（需求 §2.3）。
    fields: [],
    inline: false,
  },
  {
    kind: 'repeat',
    label: canvas.CANVAS_NODE_KIND_LABELS.repeat,
    category: 'collection',
    description: '把列表、字节串或文本按次数重复',
    fields: [],
    inline: false,
  },
  {
    kind: 'relation',
    label: canvas.CANVAS_NODE_KIND_LABELS.relation,
    category: 'operator',
    description: '两个值之间的二元运算：算术、位运算、比较或布尔',
    // 具体运算名随 op 变，用 `relationLabelOf`；这里只给「换运算」这一个控件。
    fields: [{ key: 'op', label: '运算', editor: 'relation-op' }],
    inline: true,
  },
  {
    kind: 'unary',
    label: canvas.CANVAS_NODE_KIND_LABELS.unary,
    category: 'operator',
    description: '对一个值取反或取长度',
    fields: [{ key: 'op', label: '操作', editor: 'unary-op' }],
    inline: true,
  },
  {
    kind: 'convert',
    label: canvas.CANVAS_NODE_KIND_LABELS.convert,
    category: 'convert',
    description: '在文本、字节串、整数、浮点数与列表之间显式转换，参数在侧栏设置',
    // 转换种类与参数是一个嵌套结构，整块交给 `convert` 编辑器；具体名用 `convertLabelOf`。
    fields: [{ key: 'spec', label: '转换', editor: 'convert' }],
    inline: true,
  },
  {
    kind: 'var-decl',
    label: canvas.CANVAS_NODE_KIND_LABELS['var-decl'],
    category: 'variable',
    description: '声明一个变量并固定类型；可选初始值或派生绑定',
    fields: [
      { key: 'name', label: '变量名', editor: 'text' },
      { key: 'type', label: '类型', editor: 'variable-type', options: VARIABLE_TYPE_OPTIONS },
      { key: 'binding', label: '初始化', editor: 'binding-mode', options: BINDING_MODE_OPTIONS },
    ],
    inline: true,
  },
  {
    kind: 'var-ref',
    label: canvas.CANVAS_NODE_KIND_LABELS['var-ref'],
    category: 'variable',
    description: '读取变量当前的值；重命名由声明同步',
    fields: [{ key: 'decl', label: '变量', editor: 'decl-ref' }],
    inline: true,
  },
  {
    kind: 'loop-index',
    label: canvas.CANVAS_NODE_KIND_LABELS['loop-index'],
    category: 'variable',
    description: '循环体内的只读索引，从 0 开始，只在所属循环里可用',
    // 指向循环节点而不是变量声明，但目录里只有 `decl-ref` 这一种「选一个已存在的节点」控件。
    fields: [{ key: 'loop', label: '所属循环', editor: 'decl-ref' }],
    inline: false,
  },
  {
    kind: 'start',
    label: canvas.CANVAS_NODE_KIND_LABELS.start,
    category: 'flow',
    description: '流程入口：整个画布只有一个，且必须排在最前面',
    fields: [],
    inline: false,
  },
  {
    kind: 'if',
    label: canvas.CANVAS_NODE_KIND_LABELS.if,
    category: 'flow',
    description: '按布尔条件二选一执行，两条分支各自顺序执行',
    // 两条区域是节点的子序列，不是数据输入也不是侧栏字段：在画布上拖。
    fields: [],
    inline: false,
  },
  {
    kind: 'loop',
    label: canvas.CANVAS_NODE_KIND_LABELS.loop,
    category: 'flow',
    description: '按次数重复执行一段流程，次数在进入时读一次',
    fields: [],
    inline: false,
  },
  {
    kind: 'assign',
    label: canvas.CANVAS_NODE_KIND_LABELS.assign,
    category: 'flow',
    description: '流程走到这一步时给变量赋一次值',
    fields: [{ key: 'target', label: '目标变量', editor: 'decl-ref' }],
    inline: false,
  },
  {
    kind: 'method',
    label: canvas.CANVAS_NODE_KIND_LABELS.method,
    category: 'method',
    description: '调用题目声明的方法：参数在这里固定成动作，展开仍由服务端完成',
    fields: [{ key: 'block', label: '方法', editor: 'method' }],
    inline: false,
  },
];
