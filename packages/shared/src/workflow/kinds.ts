/**
 * 节点种类标识（07 §P1「节点目录」）。
 *
 * 这些字符串写进存档、来源定位和错误信息，是**稳定契约**：改名等于破坏存档。
 * 单独放一个文件是因为目录本身按阶段拆成多份（基础/数据、控制与变量、模块），
 * 各处都要引用同一份标识，不能各自写字面量。
 */

export const NODE = {
  start: 'start',
  fill: 'data.fill',
  text: 'data.text',
  hex: 'data.hex',
  int: 'data.int',
  address: 'data.address',
  concat: 'data.concat',
  arith: 'data.arith',
  compare: 'data.compare',
  logic: 'data.logic',
  bytesToInt: 'data.bytesToInt',
  slice: 'data.slice',
  assemble: 'data.assemble',
  select: 'data.select',
  cyclic: 'data.cyclic',
  find: 'data.find',
  python: 'data.python',
  feed: 'action.feed',
  write: 'action.write',
  push: 'action.push',
  pop: 'action.pop',
  call: 'action.call',
  ret: 'action.ret',
  step: 'action.step',
  run: 'action.run',
  author: 'action.author',
  // 控制流与变量（06 §4.3、§5）
  if: 'control.if',
  repeat: 'control.repeat',
  while: 'control.while',
  break: 'control.break',
  continue: 'control.continue',
  result: 'control.result',
  index: 'control.index',
  accumulator: 'control.accumulator',
  varDeclare: 'var.declare',
  varGet: 'var.get',
  varSet: 'var.set',
  // 模块（06 §7）
  moduleData: 'module.data',
  moduleCall: 'module.call',
  moduleReturn: 'module.return',
} as const;

export type NodeKind = (typeof NODE)[keyof typeof NODE];

export const WORKFLOW_NODE_KINDS: readonly NodeKind[] = Object.values(NODE);
