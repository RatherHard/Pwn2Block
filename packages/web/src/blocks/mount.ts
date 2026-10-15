import * as Blockly from 'blockly';
import type { PublicChallenge } from '@pwn2block/shared';
import type { NormalizedWorkspace } from '../compiler/types';
import { BLOCK_MAX_INSTANCES, defineAuthorBlockDefinitions, definePwn2BlockBlocks } from './definitions';
import { buildToolbox } from './toolbox';
import { normalizeWorkspace } from './workspace';

/**
 * Blockly 挂载桥（H01，05 §3.1）。
 *
 * 这是页面与 Blockly 之间**唯一**的接口：D 只需要 `mountBlockly(host, challenge)`，
 * 不必知道 Blockly 的注入选项、编辑事件或高亮 API；编译路径只看到 `normalize()` 出来的纯数据。
 *
 * D 的用法（D3 接线，`payload-panel.ts` 里已经有 `#blockly-host`）：
 *
 * ```ts
 * const bridge = mountBlockly(host, challenge);
 * const off = bridge.onChange(() => { 产物过期(); 重新编译(bridge.normalize()); });
 * 出错时 bridge.highlight(error.blockId);
 * 装载存档或示例程序时 bridge.loadProgram(saved);   // 它会替你把"重编译"叫起来
 * 卸载时 off(); bridge.dispose();
 * ```
 *
 * 几条约定：
 * - **通知是异步、成批的，别按"一次编辑一次通知"接线**（`onChange`）：事件走 Blockly 的队列，
 *   在"改画布的那一行"**同步一定收不到**，之后才成批到达（实测：`newBlock()` + `connect()`
 *   一帧后到 4 条；`clear()` / `load()` 再补 2–7 条，条数随画布状态变化）；UI-only 事件
 *   （高亮、选中、视口滚动）被过滤掉。D 若想"一轮编辑只编译一次"，在监听器里自己合并。
 * - **程序化改动不是"没有事件"，而是"迟到的事件"**：直接 `workspace.clear()` + `load()`
 *   会在装载**完成之后**再补上一批事件，于是"一次装载通知几次"变成运气问题。替换画布请走
 *   `loadProgram()`：它把这段事件摁掉，装载完主动通知**一次**（实测等满 100ms 也只有 1 次），
 *   调用方不必再记得手动重编译（`mount.load.test.ts` 逐条钉住）。
 * - **唯一开始块由 Blockly 的 `maxInstances` + 编译器共同保证**（见 `definitions.ts`
 *   的 `BLOCK_MAX_INSTANCES`）：桥负责把容量配上去，编译器负责兜住程序化创建出来的第二块。
 * - **`dispose()` 之后宿主不留痕迹**：重复调用安全，测试与热重载都能直接调。
 */

export interface BlocklyBridgeOptions {
  /**
   * Blockly 渲染器。默认 `thrasos`：它不依赖字体/尺寸测量，浏览器与 jsdom 下都稳定，
   * 也让单测能真的 `inject` 一次（而不是只比较工具箱数据）。
   */
  readonly renderer?: string;
  /** 只读画布（例如回放态）。默认 false。 */
  readonly readOnly?: boolean;
}

/**
 * Blockly 工作区的序列化状态：`Blockly.serialization.workspaces.save(workspace)` 的产物。
 * 用它装载程序时不必让 D 认识 Blockly 的类型（`blocks/**` 是唯一接触 Blockly 的地方）。
 */
export type SerializedWorkspace = Record<string, unknown>;

export interface BlocklyBridge {
  /** 已注入的 Blockly 工作区（`WorkspaceSvg`）。 */
  readonly workspace: Blockly.WorkspaceSvg;
  /** 当前画布的归一化积木树，可直接喂 `compileProgram`。 */
  normalize(): NormalizedWorkspace;
  /**
   * 订阅编辑事件。返回取消订阅函数。
   *
   * 通知走 Blockly 的事件队列，所以在下一个宏任务里才到；一次编辑可能通知多次。
   * 同一个监听器重复订阅只会记一次；`dispose()` 之后再订阅不会被调用（返回的取消函数仍然安全）。
   */
  onChange(listener: () => void): () => void;
  /**
   * 程序化装载一份工作区状态（恢复存档、载入示例程序、切题时重建程序）。
   *
   * 语义是**替换**画布内容：先清空再装载，不留上一份程序的残块。
   * 装载完成后**主动通知一次**订阅者，并且用 `replaceWorkspace` 把 Blockly 自己的延后事件
   * （`clear()` / `load()` 排在下一个宏任务里的那一批）摁掉——所以一次装载就是一次通知：
   * 调用方不必记住"装载之后要手动重编译"，也不会收到与画布内容错位的迟到事件。
   *
   * 状态非法时由 Blockly 抛出（显式失败，不静默留一份半装载的画布）。
   */
  loadProgram(state: SerializedWorkspace): void;
  /** 错误定位：高亮一块积木；传 `undefined` 清除全部高亮。 */
  highlight(blockId: string | undefined): void;
  /** 卸载：解绑事件、销毁工作区、清空宿主。重复调用安全。 */
  dispose(): void;
}

