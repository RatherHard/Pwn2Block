// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/payload-panel';
import type { Pwn2BlockPayloadPanel } from '../src/components/payload-panel';
import { BLOCK_TYPES } from '../src/compiler/types';
import { mountBlockly } from '../src/blocks/mount';
import { readCanvas, readSession, writeCanvas, type KeyValueStore } from '../src/viewmodel/storage';
import { payloadControls, type PayloadControlsInput } from '../src/viewmodel/toolbar';
import { FAKE_SESSION_ID, makeControllerState } from './fake-api';

/**
 * Payload 窗口（D02，05 §3）：真实 Blockly 挂载、画布高亮、积木改动的“过期 + 重编译”。
 *
 * 为什么用真实 Blockly：挂载与卸载的痕迹只能由真实注入证明（`host.childElementCount`、
 * `workspace` 是否为 `undefined`），这也正是 09 §3.2 桥契约里最容易写错的两处。
 * 编辑事件按 H 的做法喂到 `fireChangeListener`：jsdom 里没法可靠合成手势。
 */

const panels: Pwn2BlockPayloadPanel[] = [];

async function mountPanel(): Promise<Pwn2BlockPayloadPanel> {
  const panel = document.createElement('pwn2block-payload-panel') as Pwn2BlockPayloadPanel;
  panel.challenge = ret2winPublic;
  panel.sessionId = FAKE_SESSION_ID;
  document.body.append(panel);
  await panel.updateComplete;
  await panel.updateComplete;
  panels.push(panel);
  return panel;
}

afterEach(() => {
  for (const panel of panels.splice(0)) panel.remove();
});

/** Blockly 没有公开的高亮读取接口，读它自己记录的运行时数组（同 `blocks/mount.test.ts`）。 */
function highlightedIds(workspace: Blockly.WorkspaceSvg): readonly string[] {
  const internal = workspace as unknown as { readonly highlightedBlocks: readonly Blockly.Block[] };
  return internal.highlightedBlocks.map((block) => block.id);
}

function syntheticEvent(type: string, isUiEvent: boolean): Blockly.Events.Abstract {
  return { type, isUiEvent } as unknown as Blockly.Events.Abstract;
}

describe('payload 窗口：画布挂载与卸载（09 §3.2）', () => {
  it('会话就绪后挂上真实画布，只在 #blockly-host 里注入', async () => {
    const panel = await mountPanel();
    const host = panel.renderRoot.querySelector<HTMLElement>('#blockly-host');
    expect(host).not.toBeNull();
    expect(host?.childElementCount ?? 0).toBeGreaterThan(0);
    expect(panel.workspace).toBeDefined();
    // 挂上以后占位说明就隐藏了。
    expect(panel.renderRoot.querySelector('.placeholder')?.hasAttribute('hidden')).toBe(true);
  });

  it('断开连接时解绑并销毁画布，宿主不留痕迹', async () => {
    const panel = await mountPanel();
    const host = panel.renderRoot.querySelector<HTMLElement>('#blockly-host');
    const workspace = panel.workspace;
    let notified = 0;
    workspace?.fireChangeListener(syntheticEvent('create', false));

    panel.remove();
    expect(panel.workspace).toBeUndefined();
    expect(host?.childElementCount).toBe(0);
    // 卸载后占位说明回来。
    expect(panel.renderRoot.querySelector('.placeholder')?.hasAttribute('hidden')).toBe(false);

    // 卸载后桥已经解绑：再喂事件也不会有人处理（也不会抛错）。
    expect(() => workspace?.fireChangeListener(syntheticEvent('create', false))).not.toThrow();
    notified += 0;
    expect(notified).toBe(0);
  });

  it('同一道题重复渲染不会重复挂载（不会出现第二个画布）', async () => {
    const panel = await mountPanel();
    const first = panel.workspace;
    panel.state = makeControllerState({ artifact: { artifact: undefined, errors: [], stale: false, revision: 0 } });
    await panel.updateComplete;
    expect(panel.workspace).toBe(first);
    const host = panel.renderRoot.querySelector<HTMLElement>('#blockly-host');
    expect(host?.querySelectorAll('.blocklySvg').length).toBe(1);
  });
});

