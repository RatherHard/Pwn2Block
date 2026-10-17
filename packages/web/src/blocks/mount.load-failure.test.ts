// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
import { compileProgram } from '../compiler/compile';
import { BLOCK_TYPES } from '../compiler/types';
import { mountBlockly, type BlocklyBridge, type SerializedWorkspace } from './mount';

/**
 * `loadProgram()` 的失败语义：**失败即无副作用**（D5 契约，08 §8 D4 待办②、09 §3.2）。
 *
 * D4 实测的缺陷：`replaceWorkspace` 先 `clear()` 再 `load()`，坏 state 让 Blockly 在中途抛错，
 * 但**画布已经被清空**、且**一个通知都不发**——用户的程序凭空消失，界面还被蒙在鼓里
 * （用户会看到空画布，「运行」和提交用的却还是旧产物）。这就是 05 §4 最忌讳的"困惑"。
 *
 * D5 定稿的语义：
 * - **成功**：替换画布内容，装载完成后主动通知一次（与 D4 行为一致，`mount.load.test.ts` 钉住）；
 * - **失败**：画布内容与调用前**逐块一致**（装载前先 `save()` 备份，`catch` 里装回去）、
 *   **不通知**任何订阅者、异常**原样抛给调用方**（不吞、不换类型、不换信息）；
 * - **`{}`（缺 `blocks`）是合法输入**，等价于"清空画布"，不算失败——否则"用户就是想清空"
 *   会被当成坏存档，D 的恢复流程会误报错。
 *
 * 坏输入取"引用未注册的积木类型"这一种，因为它**真实**：存档是跟着题目走的，拿题目 A 的存档
 * 去恢复题目 B 的画布（出题人积木的类型名按题目生成）就会撞上它。
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

function connect(start: Blockly.BlockSvg, step: Blockly.BlockSvg): void {
  const next = start.nextConnection;
  const previous = step.previousConnection;
  if (next === null || previous === null) throw new Error('语句连接不存在：定义有误');
  next.connect(previous);
}

/** 让 Blockly 抛错的最小坏输入。每次新建一份：不把同一份可变 JSON 交给两个画布。 */
function badState(): SerializedWorkspace {
  return { blocks: { blocks: [{ type: 'no_such_block_type' }] } };
}

/** 另一座画布上搭好的「开始 → step」：作为"好 state"的对照组，不污染被测画布。 */
function goodState(): SerializedWorkspace {
  const bridge = mount();
  const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
  const step = bridge.workspace.newBlock(BLOCK_TYPES.actionStep);
  step.initSvg();
  connect(start, step);
  return bridge.save();
}

/** 在被测画布上放一份"用户的程序"：开始 → step。 */
function buildProgram(bridge: BlocklyBridge): void {
  const start = bridge.workspace.newBlock(BLOCK_TYPES.start);
  const step = bridge.workspace.newBlock(BLOCK_TYPES.actionStep);
  step.initSvg();
  connect(start, step);
}

describe('挂载桥：loadProgram 失败即无副作用', () => {
  it('坏 state：原样抛错、画布逐块不变、0 次通知、事件开关仍为 true', async () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });

    buildProgram(bridge);
    await settleEvents();
    // 编辑那批迟到事件已经到齐；从这里开始只数"装载那一段"的通知。
    notified = 0;

    const before = bridge.normalize();
    // `getAllBlocks(false)` 把影子积木（step 的 count）也算进来，所以这里是"调用前后的真实块数"，
    // 不钉绝对条数——要钉的是 D4 缺陷里的那件事：它从 N 变成了 0。
    const beforeIds = bridge.workspace
      .getAllBlocks(false)
      .map((block) => block.id)
      .sort();
    expect(beforeIds.length).toBeGreaterThan(0);
    expect(notified).toBe(0);

    let caught: unknown;
    try {
      bridge.loadProgram(badState());
    } catch (error) {
      caught = error;
    }

    // ① 异常原样抛给调用方：Blockly 抛的是 TypeError，桥不吞、不换类型、不改信息。
    expect(caught).toBeInstanceOf(TypeError);
    if (!(caught instanceof Error)) return;
    expect(caught.message).toContain('no_such_block_type');

    // ② 画布与调用前逐块一致（D4 的缺陷正是这里变成 0 块）。
    expect(bridge.workspace.getAllBlocks(false)).toHaveLength(beforeIds.length);
    expect(
      bridge.workspace
        .getAllBlocks(false)
        .map((block) => block.id)
        .sort(),
    ).toEqual(beforeIds);
    expect(bridge.normalize()).toEqual(before);

    // ③ 一个通知都不发：调用方不会把"已还原的旧程序"当成新程序重编译一遍。
    expect(notified).toBe(0);
    await settleEvents();
    expect(notified).toBe(0);

    // ④ 事件总开关绝不留关闭态（留着会让用户之后的手势全部被静默丢弃）。
    expect(Blockly.Events.isEnabled()).toBe(true);

    // ⑤ 还原出来的是**能编译的**那份程序，不只是"块数相同"。
    const result = compileProgram({ program: bridge.normalize(), challenge: ret2winPublic });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions).toEqual([{ type: 'step', count: 1 }]);

    // ⑥ 失败不污染之后的操作：好的 state 照常装载，并且只通知一次。
    bridge.loadProgram(goodState());
    expect(notified).toBe(1);
    expect(bridge.normalize().blocks[0]?.next?.type).toBe(BLOCK_TYPES.actionStep);
  });

  it('空画布上遇到坏 state 同样显式抛错：不是"没东西可坏"就静默通过', () => {
    const bridge = mount();
    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });
    expect(bridge.workspace.getAllBlocks(false)).toHaveLength(0);

    expect(() => bridge.loadProgram(badState())).toThrow(TypeError);

    expect(bridge.workspace.getAllBlocks(false)).toHaveLength(0);
    expect(bridge.normalize().blocks).toEqual([]);
    expect(notified).toBe(0);
    expect(Blockly.Events.isEnabled()).toBe(true);
  });

  it('{}（缺 blocks）是合法输入：等价于清空画布，不抛错、通知一次', async () => {
    const bridge = mount();
    bridge.loadProgram(goodState());
    await settleEvents();
    expect(bridge.normalize().blocks).toHaveLength(1);

    let notified = 0;
    bridge.onChange(() => {
      notified += 1;
    });

    expect(() => bridge.loadProgram({})).not.toThrow();
    // 清空是"一次成功的装载"：画布空、产物也必须跟着变成空程序，所以要通知。
    expect(bridge.normalize().blocks).toEqual([]);
    expect(bridge.workspace.getAllBlocks(false)).toHaveLength(0);
    expect(notified).toBe(1);
    await settleEvents();
    expect(notified).toBe(1);
    expect(Blockly.Events.isEnabled()).toBe(true);
  });

  it('连续两次坏 state：第二次仍然抛，第一次的还原没有把画布搞坏', async () => {
    const bridge = mount();
    buildProgram(bridge);
    await settleEvents();
    const before = bridge.normalize();

    expect(() => bridge.loadProgram(badState())).toThrow(TypeError);
    expect(() => bridge.loadProgram(badState())).toThrow(TypeError);
    expect(bridge.normalize()).toEqual(before);
    expect(Blockly.Events.isEnabled()).toBe(true);
  });
});
