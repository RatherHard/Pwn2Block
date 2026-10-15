// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
import { createArtifactTracker } from '../compiler/artifact';
import { compileProgram } from '../compiler/compile';
import { blockIdForAction } from '../compiler/locate';
import type { NormalizedWorkspace } from '../compiler/types';
import { BLOCK_TYPES, INPUTS, MESSAGE_MULTIPLE_START_BLOCKS } from '../compiler/types';
import { mountBlockly, type BlocklyBridge, type SerializedWorkspace } from './mount';

/**
 * 程序化装载与「编辑后重编译」的通知（05 §3.1 实现备忘、09 §3.2）。
 *
 * 这一层的风险全在**通知**上，而 H01 文件头里那句"程序化改动根本不派发事件"**是错的**：
 * D4 用真实 Blockly 13.4 实测（等到延迟事件全部落地——一帧/几个宏任务，本文件等 100ms）：
 *
 * | 操作 | 通知 |
 * |---|---|
 * | `workspace.newBlock()` + `connect()` | 同步 0；延迟 **4** 条（3×create + 1×move，实测） |
 * | `serialization.workspaces.load()` | 同步 0；延迟 **2** 条（实测，随画布状态变化） |
 * | `workspace.clear()` + `load()` | 同步 0；延迟 **2–7** 条（实测） |
 * | `bridge.loadProgram()` | 同步 **1**，等满 100ms 仍然只有 1（本文件钉住） |
 *
 * 也就是说：程序化改动的通知**同步一定没有、但一定会迟到**，条数还不确定。
 * 于是两个后果——① 靠 `onChange` 接线时"装载存档"既不能指望同步重编译，也不该被迟到事件
 * 反复触发；② `loadProgram()` 必须把装载那一段的事件摁掉，再主动通知一次，
 * 让"一次装载 = 一次重编译"成为确定行为（而不是运气）。
 *
 * 所以本文件钉三件事：
 * 1. 程序化路径的真实通知行为（同步 0 / 延迟成批），证据来自真实 Blockly；
 * 2. `loadProgram()` 恒定一次通知，且压制不会把事件系统留在关闭态；
 * 3. `loadProgram()` 的通知能直接驱动"标过期 + 重编译"，且产物对应装载后的程序。
 */

const hosts: HTMLElement[] = [];
const bridges: BlocklyBridge[] = [];

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  hosts.push(host);
  return host;
}

function mount(): BlocklyBridge {
  const bridge = mountBlockly(makeHost(), ret2winPublic);
  bridges.push(bridge);
  return bridge;
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const host of hosts.splice(0)) host.remove();
});

/**
 * 等延迟事件全部落地：Blockly 把程序化改动的事件排在队列里，下一帧/几个宏任务才送到监听器。
 * 只等"一个宏任务"会漏（D4 踩过：单跑绿、全量跑红），所以这里等满 100ms。
 */
