import { expandBlock, type Action } from '../actions';
import { bytesToHex, formatHex, MAX_UINT64 } from '../hex';
import {
  CANVAS_MAX_ACTIONS,
  CANVAS_MAX_LOOP_ITERATIONS,
  CANVAS_MAX_TOTAL_ITERATIONS,
  CANVAS_MAX_STEP_SNAPSHOTS,
} from '../limits';
import type { CanvasGenerateOptions, CanvasGenerateResult, CanvasStep } from './actions';
import { canvasMethodsOf } from './methods';
import { errorIssue } from './issues';
import {
  logicCategory,
  logicIsFlow,
  logicMembers,
  type LogicEdge,
  type LogicGraph,
  type LogicNode,
} from './logic-model';
import { validateLogicGraph } from './logic-validate';
import { LogicFault, logicBinary, logicConvert, logicLiteral } from './logic-values';
import type { Value } from './value';
export { validateLogicGraph } from './logic-validate';

type DataEdge = Extract<LogicEdge, { kind: 'data' }>;
const EXPRESSION_PRECEDENCE: Readonly<Record<string, number>> = {
  or: 10,
  and: 20,
  '==': 30,
  '!=': 30,
  '<': 35,
  '<=': 35,
  '>': 35,
  '>=': 35,
  '|': 40,
  '^': 50,
  '&': 60,
  '<<': 70,
  '>>': 70,
  '+': 80,
  '-': 80,
  '*': 90,
  '/': 90,
  '%': 90,
};