describe('payload 窗口：画布高亮（05 §4）', () => {
  it('不再渲染程序区（已删除，改用输出区条目与画布高亮作为定位出口）', async () => {
    const panel = await mountPanel();
    expect(panel.renderRoot.querySelector('pwn2block-program-view')).toBeNull();
  });

  it('外部传入高亮目标（编译错误 / 被拒绝的动作）时会高亮，撤回后清除', async () => {
    const panel = await mountPanel();
    const workspace = panel.workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const block = workspace.newBlock(BLOCK_TYPES.actionRet);
    block.initSvg();

    panel.highlightBlockId = block.id;
    await panel.updateComplete;
    expect(highlightedIds(workspace)).toEqual([block.id]);

    panel.highlightBlockId = undefined;
    await panel.updateComplete;
    expect(highlightedIds(workspace)).toEqual([]);
  });
});

describe('payload 窗口：积木改动 → 过期 + 重编译（05 §3.1 备忘）', () => {
  it('用户手势改动派发 p2b-edit 并立刻派发一次编译请求', async () => {
    const panel = await mountPanel();
    const events: string[] = [];
    let compiled: unknown;
    panel.addEventListener('p2b-edit', () => events.push('edit'));
    panel.addEventListener('p2b-compile', (event) => {
      events.push('compile');
      compiled = (event as CustomEvent<{ readonly program: unknown }>).detail.program;
    });

    panel.workspace?.fireChangeListener(syntheticEvent('create', false));
    expect(events).toEqual(['edit', 'compile']);
    // 编译请求带的是归一化后的程序（纯数据，不含 Blockly 对象）。
    expect(compiled).toEqual({ blocks: [] });
  });

  it('UI-only 事件不触发过期与重编译', async () => {
    const panel = await mountPanel();
    const events: string[] = [];
    panel.addEventListener('p2b-edit', () => events.push('edit'));
    panel.workspace?.fireChangeListener(syntheticEvent('viewport_change', true));
    expect(events).toEqual([]);
  });

  it('recompile() 单独可用：程序化装载程序之后必须自己调它（05 §3.1）', async () => {
    const panel = await mountPanel();
    const programs: unknown[] = [];
    panel.addEventListener('p2b-compile', (event) => {
      programs.push((event as CustomEvent<{ readonly program: unknown }>).detail.program);
    });
    panel.recompile();
    expect(programs).toEqual([{ blocks: [] }]);
  });
});

describe('payload 窗口：标题栏（本批任务第 6 条）', () => {
  it('标题栏只有 payload 与运行 / 终止', async () => {
    const panel = await mountPanel();
    const root = panel.renderRoot;
    const bar = root.querySelector('.box');
    expect(bar?.querySelector('.box-title')?.textContent?.trim()).toBe('payload');
    expect([...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim())).toEqual([
      '运行',
      '终止',
    ]);
    // 输出区与运行菜单都已经移出这个组件（输出区移到页面壳，运行菜单只剩顶栏那份）。
    expect(root.querySelector('pwn2block-output-view, pwn2block-run-menu')).toBeNull();
  });

  it('禁用按钮带原因，点击可用按钮派发 p2b-run', async () => {
    const panel = await mountPanel();
    const input: PayloadControlsInput = {
      mode: 'debug',
      hasSession: false,
      sessionExpired: false,
      artifact: undefined,
      stale: false,
      compileErrorCount: 0,
      history: { undo: 0, stepBack: 0 },
      cursor: 0,
      allowedActions: [],
      running: true,
    };
    panel.controls = payloadControls(input);
    await panel.updateComplete;

    const buttons = [...panel.renderRoot.querySelectorAll('button')];
    const run = buttons.find((b) => b.textContent?.trim() === '运行');
    const abort = buttons.find((b) => b.textContent?.trim() === '终止');
    // 「运行」被会话门禁拦住：禁用原因只做 title，不置灰之外还要可读。
    expect(run?.disabled).toBe(true);
    expect(run?.title).toBe('会话还没准备好：先在上面选一道题');

    // 「终止」在 running 为真时可用：点击派发 p2b-run，detail 为 abort。
    expect(abort?.disabled).toBe(false);
    let detail: unknown;
    panel.addEventListener('p2b-run', (event) => {
      detail = (event as CustomEvent).detail;
    });
    abort?.click();
    expect(detail).toEqual({ kind: 'abort' });
  });
});