async function settleEvents(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 在临时画布上搭一份程序并序列化：比手写 Blockly JSON 更不容易和它的格式漂移。 */
function saveState(build: (workspace: Blockly.WorkspaceSvg) => void): SerializedWorkspace {
  const bridge = mount();
  build(bridge.workspace);
  return Blockly.serialization.workspaces.save(bridge.workspace);
}

interface BuiltStep {
  readonly state: SerializedWorkspace;
  /** 真实 Blockly 生成的 step 积木 id（序列化会带上它，装载后仍然是同一个）。 */
  readonly stepId: string;
}

/** 把 `step` 接到 `start` 下面：连接为 null 说明积木定义坏了，显式抛而不是静默跳过。 */
function connect(start: Blockly.BlockSvg, step: Blockly.BlockSvg): void {
  const next = start.nextConnection;
  const previous = step.previousConnection;
  if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
  next.connect(previous);
}

/** 「开始 → step（count 默认 1）」：连好之后把状态与真实 id 一起交出来。 */
function stepState(): BuiltStep {
  const bridge = mount();
  const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
  const step = bridge.workspace.newBlock(BLOCK_TYPES.actionStep);
  step.initSvg();
  connect(start, step);
  return { state: Blockly.serialization.workspaces.save(bridge.workspace), stepId: step.id };
}

describe('程序化路径的真实通知行为（loadProgram 存在的理由）', () => {
  it('newBlock + connect：同步 0 条，但延迟一定会到（实测 4 条）——"程序化改动不派发"是错的', async () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });

    const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
    const step = bridge.workspace.newBlock(BLOCK_TYPES.actionStep);
    step.initSvg();
    connect(start, step);
    // 同步一定收不到：D 在这一刻拿到的还是旧产物。
    expect(notified).toBe(0);

    const state = Blockly.serialization.workspaces.save(bridge.workspace);
    expect(notified).toBe(0);

    // 但别指望它"安静"：延迟事件照常送到监听器（实测 3×create + 1×move，viewport_change 被过滤）。
    await settleEvents();
    expect(notified).toBe(4);

    // 同一份状态装进另一座**空**画布：同步同样收不到（装载完成那一刻，监听器还没被叫过）。
    const target = mount();
    let targetNotified = 0;
    target.onChange(() => {
      targetNotified += 1;
    });
    Blockly.serialization.workspaces.load(state, target.workspace, { recordUndo: false });
    expect(targetNotified).toBe(0);
    expect(target.normalize().blocks[0]?.next?.type).toBe(BLOCK_TYPES.actionStep);
    await settleEvents();
    // 延迟条数随画布状态变化（实测 2 条），所以只能断言"会被迟到地通知到"。
    expect(targetNotified).toBeGreaterThan(0);
  });

  it('loadProgram 把这段事件摁住：装了又装，延迟事件落地后仍然每次只有一次通知', async () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });

    const first = stepState();
    bridge.loadProgram(first.state);
    expect(notified).toBe(1);
    await settleEvents();
    // 回归点：不做压制时，`clear()` / `load()` 的延迟事件会在装载完成后补到（实测 2–7 条），
    // "一次装载通知几次"从此不确定（见文件头表格）。
    expect(notified).toBe(1);

    bridge.loadProgram(first.state);
    await settleEvents();
    expect(notified).toBe(2);

    // 压制必须只覆盖装载那一段：事件开关留在关掉的状态，会让之后的手势全被静默丢弃。
    expect(Blockly.Events.isEnabled()).toBe(true);
    const modelEvent = { type: 'create', isUiEvent: false } as unknown as Blockly.Events.Abstract;
    bridge.workspace.fireChangeListener(modelEvent);
    expect(notified).toBe(3);
  });

  it('用户手势那条路（手喂模型事件）仍然通知：过滤只挡 UI-only 事件', () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });
    const modelEvent = { type: 'create', isUiEvent: false } as unknown as Blockly.Events.Abstract;
    bridge.workspace.fireChangeListener(modelEvent);
    expect(notified).toBe(1);
  });
});