const DEFAULT_RENDERER = 'thrasos';

/**
 * 工具箱数据的类型转换。
 *
 * `toolbox.ts` 返回的是**只读**数据（它刻意不依赖 Blockly，好在 node 里直接单测），
 * 而 Blockly 要求可变数组。这里做一次显式拷贝而不是 `as` 蒙过去：拷贝同时也保证
 * Blockly 拿到的那份数据被改动时不会碰到我们的常量。
 */
function toBlocklyToolbox(challenge: PublicChallenge) {
  const toolbox = buildToolbox(challenge);
  return {
    kind: 'categoryToolbox' as const,
    contents: toolbox.contents.map((category) => ({
      kind: 'category' as const,
      name: category.name,
      colour: category.colour,
      contents: category.contents.map((entry) => ({ kind: 'block' as const, type: entry.type })),
    })),
  };
}

/**
 * UI-only 事件：Blockly 用 `isUiEvent` 标记"不是模型变化"的事件（高亮、选中、视口…）。
 *
 * 用结构化读取而不是绑定到具体事件类：v13 里这个字段在抽象基类上，具体事件子类都继承它。
 */
function isUiOnlyEvent(event: Blockly.Events.Abstract): boolean {
  return (event as { readonly isUiEvent?: boolean }).isUiEvent === true;
}

/**
 * 把画布内容整体换成 `state`（先清空再装载），并**摁住这一段的 Blockly 事件**。
 *
 * 为什么必须显式关事件（D4 实测，见 `mount.load.test.ts`）：
 * - 程序化改动的通知**同步一定没有、但会迟到**：`newBlock()` + `connect()` 一帧后到 4 条，
 *   `load()` / `clear()` 再补 2–7 条，条数随画布状态变化，而且都在装载完成之后。
 *   于是"清空 + 装载"这种最普通的替换写法会让"一次装载通知几次"变成运气问题。
 * - 装载这一段的 Blockly 事件要的是"丢弃"，不是"排队"：`Events.disable()` 期间 Blockly
 *   直接丢掉它们，所以替换画布对外只剩下面主动补的那**一次**通知（实测等满 100ms 也只有 1 次）。
 */
function replaceWorkspace(workspace: Blockly.WorkspaceSvg, state: SerializedWorkspace): void {
  Blockly.Events.disable();
  try {
    workspace.clear();
    Blockly.serialization.workspaces.load(state, workspace, { recordUndo: false });
  } finally {
    // 必须在 finally 里恢复：装载状态非法时 Blockly 会抛，事件开关不能留在关掉的状态
    //（留着会让之后的手势改动全部被静默丢弃）。
    Blockly.Events.enable();
  }
}

/** 把 Blockly 工作区注入宿主元素。宿主必须已经在文档里（否则 SVG 尺寸全是 0）。 */
export function mountBlockly(
  host: HTMLElement,
  challenge: PublicChallenge,
  options: BlocklyBridgeOptions = {},
): BlocklyBridge {
  definePwn2BlockBlocks();
  defineAuthorBlockDefinitions(challenge);

  const workspace = Blockly.inject(host, {
    toolbox: toBlocklyToolbox(challenge),
    maxInstances: BLOCK_MAX_INSTANCES,
    renderer: options.renderer ?? DEFAULT_RENDERER,
    ...(options.readOnly === true ? { readOnly: true } : {}),
  });

  const listeners = new Set<() => void>();
  let disposed = false;

  /** 通知所有订阅者。复制一份再遍历：监听器里可能会退订（例如"编译一次后就 unsubscribe"）。 */
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const handleChange = (event: Blockly.Events.Abstract): void => {
    if (disposed || isUiOnlyEvent(event)) return;
    notify();
  };
  workspace.addChangeListener(handleChange);

  return {
    workspace,

    normalize(): NormalizedWorkspace {
      return normalizeWorkspace(workspace);
    },

    onChange(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    loadProgram(state: SerializedWorkspace): void {
      if (disposed) return;
      replaceWorkspace(workspace, state);
      // 装载不是"用户手势"，但调用方的产物**必须**跟着换（见 `loadProgram` 的契约）：
      // 这里补一次确定的通知，不让调用方依赖 Blockly 那批迟到又条数不定的事件。
      notify();
    },

    highlight(blockId: string | undefined): void {
      if (disposed) return;
      // 传 undefined 等价于"清空高亮"：Blockly 的签名要求 null，这里做一次显式转换。
      workspace.highlightBlock(blockId === undefined ? null : blockId);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      workspace.removeChangeListener(handleChange);
      // 先销毁工作区再检查宿主：`WorkspaceSvg.dispose()` 自己会清掉注入的 DOM。
      workspace.dispose();
    },
  };
}