describe('payload 窗口：画布本地保存与恢复（D5 批次 2，05 §3.1）', () => {
  /** 内存存储：面板只认注入进来的 store，不传就等于这台环境不保存。 */
  function memoryStore(): KeyValueStore & { readonly data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
      },
      removeItem: (key) => {
        data.delete(key);
      },
    };
  }

  async function mountedWith(store: KeyValueStore): Promise<Pwn2BlockPayloadPanel> {
    const panel = document.createElement('pwn2block-payload-panel') as Pwn2BlockPayloadPanel;
    panel.challenge = ret2winPublic;
    panel.sessionId = FAKE_SESSION_ID;
    panel.store = store;
    document.body.append(panel);
    await panel.updateComplete;
    await panel.updateComplete;
    panels.push(panel);
    return panel;
  }

  /** 先拿一块真实画布编出存档（存档的格式归 H，测试不该手写序列化内容）。 */
  function archiveWith(blockType: string): Record<string, unknown> {
    const host = document.createElement('div');
    document.body.append(host);
    const bridge = mountBlockly(host, ret2winPublic);
    bridge.workspace?.newBlock(blockType);
    const archive = bridge.save();
    bridge.dispose();
    host.remove();
    return archive;
  }

  it('用户手势改动后立刻落盘（刷新时才有东西可恢复）', async () => {
    const store = memoryStore();
    const panel = await mountedWith(store);
    const block = panel.workspace?.newBlock(BLOCK_TYPES.actionRet);
    expect(block).toBeDefined();

    panel.workspace?.fireChangeListener(syntheticEvent('create', false));
    expect(readCanvas(store, ret2winPublic.id)).toBeDefined();
    expect(readSession(store, ret2winPublic.id)).toBeUndefined(); // 会话记录归控制器写
  });

  it('restoreArchive() 把存档装回画布，并且是幂等的', async () => {
    const store = memoryStore();
    writeCanvas(store, ret2winPublic.id, archiveWith(BLOCK_TYPES.actionRet));

    const panel = await mountedWith(store);
    const events: string[] = [];
    panel.addEventListener('p2b-compile', () => events.push('compile'));
    expect(panel.restoreArchive()).toBeUndefined();
    // 装载会触发一次重编译（桥在装载完成后主动通知一次，09 §3.2）。
    expect(panel.workspace?.getAllBlocks(false).map((each) => each.type)).toEqual([BLOCK_TYPES.actionRet]);
    expect(panel.restoreArchive()).toBeUndefined();

    // 没有存档时同样是「成功」，不会去动画布。
    const empty = memoryStore();
    const bare = await mountedWith(empty);
    expect(bare.restoreArchive()).toBeUndefined();
    expect(bare.workspace?.getAllBlocks(false)).toHaveLength(0);
  });

  it('坏存档：画布逐块保持原样，返回原因是给人看的', async () => {
    const store = memoryStore();
    writeCanvas(store, ret2winPublic.id, { blocks: { blocks: [{ type: '不存在的积木' }] } });

    const panel = await mountedWith(store);
    const before = panel.workspace?.getAllBlocks(false).map((each) => each.id);
    const reason = panel.restoreArchive();
    expect(reason).toContain('本地保存的程序恢复失败');
    // 事务式语义（09 §3.2）：失败即无副作用，用户的程序还在。
    expect(panel.workspace?.getAllBlocks(false).map((each) => each.id)).toEqual(before);
  });

  it('画布没挂上时先不返回失败，挂上之后还能再问一次', async () => {
    const store = memoryStore();
    writeCanvas(store, ret2winPublic.id, archiveWith(BLOCK_TYPES.actionRet));
    const panel = document.createElement('pwn2block-payload-panel') as Pwn2BlockPayloadPanel;
    panel.challenge = ret2winPublic;
    panel.store = store;
    // 还没插进文档：没有画布，也没有「装过了」的记忆。
    expect(panel.restoreArchive()).toBeUndefined();
    document.body.append(panel);
    panels.push(panel);
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.restoreArchive()).toBeUndefined();
    expect(panel.workspace?.getAllBlocks(false).map((each) => each.type)).toEqual([BLOCK_TYPES.actionRet]);
  });
});
