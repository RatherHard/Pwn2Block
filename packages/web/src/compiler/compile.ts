import { createContext, reportError } from './context';
import { compileChain } from './statement';
import type {
  CompileInput,
  CompileOptions,
  CompileResult,
  NormalizedBlock,
} from './types';
import {
  MESSAGE_MULTIPLE_START_BLOCKS,
  MESSAGE_NO_START_BLOCK,
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
 * - 出错时返回 `{ ok: false, errors }`，每条错误带 `blockId`，UI 据此高亮积木（05 §4）。
 * - 纯函数：不读 DOM、不读投影、不看时间，同样的输入永远得到同样的输出（08 §2 规则 3）。
 */
export function compileProgram(input: CompileInput, options?: CompileOptions): CompileResult {
  const ctx = createContext(input.challenge, options?.limits);
  const startBlocks = findStartBlocks(input.program.blocks);

  if (startBlocks.length === 0) {
    reportError(ctx, '', MESSAGE_NO_START_BLOCK);
  } else if (startBlocks.length > 1) {
    for (const block of startBlocks) {
      reportError(ctx, block.id, MESSAGE_MULTIPLE_START_BLOCKS);
    }
  } else {
    const start = startBlocks[0] as NormalizedBlock;
    compileChain(ctx, start.next, new Map<string, bigint>());
  }

  if (ctx.errors.length > 0) return { ok: false, errors: [...ctx.errors] };
  return { ok: true, actions: [...ctx.actions] };
}

/**
 * 找出所有「开始」积木。
 *
 * 用 visited 集合防环：适配器已经会拒绝环，这里只是不让手写数据把编译器拖死。
 */
function findStartBlocks(blocks: readonly NormalizedBlock[]): NormalizedBlock[] {
  const found: NormalizedBlock[] = [];
  const visited = new Set<string>();

  const walk = (block: NormalizedBlock | undefined): void => {
    if (block === undefined || visited.has(block.id)) return;
    visited.add(block.id);
    if (block.type === START_BLOCK_TYPE) found.push(block);
    for (const child of Object.values(block.inputs)) walk(child);
    walk(block.next);
  };

  for (const block of blocks) walk(block);
  return found;
}