/** Interpret the graph once. The only output sent to the server remains public block actions. */
class LogicRuntime {
  readonly actions: Action[] = [];
  readonly steps: CanvasStep[] = [];
  readonly values = new Map<string, Value>();
  readonly types = new Map<string, Value['kind']>();
  readonly definitions = new Map<string, DataEdge>();
  readonly derived = new Set<string>();
  readonly reading = new Set<string>();
  readonly evaluating = new Set<string>();
  readonly reached = new Set<string>();
  readonly rounds: Record<string, number> = {};
  private iterations = 0;
  private evaluations = 0;
  private mutationRevision = 0;
  private readonly derivedRevision = new Map<string, number>();
  private readonly nodes: Map<string, LogicNode>;
  constructor(
    readonly graph: LogicGraph,
    readonly options: CanvasGenerateOptions = {},
  ) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  }
  node(id: string): LogicNode {
    const node = this.nodes.get(id);
    if (!node) throw new LogicFault(id, '连接的节点不存在');
    return node;
  }
  private variableName(id: string): string {
    const node = this.node(id);
    if (node.kind !== 'variable') throw new LogicFault(id, '赋值目标必须是变量');
    return node.name.trim();
  }
  private reach(id: string): void {
    if (this.reached.has(id)) return;
    this.reached.add(id);
    const node = this.node(id);
    if (node.kind === 'envelope') for (const member of node.members) this.reach(member);
    if (node.kind === 'loop' && node.body) this.reach(node.body);
    for (const edge of this.graph.edges) if (edge.kind === 'flow' && edge.from === id) this.reach(edge.to);
  }
  initialize(): void {
    const start = this.graph.nodes.find((n) => n.kind === 'start');
    if (start) this.reach(start.id);
    for (const edge of this.graph.edges) {
      if (edge.kind !== 'data' || edge.op !== 'assign' || this.reached.has(edge.to)) continue;
      const name = this.variableName(edge.to);
      if (this.definitions.has(name)) throw new LogicFault(edge.to, `变量 ${name} 有多个全局定义`);
      this.definitions.set(name, edge);
      if (this.dependencies(edge.from).size > 0) this.derived.add(name);
    }
    for (const name of this.definitions.keys()) this.read(name, this.definitions.get(name)!.to);
    // Reject writes to derived globals even if the offending branch is not taken.
    for (const edge of this.graph.edges)
      if (
        edge.kind === 'data' &&
        edge.op === 'assign' &&
        this.reached.has(edge.to) &&
        this.derived.has(this.variableName(edge.to))
      )
        throw new LogicFault(edge.to, `派生变量 ${this.variableName(edge.to)} 只读，不能再次赋值`);
  }
  private dependencies(id: string, seen = new Set<string>()): Set<string> {
    const names = new Set<string>();
    if (seen.has(id)) return names;
    seen.add(id);
    const node = this.node(id);
    if (node.kind === 'variable') names.add(node.name.trim());
    const inputs: string[] = [];
    if (node.kind === 'envelope') inputs.push(...node.members);
    if (node.kind === 'convert' && node.input) inputs.push(node.input);
    for (const edge of this.graph.edges)
      if (edge.kind === 'data' && edge.to === id && edge.op !== 'assign') inputs.push(edge.from);
    for (const input of inputs) for (const name of this.dependencies(input, seen)) names.add(name);
    return names;
  }
  private read(name: string, id: string): Value {
    if (this.reading.has(name)) throw new LogicFault(id, `变量依赖不允许成环：${name}`);
    const cached = this.values.get(name);
    if (cached && (!this.derived.has(name) || this.derivedRevision.get(name) === this.mutationRevision)) return cached;
    const definition = this.definitions.get(name);
    if (!definition) throw new LogicFault(id, `变量 ${name} 在第一次赋值前不能读取`);
    this.reading.add(name);
    try {
      const value = this.evaluate(definition.from);
      this.store(name, value, id);
      return value;
    } finally {
      this.reading.delete(name);
    }
  }
  private store(name: string, value: Value, id: string): void {
    const type = this.types.get(name);
    if (type && type !== value.kind)
      throw new LogicFault(id, `变量 ${name} 首次赋值为 ${type}，不能改为 ${value.kind}`);
    this.types.set(name, value.kind);
    this.values.set(name, value);
    if (this.derived.has(name)) this.derivedRevision.set(name, this.mutationRevision);
    else this.mutationRevision++;
  }
  evaluate(id: string): Value {
    if (++this.evaluations > 200000) throw new LogicFault(id, '表达式求值超过预算');
    if (this.evaluating.has(id)) throw new LogicFault(id, '数据连接或变量依赖不允许成环');
    this.evaluating.add(id);
    try {
      const chain = this.expressionChain(id);
      const values = chain.ids.map((operand) => this.evaluateAtom(operand));
      const operands = [values[0]!];
      const operators: DataEdge[] = [];
      const reduce = (): void => {
        const operator = operators.pop();
        const right = operands.pop();
        const left = operands.pop();
        if (!operator || right === undefined || left === undefined) throw new LogicFault(id, '表达式求值缺少操作数');
        operands.push(logicBinary(operator.op, left, right, operator.id));
      };
      for (let index = 0; index < chain.edges.length; index++) {
        const edge = chain.edges[index]!;
        while (
          operators.length &&
          (EXPRESSION_PRECEDENCE[operators.at(-1)!.op] ?? 0) >= (EXPRESSION_PRECEDENCE[edge.op] ?? 0)
        )
          reduce();
        operators.push(edge);
        operands.push(values[index + 1]!);
      }
      while (operators.length) reduce();
      const result = operands[0];
      if (result === undefined) throw new LogicFault(id, '表达式求值缺少结果');
      return result;
    } finally {
      this.evaluating.delete(id);
    }
  }
  /** 收集以 id 为末端的数据连接链，再按 C/Python 风格优先级归约。 */
  private expressionChain(id: string): { ids: string[]; edges: DataEdge[] } {
    const ids = [id];
    const edges: DataEdge[] = [];
    const seen = new Set<string>();
    let current = id;
    while (true) {
      if (seen.has(current)) throw new LogicFault(current, '数据连接或变量依赖不允许成环');
      seen.add(current);
      const incoming = this.graph.edges.find(
        (edge): edge is DataEdge => edge.kind === 'data' && edge.to === current && edge.op !== 'assign',
      );
      if (!incoming) break;
      edges.unshift(incoming);
      ids.unshift(incoming.from);
      current = incoming.from;
    }
    return { ids, edges };
  }
  private evaluateAtom(id: string): Value {
    const node = this.node(id);
    if (node.kind === 'constant') return logicLiteral(node.value, id);
    if (node.kind === 'variable') return this.read(node.name.trim(), id);
    if (node.kind === 'convert')
      return node.input ? this.evaluate(node.input) : logicConvert(logicLiteral(node.value, id), node);
    if (node.kind === 'envelope' && node.category === 'data') {
      const sinks = node.members.filter(
        (member) =>
          !this.graph.edges.some((edge) => edge.kind === 'data' && edge.from === member && node.members.includes(edge.to)),
      );
      if (sinks.length !== 1) throw new LogicFault(id, '数据包络需要一个表达式结果；请连接内部节点');
      let result = this.evaluate(sinks[0]!);
      const conversion = this.graph.nodes.find((node) => node.kind === 'convert' && node.input === id);
      if (conversion?.kind === 'convert') result = logicConvert(result, conversion);
      return result;
    }
    throw new LogicFault(id, '该节点不产生数据');
  }
  private reference(id: string, port: string): Value {
    const edge = this.graph.edges.find((e) => e.kind === 'reference' && e.to === id && e.port === port);
    if (!edge) throw new LogicFault(id, `请连接 ${port} 引用`);
    return this.evaluate(edge.from);
  }
  private snapshot(id: string, kind: 'assign' | 'action', inputs: { name: string; value: Value }[]): void {
    if (this.steps.length >= CANVAS_MAX_STEP_SNAPSHOTS) throw new LogicFault(id, '执行步骤超过预算');
    // Recompute derived fields after each mutation, including values not consumed by a method.
    for (const name of this.derived) this.read(name, id);
    this.steps.push({
      step: this.steps.length,
      nodeId: id,
      kind,
      actionIndex: kind === 'action' ? this.actions.length - 1 : null,
      rounds: { ...this.rounds },
      inputs,
      variables: [...this.values].map(([name, value]) => ({ name, value })),
    });
  }
  private assignments(id: string): void {
    const node = this.node(id);
    if (node.kind !== 'envelope') return;
    // 保留直接子包络作为执行单元，让嵌套包络的附着循环仍然生效。
    const assignmentEdges = (members: Set<string>): DataEdge[] =>
      this.graph.edges.filter((e): e is DataEdge => e.kind === 'data' && e.op === 'assign' && members.has(e.to));
    const units: { id: string; writes: Set<string>; reads: Set<string>; run: () => void }[] = [];
    for (const member of node.members) {
      const child = this.node(member);
      if (child.kind !== 'envelope') continue;
      const members = logicMembers(this.graph, member);
      const edges = assignmentEdges(members);
      if (!edges.length) continue;
      const reads = new Set(edges.flatMap((e) => [...this.dependencies(e.from)]));
      // 次数引用同样属于执行依赖：先完成外层对次数变量的赋值，再进入内层循环。
      const loops = new Set(
        this.graph.nodes.filter((n) => n.kind === 'loop' && n.body && members.has(n.body)).map((n) => n.id),
      );
      for (const edge of this.graph.edges)
        if (edge.kind === 'reference' && edge.port === 'count' && loops.has(edge.to))
          for (const name of this.dependencies(edge.from)) reads.add(name);
      units.push({
        id: member,
        writes: new Set(edges.map((e) => this.variableName(e.to))),
        reads,
        run: () => this.envelope(child),
      });
    }
    for (const edge of assignmentEdges(new Set(node.members))) {
      const name = this.variableName(edge.to);
      units.push({
        id: edge.id,
        writes: new Set([name]),
        reads: this.dependencies(edge.from),
        run: () => {
          if (this.derived.has(name)) throw new LogicFault(edge.to, `派生变量 ${name} 只读`);
          const value = this.evaluate(edge.from);
          this.store(name, value, edge.to);
          this.snapshot(id, 'assign', [{ name, value }]);
        },
      });
    }
    const done = new Set<string>();
    const execute = (unit: (typeof units)[number], active = new Set<string>()): void => {
      if (done.has(unit.id)) return;
      if (active.has(unit.id)) throw new LogicFault(unit.id, '包络赋值依赖不允许成环');
      active.add(unit.id);
      for (const other of units)
        if (other !== unit && [...other.writes].some((name) => unit.reads.has(name))) execute(other, active);
      unit.run();
      active.delete(unit.id);
      done.add(unit.id);
    };
    for (const unit of units) execute(unit);
  }
  private envelope(node: Extract<LogicNode, { kind: 'envelope' }>): void {
    const attached = this.graph.nodes.find((n) => n.kind === 'loop' && n.body === node.id);
    const run = (): void => {
      if (node.category === 'data') {
        this.assignments(node.id);
        return;
      }
      const flows = node.members.filter((id) => {
        const child = this.node(id);
        return logicIsFlow(this.graph, child) && !(child.kind === 'loop' && child.body);
      });
      const entries = flows.filter(
        (id) => !this.graph.edges.some((e) => e.kind === 'flow' && e.to === id && flows.includes(e.from)),
      );
      if (entries.length !== 1) throw new LogicFault(node.id, '流程包络内部需要一条有唯一入口的流程');
      this.walk(entries[0]!);
    };
    if (attached?.kind === 'loop') this.loop(attached, run);
    else run();
  }
  private loop(node: Extract<LogicNode, { kind: 'loop' }>, run: () => void): void {
    const count = this.graph.edges.some((e) => e.kind === 'reference' && e.to === node.id && e.port === 'count')
      ? this.reference(node.id, 'count')
      : logicLiteral({ type: 'int', text: node.count }, node.id);
    if (count.kind !== 'int' || count.value < 0n || count.value > BigInt(CANVAS_MAX_LOOP_ITERATIONS))
      throw new LogicFault(node.id, `循环次数必须为 0–${CANVAS_MAX_LOOP_ITERATIONS} 的 int`);
    for (let round = 0; round < Number(count.value); round++) {
      if (++this.iterations > CANVAS_MAX_TOTAL_ITERATIONS) throw new LogicFault(node.id, '累计循环次数超过预算');
      this.rounds[node.id] = round;
      run();
    }
    delete this.rounds[node.id];
  }
  private method(node: Extract<LogicNode, { kind: 'method' }>): void {
    const methods = this.options.methods ?? canvasMethodsOf(this.options.challenge ?? {});
    const method = methods.find((m) => m.id === node.method);
    if (!method) throw new LogicFault(node.id, '题目未提供该方法');
    const args: Record<string, string> = {};
    const inputs: { name: string; value: Value }[] = [];
    for (const param of method.params) {
      const value = this.reference(node.id, param.name);
      inputs.push({ name: param.name, value });
      if (param.type === 'bytes' && value.kind === 'byte') args[param.name] = bytesToHex(value.bytes);
      else if (
        param.type !== 'bytes' &&
        value.kind === 'int' &&
        value.value >= 0n &&
        (param.type !== 'addr' || value.value <= MAX_UINT64)
      )
        args[param.name] = formatHex(value.value);
      else throw new LogicFault(node.id, `参数 ${param.name} 需要 ${param.type}，收到 ${value.kind}`);
    }
    if (
      this.graph.edges.some(
        (e) => e.kind === 'reference' && e.to === node.id && !method.params.some((p) => p.name === e.port),
      )
    )
      throw new LogicFault(node.id, '方法存在未知参数引用');
    if (this.actions.length >= (this.options.maxActions ?? CANVAS_MAX_ACTIONS))
      throw new LogicFault(node.id, '动作数超过预算');
    const action = { type: 'block' as const, id: node.method, args };
    if (this.options.challenge?.authorBlocks) {
      const expanded = expandBlock({ authorBlocks: this.options.challenge.authorBlocks }, action);
      if (!expanded.ok) throw new LogicFault(node.id, `方法参数无法展开：${expanded.detail}`);
    }
    this.actions.push(action);
    this.snapshot(node.id, 'action', inputs);
  }
  walk(first: string): void {
    let id: string | undefined = first;
    const seen = new Set<string>();
    while (id) {
      if (seen.has(id)) throw new LogicFault(id, '流程不允许成环');
      seen.add(id);
      const node = this.node(id);
      let outlet = 'next';
      if (node.kind === 'branch') {
        const value = this.reference(id, 'condition');
        if (value.kind !== 'bool') throw new LogicFault(id, '条件引用需要 bool');
        outlet = value.value ? 'then' : 'else';
      } else if (node.kind === 'method') this.method(node);
      else if (node.kind === 'envelope') this.envelope(node);
      else if (node.kind === 'loop') throw new LogicFault(id, '请将次数循环附着在流程包络上');
      id = this.graph.edges.find((e) => e.kind === 'flow' && e.from === id && e.outlet === outlet)?.to;
    }
  }
}