describe('挂载桥：loadProgram', () => {
  it('装载后主动通知一次，且归一化结果就是装载进去的程序', () => {
    const bridge = mount();
    const calls: number[] = [];
    bridge.onChange(() => calls.push(calls.length + 1));

    bridge.loadProgram(stepState().state);
    expect(calls).toEqual([1]);

    const program = bridge.normalize();
    expect(program.blocks).toHaveLength(1);
    expect(program.blocks[0]?.type).toBe(BLOCK_TYPES.start);
    expect(program.blocks[0]?.next?.type).toBe(BLOCK_TYPES.actionStep);
    // 影子积木（step 的 count）跟着装载进来：默认 1 是工具箱里看到的那个值。
    expect(program.blocks[0]?.next?.inputs[INPUTS.count]?.fields.NUM).toBe(1);
  });

  it('是"替换"而不是"追加"：旧程序不残留，重复装载同一份也不会出现两块程序', () => {
    const bridge = mount();
    const oldStart = bridge.workspace.newBlock(BLOCK_TYPES.start);
    expect(bridge.workspace.getTopBlocks(false)).toHaveLength(1);

    const state = stepState().state;
    bridge.loadProgram(state);
    const topIds = bridge.workspace.getTopBlocks(false).map((block) => block.id);
    expect(topIds).not.toContain(oldStart.id);
    expect(topIds).toHaveLength(1);

    bridge.loadProgram(state);
    expect(bridge.workspace.getTopBlocks(false)).toHaveLength(1);
    expect(bridge.normalize().blocks).toHaveLength(1);
  });

  it('装载出来的程序能被编译，来源表指回真实积木（D 的定位链路一次走通）', () => {
    const bridge = mount();
    const built = stepState();
    bridge.loadProgram(built.state);
    const program = bridge.normalize();
    const result = compileProgram({ program, challenge: ret2winPublic });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toEqual([{ type: 'step', count: 1 }]);

    const blockId = blockIdForAction(result, 0);
    expect(blockId).toBe(built.stepId);
    // id 必须是画布上查得到的积木，不然 highlight 只能静默失败。
    expect(bridge.workspace.getBlockById(blockId ?? '')).not.toBeNull();
  });

  it('装载绕过 maxInstances 的第二个开始块：编译期兜底拒绝（容量不是安全边界）', () => {
    const state = saveState((workspace) => {
      workspace.newBlock(BLOCK_TYPES.start);
      workspace.newBlock(BLOCK_TYPES.start);
    });
    expect(state).toBeDefined();

    const bridge = mount();
    bridge.loadProgram(state);
    const program: NormalizedWorkspace = bridge.normalize();
    expect(program.blocks).toHaveLength(2);
    const result = compileProgram({ program, challenge: ret2winPublic });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.message)).toEqual([
      MESSAGE_MULTIPLE_START_BLOCKS,
      MESSAGE_MULTIPLE_START_BLOCKS,
    ]);
  });

  it('卸载之后调用安全（不抛错、也不再通知）', () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });
    const state = stepState().state;
    bridge.dispose();
    expect(() => bridge.loadProgram(state)).not.toThrow();
    expect(notified).toBe(0);
  });
});

describe('装载 → 通知 → 过期 + 重编译（D 的接线顺序）', () => {
  /** D 的监听器（payload-panel 的 `onBlocklyChange`）：先标过期，再重编译。 */
  function wire(bridge: BlocklyBridge, tracker: ReturnType<typeof createArtifactTracker>): void {
    bridge.onChange(() => {
      tracker.noteEdit();
      tracker.compile(bridge.normalize(), ret2winPublic);
    });
  }

  it('loadProgram 的通知把 tracker 带到「装载后的程序」上：产物换新、来源表指对积木', () => {
    const bridge = mount();
    const tracker = createArtifactTracker();
    wire(bridge, tracker);

    // 装载之前先在画布上放一个空的「开始」积木并编译：tracker 里有一份**旧**产物（0 个动作）。
    bridge.workspace.newBlock(BLOCK_TYPES.start);
    expect(tracker.compile(bridge.normalize(), ret2winPublic)?.actions).toEqual([]);
    expect(tracker.state.revision).toBe(1);

    const built = stepState();
    bridge.loadProgram(built.state);

    // 一次装载 = 一次通知 = 一次重编译：产物是装载后程序的，不是旧的空程序。
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.revision).toBe(2);
    expect(tracker.state.artifact?.actions).toEqual([{ type: 'step', count: 1 }]);
    expect(tracker.state.artifact?.origins).toEqual([{ index: 0, blockId: built.stepId }]);
    expect(tracker.state.errors).toEqual([]);
  });

  it('顺序反了（先重编译后标过期）会留下一份"新鲜却已过期"的产物：接线必须先标过期', () => {
    const bridge = mount();
    const tracker = createArtifactTracker();
    bridge.onChange(() => {
      tracker.compile(bridge.normalize(), ret2winPublic);
      tracker.noteEdit();
    });

    bridge.loadProgram(stepState().state);
    // 产物其实是最新的，但 `stale` 被后一步置位：界面会禁用试运行与提交——
    // 这正是 `noteEdit` / `compile` 的调用顺序必须由接线方保证的原因（artifact.ts 的协议）。
    expect(tracker.state.artifact?.actions).toEqual([{ type: 'step', count: 1 }]);
    expect(tracker.state.stale).toBe(true);

    // 顺序正确的重编译立刻恢复：产物不变、`stale` 清掉。
    tracker.noteEdit();
    tracker.compile(bridge.normalize(), ret2winPublic);
    expect(tracker.state.stale).toBe(false);
    expect(tracker.state.revision).toBe(2);
  });
});
