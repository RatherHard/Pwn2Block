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
 * 卸载时 off(); bridge.dispose();
 * ```
 *
 * 三个约定：
 * - **只有用户手势引发的改动才通知**（`onChange`）：Blockly 的变更流里既有 UI-only 事件
 *   （高亮、选中、视口滚动），也有程序化改动——后者的实测行为是**根本不派发**：
 *   `workspace.newBlock()` 不发，`connection.connect()` / `disconnect()` 内部被
 *   `Events.disable()` 包住，`serialization.workspaces.load()` 同样不发。
 *   所以 D 在两处要自己主动重编译：① 程序化装载/生成程序之后；② 不需要防抖 UI 事件。
 * - **一次编辑可能派发多个事件**：桥按事件逐个通知，D 若想"一轮编辑只编译一次"，
 *   在监听器里自己合并。事件本身是**异步**派发的（Blockly 排进队列、下一个宏任务里发出），
 *   监听器不会在"改画布的那一行"同步被调用。
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

  const handleChange = (event: Blockly.Events.Abstract): void => {
    if (disposed || isUiOnlyEvent(event)) return;
    // 复制一份再遍历：监听器里可能会退订（例如"编译一次后就 unsubscribe"）。
    for (const listener of [...listeners]) listener();
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
