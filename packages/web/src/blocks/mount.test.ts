// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
import { compileProgram } from '../compiler/compile';
import { BLOCK_TYPES, FIELDS, MESSAGE_MULTIPLE_START_BLOCKS } from '../compiler/types';
import { BLOCK_MAX_INSTANCES, DEFAULT_VARIABLE_NAME, definePwn2BlockBlocks } from './definitions';
import { mountBlockly, type BlocklyBridge } from './mount';
import { toolboxBlockTypes } from './toolbox';

/**
 * 挂载桥（H01，05 §3.1）。
 *
 * 桥的契约有三条必须由**真实 Blockly**证明：真实画布能拼出可编译的程序、真实注入能接受工具箱、
 * 卸载之后宿主不留痕迹。默认 vitest 环境是 node，所以文件头指定 jsdom。
 */

const hosts: HTMLElement[] = [];
const bridges: BlocklyBridge[] = [];

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}

function mount(challenge = ret2winPublic): BlocklyBridge {
  const bridge = mountBlockly(makeHost(), challenge);
  bridges.push(bridge);
  return bridge;
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

/** Blockly 没有公开的高亮读取接口；这里读它自己记录高亮块的运行时数组（见 `highlightBlock` 实现）。 */
function highlightedIds(workspace: Blockly.WorkspaceSvg): readonly string[] {
  const internal = workspace as unknown as { readonly highlightedBlocks: readonly Blockly.Block[] };
  return internal.highlightedBlocks.map((block) => block.id);
}

describe('挂载桥：注入与卸载', () => {
  it('注入后宿主里有真实 Blockly 画布，卸载后清空', () => {
    const host = makeHost();
    const bridge = mountBlockly(host, ret2winPublic);
    bridges.push(bridge);
    expect(bridge.workspace).toBeInstanceOf(Blockly.WorkspaceSvg);
    expect(host.childElementCount).toBeGreaterThan(0);

    bridge.dispose();
    // 重复卸载安全。
    expect(() => bridge.dispose()).not.toThrow();
    expect(host.childElementCount).toBe(0);
  });

  it('配上了唯一开始块的容量约束', () => {
    expect(BLOCK_MAX_INSTANCES[BLOCK_TYPES.start]).toBe(1);
    const bridge = mount();
    expect(bridge.workspace.options.maxInstances).toEqual({ [BLOCK_TYPES.start]: 1 });
  });

  it('工具箱里的每个积木类型都有定义，且真实 Blockly 接受这份工具箱', () => {
    definePwn2BlockBlocks();
    const types = toolboxBlockTypes(ret2winPublic);
    expect(types.length).toBeGreaterThan(0);
    for (const type of types) {
      expect(Blockly.Blocks[type], `工具箱里的 ${type} 没有定义`).toBeDefined();
    }
    // `mount()` 内部就是拿这份工具箱去 inject 的：走到这里没抛错就说明 Blockly 认它。
    const bridge = mount();
    const toolbox = bridge.workspace.getToolbox();
    expect(toolbox).not.toBeNull();
    expect(toolbox?.getToolboxItems().length).toBeGreaterThan(0);
  });
});

describe('挂载桥：真实画布 → 归一化 → 编译', () => {
  it('拼出「开始 → step(1)」并编译出动作与来源表', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);

    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // step 的 count 来自影子积木的默认值 1（不是数字积木的 0）。
    expect(result.actions).toEqual([{ type: 'step', count: 1 }]);
    // 来源表把动作指回真实画布上的那块积木。
    expect(result.origins).toEqual([{ index: 0, blockId: step.id }]);
    expect(result.originsVersion).toBeGreaterThan(0);
  });

  it('变量字段归一到变量名而不是 id（编译契约要的是名字）', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    const set = workspace.newBlock(BLOCK_TYPES.varsSet);
    set.initSvg();
    const field = set.getField(FIELDS.variable) as Blockly.FieldVariable;
    // 真实 Blockly 的变量字段值是**生成的 id**，不是名字——这正是必须转换的原因。
    const id = field.getValue();
    expect(typeof id).toBe('string');
    expect(id).not.toBe(DEFAULT_VARIABLE_NAME);

    const block = bridge.normalize().blocks[0];
    expect(block?.fields[FIELDS.variable]).toBe(DEFAULT_VARIABLE_NAME);
    expect(block?.fields[FIELDS.variable]).not.toBe(id);
  });

  it('离散块不参与编译：没连到开始积木的链被忽略', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const step = workspace.newBlock(BLOCK_TYPES.actionStep);
    const next = start.nextConnection;
    const previous = step.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');

    // 单独放一块没接到开始积木上的 ret()。
    workspace.newBlock(BLOCK_TYPES.actionRet);
    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 只有开始积木自己（没有下一个）→ 没有动作；ret 那块不在链上，不出现。
    expect(result.actions).toEqual([]);
  });

  it('两个开始积木：容量判定先拦住工具箱，编译器兜住程序化创建', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    expect(workspace.remainingCapacityOfType(BLOCK_TYPES.start)).toBe(1);
    const first = workspace.newBlock(BLOCK_TYPES.start);
    expect(workspace.remainingCapacityOfType(BLOCK_TYPES.start)).toBe(0);
    // 工具箱拖出与粘贴走的就是这个判定（Blockly 在容量不足时把积木标成禁用）。
    expect(workspace.isCapacityAvailable({ [BLOCK_TYPES.start]: 1 })).toBe(false);

    // `newBlock` 是程序化创建，Blockly 不查容量——所以最终兜底是编译期错误。
    workspace.newBlock(BLOCK_TYPES.start);
    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message)).toEqual([
      MESSAGE_MULTIPLE_START_BLOCKS,
      MESSAGE_MULTIPLE_START_BLOCKS,
    ]);
    expect(result.errors.map((error) => error.blockId)).toContain(first.id);
  });
});

