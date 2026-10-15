import { createContext, reportError } from './context';
import { compileChain } from './statement';
import type {
  CompiledAction,
  CompileInput,
  CompileOptions,
  CompileResult,
  NormalizedBlock,
} from './types';
import {
  ACTION_ORIGIN_VERSION,
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
  MESSAGE_START_BLOCK_HAS_PREVIOUS,
  START_BLOCK_TYPE,
} from './types';

/**
 * 编译入口（05 §3、§4）。**D 在 D4 接的就是这个函数**：
 *
 * ```ts
 * const result = compileProgram({ program: normalizeWorkspace(workspace), challenge: publicJson });
 * ```
 *
 * 规则：
 * - 画布上必须**恰好有一个**「开始」积木，程序从它往下执行；未连到开始积木的积木不参与编译（05 §3.1）。
 * - 「开始」积木不许有上一个连接（只能出现在顶层），见 `types.ts` 的「开始积木与离散块」。
 * - 出错时返回 `{ ok: false, errors }`，每条错误带 `blockId`，UI 据此高亮积木（05 §4）。
 * - 成功时同时给出 `origins`（动作 → 积木来源表，08 §9.2）。来源表**只在前端内存里**：
 *   发给服务端的请求体用 `actionsForRequest(result)` 取，只有动作。
 * - 纯函数：不读 DOM、不读投影、不看时间，同样的输入永远得到同样的输出（08 §2 规则 3）。
 */
export function compileProgram(input: CompileInput, options?: CompileOptions): CompileResult {
  const ctx = createContext(input.challenge, options?.limits);
  const starts = collectStartBlocks(input.program.blocks);

  // 1) 「开始」积木不能接在别的积木下面：它必须是顶层积木。
  for (const nested of starts.nested) {
    reportError(ctx, nested.id, MESSAGE_START_BLOCK_HAS_PREVIOUS);
  }

  // 2) 顶层「开始」积木必须恰好一个。离散块（别的顶层链）不参与编译，也不报错。
  if (starts.top.length === 0 && starts.nested.length === 0) {
    // 一个开始块都没有：只有这时才说"需要一个"，错位的那块已经报过更精确的错。
    reportError(ctx, '', MESSAGE_NO_START_BLOCK);
  } else if (starts.top.length > 1) {
    for (const block of starts.top) {
      reportError(ctx, block.id, MESSAGE_MULTIPLE_START_BLOCKS);
    }
  } else if (ctx.errors.length === 0) {
    const start = starts.top[0] as NormalizedBlock;
    compileChain(ctx, start.next, new Map<string, bigint>());
  }

  if (ctx.errors.length > 0) return { ok: false, errors: [...ctx.errors] };
  return {
    ok: true,
    actions: [...ctx.actions],
    origins: [...ctx.origins],
    originsVersion: ACTION_ORIGIN_VERSION,
  };
}

/**
 * 取「发往服务端的请求体里的动作」：来源表留在前端，不进网络（08 §9.2 第 4 条）。
 * 编译失败时没有可用动作，返回空数组（调用方本来也不该发）。
 */
export function actionsForRequest(result: CompileResult): readonly CompiledAction[] {
  return result.ok ? result.actions : [];
}

interface StartBlocks {
  /** 顶层（画布上的独立积木）里的「开始」积木。 */
  readonly top: NormalizedBlock[];
  /** 出现在别人的输入槽或 next 链里的「开始」积木：它有上一个连接，非法。 */
  readonly nested: NormalizedBlock[];
}

/**
 * 找出所有「开始」积木，并区分顶层与嵌套（05 §3.1）。
 *
 * 用 visited 集合防环：适配器已经会拒绝环，这里只是不让手写数据把编译器拖死。
 * 「顶层」= 直接来自 `program.blocks`，其余（输入槽、`next` 链里找到的）都算嵌套。
 */
function collectStartBlocks(blocks: readonly NormalizedBlock[]): StartBlocks {
  const top: NormalizedBlock[] = [];
  const nested: NormalizedBlock[] = [];
  const visited = new Set<string>();

  const walk = (block: NormalizedBlock | undefined, isTop: boolean): void => {
    if (block === undefined || visited.has(block.id)) return;
    visited.add(block.id);
    if (block.type === START_BLOCK_TYPE) {
      if (isTop) top.push(block);
      else nested.push(block);
    }
    for (const child of Object.values(block.inputs)) walk(child, false);
    walk(block.next, false);
  };

  for (const block of blocks) walk(block, true);
  return { top, nested };
}