export function generateLogicActions(graph: LogicGraph, options: CanvasGenerateOptions = {}): CanvasGenerateResult {
  const issues = validateLogicGraph(graph);
  if (issues.length) return { ok: false, issues };
  const state = new LogicRuntime(graph, options);
  try {
    state.initialize();
    const start = graph.nodes.find((n) => n.kind === 'start')!;
    state.walk(start.id);
    return { ok: true, sequence: { actions: state.actions, steps: state.steps } };
  } catch (error) {
    if (!(error instanceof LogicFault)) throw error;
    return { ok: false, issues: [errorIssue('eval_failed', error.nodeId, error.message)] };
  }
}
export function previewLogicGraph(graph: LogicGraph): ReadonlyMap<string, Value | string> {
  const result = new Map<string, Value | string>();
  if (validateLogicGraph(graph).length) return result;
  const state = new LogicRuntime(graph);
  try {
    state.initialize();
  } catch (error) {
    if (!(error instanceof LogicFault)) throw error;
    result.set(error.nodeId, error.message);
  }
  for (const node of graph.nodes)
    if (logicCategory(node) === 'data') {
      try {
        result.set(node.id, state.evaluate(node.id));
      } catch (error) {
        if (!(error instanceof LogicFault)) throw error;
        result.set(node.id, error.message);
      }
    }
  return result;
}
