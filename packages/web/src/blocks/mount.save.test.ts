// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
import { BLOCK_TYPES, FIELDS, INPUTS } from '../compiler/types';
import { DEFAULT_VARIABLE_NAME } from './definitions';
import { mountBlockly, type BlocklyBridge, type SerializedWorkspace } from './mount';

/**
 * `save()`：当前画布的序列化状态（D5 契约，05 §3.1 / 09 §3.2）。
 *
 * D 的两条消费路径都要求"画布存得回来"：
 * - **本地保存**：只存编译产物 `actions` 会造成「程序区有产物、画布是空的」——刷新后用户能
 *   试运行/提交一份画布**再也产不出来**的 payload（正是 05 §4 要避免的困惑）；
 * - **会话恢复**：刷新后 `GET /api/sessions/:id` 把服务端调试状态接回来时，画布必须同时接回来，
 *   否则是"服务端状态回来了、画布仍空"的半恢复。
 *
 * 所以 `save()` 的契约有三条，全部用真实 Blockly 在这里钉住：
 * 1. 与 `loadProgram()` **成对**：`save()` 的产物装回去还原同一份程序（含积木 id 与连接）；
 * 2. **纯函数**：不改画布、0 次通知、不动事件开关——否则"保存"会顺手把编译产物标脏；
 * 3. **`dispose()` 之后再调抛 `Error`**，而不是静默返回 `{}`：静默返回会让消费方把用户的
 *    程序覆盖成空存档，是一条真实且无信号的数据丢失路径。
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

/** 等延迟事件全部落地：`newBlock()` 的那批排在下一个宏任务里（见 `mount.load.test.ts` 的表格）。 */
async function settleEvents(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 把 `step` 接到 `start` 下面：连接为 null 说明积木定义坏了，显式抛而不是静默跳过。 */
function connect(start: Blockly.BlockSvg, step: Blockly.BlockSvg): void {
  const next = start.nextConnection;
  const previous = step.previousConnection;
  if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
  next.connect(previous);
}

/** 在临时画布上搭一份「开始 → step」并交出状态与真实积木 id。 */
function stepState(): { readonly state: SerializedWorkspace; readonly startId: string; readonly stepId: string } {
  const bridge = mount();
  const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
  const step = bridge.workspace.newBlock(BLOCK_TYPES.actionStep);
  step.initSvg();
  connect(start, step);
  return { state: bridge.save(), startId: start.id, stepId: step.id };
}

describe('挂载桥：save', () => {
  it('save → loadProgram 往返：积木、连接与积木 id 都还原（来源表跨保存仍然指得对）', () => {
    const built = stepState();
    const target = mount();
    target.loadProgram(built.state);

    const restored = target.normalize();
    expect(restored.blocks).toHaveLength(1);
    expect(restored.blocks[0]?.id).toBe(built.startId);
    expect(restored.blocks[0]?.next?.id).toBe(built.stepId);
    expect(restored.blocks[0]?.next?.type).toBe(BLOCK_TYPES.actionStep);

    // 再存一次：产物是稳定的，不因为"装过一次"就变形（D 落盘的就是这一份）。
    expect(target.save()).toEqual(built.state);
  });

  it('save → loadProgram 往返（含变量与影子积木）：归一化结果逐字段相等', () => {
    const source = mount();
    const start = source.workspace.newBlock(BLOCK_TYPES.start);
    const set = source.workspace.newBlock(BLOCK_TYPES.varsSet);
    set.initSvg();
    connect(start, set);

    const target = mount();
    target.loadProgram(source.save());

    const before = source.normalize();
    const after = target.normalize();
    expect(after).toEqual(before);
    // 变量字段跨序列化仍然是**名字**：`FieldVariable` 存的是变量 id，
    // 恢复后必须还能归一化成名字，否则编译期会报「未定义变量」（见 blocks/workspace.ts）。
    expect(after.blocks[0]?.next?.fields[FIELDS.variable]).toBe(DEFAULT_VARIABLE_NAME);
    expect(after.blocks[0]?.next?.id).toBe(set.id);
    // 影子积木（varsSet 的值输入）跟着还原，不是"装载后输入变空"。
    expect(after.blocks[0]?.next?.inputs[INPUTS.value]?.type).toBe(BLOCK_TYPES.mathNumber);
  });

  it('save 是纯函数：不改画布、0 次通知、事件开关不动', async () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });

    bridge.loadProgram(stepState().state);
    await settleEvents();
    // `loadProgram` 那一次通知已经到齐；从这里开始单独数 `save()` 造成的通知。
    expect(notified).toBe(1);
    notified = 0;

    const before = bridge.normalize();
    const state = bridge.save();

    // 同步：画布逐字段不变、没有通知、事件开关不动。
    expect(bridge.normalize()).toEqual(before);
    expect(notified).toBe(0);
    expect(Blockly.Events.isEnabled()).toBe(true);
    // 产物里有画布内容，不是空对象（"保存了但没有内容"是要被发现的坏状态）。
    expect(Object.keys(state)).toContain('blocks');

    // 异步：`save()` 没往事件队列里放任何东西，所以等满 100ms 也不会有迟到的通知。
    await settleEvents();
    expect(notified).toBe(0);
    expect(bridge.normalize()).toEqual(before);
  });

  it('空画布上 save() 合法地返回 {}：空不是错误，"已卸载"才是', () => {
    const bridge = mount();
    // 一个还活着的空画布，"当前状态是空的"是正确答案；`dispose()` 之后才必须抛。
    expect(bridge.save()).toEqual({});
  });

  it('dispose() 之后再 save() 抛 Error，而不是静默返回空存档', () => {
    const bridge = mount();
    bridge.loadProgram(stepState().state);
    bridge.dispose();

    let caught: unknown;
    try {
      bridge.save();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    // 消息要点明"画布已卸载"：消费方拿到这条错误就知道不能把它当成"用户清空了程序"。
    expect(caught.message).toContain('已卸载');

    // 重复 `dispose()` 之后仍然抛，不因为"已经是卸载态"就变成安全返回。
    bridge.dispose();
    expect(() => bridge.save()).toThrow(Error);
  });
});