/** 合成事件：只保留桥真正读的字段（`type` 与 `isUiEvent`）。 */
function syntheticEvent(type: string, isUiEvent: boolean): Blockly.Events.Abstract {
  return { type, isUiEvent } as unknown as Blockly.Events.Abstract;
}

describe('挂载桥：编辑事件', () => {
  /**
   * 为什么直接喂事件而不是"在画布上真的改一下"：
   *
   * Blockly 只在**用户手势**（拖动、键盘、右键菜单）引发的改动上真正派发事件；
   * `workspace.newBlock()`、`connection.connect()`、`serialization.workspaces.load()`
   * 这些程序化路径要么根本不发，要么内部被 `Events.disable()` 包住（实测三个路径都是 0 次通知）。
   * jsdom 里没法可靠合成手势，所以这里把事件喂到桥的过滤点上，精确验证桥负责的三件事：
   * 过滤 UI-only、派发给订阅者、退订后不再派发。
   */
  it('订阅者收到模型事件，UI-only 事件被过滤掉', () => {
    // 预设：Blockly 的事件总开关是开的。它若为 false，桥在真实页面里也永远不会被通知——
    // 那是必须立刻发现的问题，所以在这里正面断言。
    expect(Blockly.Events.isEnabled()).toBe(true);

    const bridge = mount();
    const calls: string[] = [];
    bridge.onChange(() => calls.push('edit'));

    bridge.workspace.fireChangeListener(syntheticEvent('viewport_change', true));
    expect(calls).toHaveLength(0);

    bridge.workspace.fireChangeListener(syntheticEvent('create', false));
    expect(calls).toHaveLength(1);

    bridge.workspace.fireChangeListener(syntheticEvent('viewport_change', true));
    expect(calls).toHaveLength(1);
  });

  it('取消订阅后不再通知，且重复订阅同一个监听器只算一次', () => {
    const bridge = mount();
    let notified = 0;
    const listener = (): void => {
      notified += 1;
    };
    const unsubscribe = bridge.onChange(listener);
    bridge.onChange(listener);

    bridge.workspace.fireChangeListener(syntheticEvent('create', false));
    expect(notified).toBe(1);

    unsubscribe();
    bridge.workspace.fireChangeListener(syntheticEvent('create', false));
    expect(notified).toBe(1);
  });

  it('卸载之后不再通知，重复卸载安全', () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });
    bridge.dispose();
    expect(() => bridge.workspace.fireChangeListener(syntheticEvent('create', false))).not.toThrow();
    expect(notified).toBe(0);

    // 卸载后再订阅也不会被调用。
    bridge.onChange(() => {
      notified += 1;
    });
    bridge.workspace.fireChangeListener(syntheticEvent('create', false));
    expect(notified).toBe(0);
    expect(() => bridge.dispose()).not.toThrow();
  });
});

describe('挂载桥：错误定位', () => {
  it('高亮指定积木，传 undefined 清除，未知 id 不抛错', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    const block = workspace.newBlock(BLOCK_TYPES.actionRet);
    block.initSvg();
    expect(highlightedIds(workspace)).toEqual([]);

    bridge.highlight(block.id);
    expect(highlightedIds(workspace)).toEqual([block.id]);

    bridge.highlight('不存在的积木 id');
    expect(highlightedIds(workspace)).toEqual([]);

    bridge.highlight(block.id);
    bridge.highlight(undefined);
    expect(highlightedIds(workspace)).toEqual([]);
  });

  it('编译错误的 blockId 在真实画布上查得到，能被 highlight 定位（05 §4）', () => {
    const bridge = mount();
    const workspace = bridge.workspace;
    const start = workspace.newBlock(BLOCK_TYPES.start);
    const gets = workspace.newBlock('author_gets');
    gets.initSvg();
    const next = start.nextConnection;
    const previous = gets.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);

    // `data` 还没连：编译器必须报错，并且指到画布上这块积木。
    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const blockId = result.errors[0]?.blockId;
    expect(blockId).toBe(gets.id);
    // 高亮接口按同一个 id 就能定位：D 直接把 errors[].blockId 传进来即可。
    expect(workspace.getBlockById(blockId ?? '')).toBe(gets);
    bridge.highlight(blockId);
    expect(highlightedIds(workspace)).toEqual([gets.id]);
  });
});

describe('挂载桥：作者积木进画布', () => {
  it('出题人积木能进画布并带上题目声明的输入槽', () => {
    const bridge = mount();
    const gets = bridge.workspace.newBlock('author_gets');
    gets.initSvg();
    expect(gets.getInput('data')).toBeDefined();
    expect(gets.previousConnection).not.toBeNull();
    // 连到开始积木上以后，编译器认得这块出题人积木。
    const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
    const next = start.nextConnection;
    const previous = gets.previousConnection;
    if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
    next.connect(previous);

    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    // data 输入还空着：编译期必须报"缺输入"，而不是静默生成一个空 payload。
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.blockId).toBe(gets.id);
    expect(result.errors[0]?.message).toContain('data');
  });
});
