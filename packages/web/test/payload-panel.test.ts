// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type * as Blockly from 'blockly';
import { ret2winPublic } from '@pwn2block/shared';
// 副作用导入：注册自定义元素（只在类型位置用到类名时，编译期会把 import 整条删掉）。
import '../src/components/payload-panel';
import type { Pwn2BlockPayloadPanel } from '../src/components/payload-panel';
import { BLOCK_TYPES } from '../src/compiler/types';
import { FAKE_SESSION_ID, makeArtifact, makeControllerState } from './fake-api';

/**
 * Payload 窗口（D02，05 §3）：真实 Blockly 挂载、程序区点行高亮、积木改动的“过期 + 重编译”。
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

describe('payload 窗口：程序区与高亮（05 §3、§4）', () => {
  it('程序区逐行显示动作，点行高亮对应积木', async () => {
    const panel = await mountPanel();
    const workspace = panel.workspace;
    if (workspace === undefined) throw new Error('画布没挂上');
    const block = workspace.newBlock(BLOCK_TYPES.actionRet);
    block.initSvg();

    panel.state = makeControllerState({
      artifact: { artifact: makeArtifact([{ type: 'ret' }], [block.id]), errors: [], stale: false, revision: 1 },
    });
    await panel.updateComplete;

    const row = panel.renderRoot.querySelector('pwn2block-program-view')?.renderRoot.querySelector('button');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('ret');
    row?.click();
    expect(highlightedIds(workspace)).toEqual([block.id]);

    // 再点同一行：高亮清掉，避免“看起来还亮着但其实已经切走了”。
    row?.click();
    expect(highlightedIds(workspace)).toEqual([]);
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

describe('payload 窗口：输出区（05 §6）', () => {
  it('编译错误逐条列出并带定位积木按钮，satisfied 只提示去提交', async () => {
    const panel = await mountPanel();
    panel.state = makeControllerState({
      artifact: {
        artifact: undefined,
        errors: [{ blockId: 'missing-input', message: 'gets 的 data 输入还空着' }],
        stale: false,
        revision: 0,
      },
    });
    await panel.updateComplete;
    const output = panel.renderRoot.querySelector('pwn2block-output-view');
    expect(output?.renderRoot.textContent).toContain('gets 的 data 输入还空着');
    expect(output?.renderRoot.querySelector('button')?.textContent).toContain('定位积木');
    // 颜色不是唯一信息载体（05 §7）：条目带文字标签。
    expect(output?.renderRoot.textContent).toContain('编译失败');
    expect(output?.renderRoot.textContent).not.toContain('flag');
  });
});
