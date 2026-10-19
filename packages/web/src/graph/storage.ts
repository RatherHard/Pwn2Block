import {
  GRAPH_SAVE_VERSION,
  WORKFLOW_FORMAT,
  WORKFLOW_VERSION,
  makeGraphSave,
  parseGraphDocument,
  parseGraphSave,
} from '@pwn2block/shared';
import type { GraphDocument } from '@pwn2block/shared';
import { canvasStorageKey } from '../viewmodel/storage';
import type { KeyValueStore } from '../viewmodel/storage';
import { migrateBlocklyWorkspace } from './migrate-blockly';

/**
 * 画布存档（07 §P8；08 §4）。
 *
 * 三套键**同时存在**，这是迁移期有意为之：
 * - `pwn2block.graph.v1.<题目>`：本阶段的新格式（包装 + 依赖表），只写这里；
 * - `pwn2block.graph.<题目>`：P2–P7 期间的裸 `GraphDocument`，成功读取后搬到新键；
 * - `pwn2block.canvas.v1.<题目>`：Blockly 时代的旧存档，单向迁移后**原样保留**。
 *
 * 规则：
 * - 读取顺序 = 新格式 → 中期格式 → 旧积木；新格式坏了就报错，不偷偷回退到更旧的存档
 *   （否则用户会看到一份「自己消失了一部分修改」的图）。
 * - 只有验证通过的文档才写新键；任何失败都保留原文，由界面提供导出。
 * - 写入从不删除或覆盖旧键：回滚到旧版本时仍能读旧存档（07 §P9 第 6 条）。
 */

export const GRAPH_STORE_VERSION = 1;

/** 新格式的键。版本号是存档外层版本，不是题目版本。 */
export function graphStorageKey(challengeId: string): string {
  return `pwn2block.graph.v${GRAPH_STORE_VERSION}.${challengeId}`;
}

/** P2–P7 的裸图键（只读，用于迁移）。 */
export function interimGraphStorageKey(challengeId: string): string {
  return `pwn2block.graph.${challengeId}`;
}

export type GraphLoadSource = 'current' | 'interim' | 'blockly';

export type GraphLoadResult =
  | {
      readonly ok: true;
      readonly document: GraphDocument;
      readonly source: GraphLoadSource;
      /** 迁移过程中的说明（忽略的游离积木等），给界面提示用。 */
      readonly notes: readonly string[];
    }
  /** 完全没有可恢复内容：这是「首次进入」，界面给空画布，不算错误。 */
  | { readonly ok: false; readonly kind: 'empty' }
  /**
   * 有存档但读不出来：保留原文供导出，界面**不得**静默当成首次进入覆盖它（10 §5）。
   */
  | {
      readonly ok: false;
      readonly kind: 'corrupt';
      readonly reason: string;
      /** 读到的原始文本。 */
      readonly raw: string;
      /** 旧积木迁移失败的具体原因。 */
      readonly issues?: readonly string[];
      readonly source?: GraphLoadSource;
    };

function read(store: KeyValueStore | undefined, key: string): string | undefined {
  if (store === undefined) return undefined;
  try {
    return store.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(store: KeyValueStore | undefined, key: string, value: string): boolean {
  if (store === undefined) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** 读并迁移存档；调用方拿到 `ok` 才装进画布，`kind: 'empty'` 表示空画布。 */
export function loadGraph(
  store: KeyValueStore | undefined,
  challengeId: string,
): GraphLoadResult {
  const currentRaw = read(store, graphStorageKey(challengeId));
  if (currentRaw !== undefined && currentRaw !== '') {
    const parsed = parseJson(currentRaw);
    if (parsed === undefined) {
      return { ok: false, kind: 'corrupt', reason: '当前存档不是合法 JSON：保留原文，不加载也不覆盖', raw: currentRaw, source: 'current' };
    }
    const result = parseGraphSave(parsed, challengeId);
    if (!result.ok) {
      return { ok: false, kind: 'corrupt', reason: `当前存档不可用：${result.message}`, raw: currentRaw, source: 'current' };
    }
    return { ok: true, document: result.value.document, source: 'current', notes: [] };
  }

  const interimRaw = read(store, interimGraphStorageKey(challengeId));
  if (interimRaw !== undefined && interimRaw !== '') {
    const parsed = parseJson(interimRaw);
    if (parsed === undefined) {
      return { ok: false, kind: 'corrupt', reason: '旧画布存档不是合法 JSON：保留原文，不加载也不覆盖', raw: interimRaw, source: 'interim' };
    }
    const result = parseGraphDocument(parsed);
    if (!result.ok) {
      return { ok: false, kind: 'corrupt', reason: `旧画布存档不可用：${result.message}`, raw: interimRaw, source: 'interim' };
    }
    writeIfPossible(store, challengeId, result.document);
    return { ok: true, document: result.document, source: 'interim', notes: [] };
  }

  const legacyRaw = read(store, canvasStorageKey(challengeId));
  if (legacyRaw !== undefined && legacyRaw !== '') {
    const parsed = parseJson(legacyRaw);
    if (parsed === undefined) {
      return { ok: false, kind: 'corrupt', reason: '旧积木存档不是合法 JSON：保留原文，可导出后手工处理', raw: legacyRaw, source: 'blockly' };
    }
    const migrated = migrateBlocklyWorkspace(parsed);
    if (!migrated.ok) {
      return {
        ok: false,
        kind: 'corrupt',
        reason: '旧积木存档里有不受支持的积木：已保留原文，可导出后重做或等待支持',
        raw: legacyRaw,
        issues: migrated.reasons,
        source: 'blockly',
      };
    }
    writeIfPossible(store, challengeId, migrated.document);
    return { ok: true, document: migrated.document, source: 'blockly', notes: migrated.notes };
  }

  return { ok: false, kind: 'empty' };
}

function writeIfPossible(store: KeyValueStore | undefined, challengeId: string, document: GraphDocument): void {
  saveGraph(store, challengeId, document);
}

/**
 * 写新格式存档；返回是否真的落盘。
 *
 * 写之前再验一次依赖表与版本：调用方可能手工构造了不一致的文档，坏数据不该进存储。
 */
export function saveGraph(
  store: KeyValueStore | undefined,
  challengeId: string,
  document: GraphDocument,
): boolean {
  if (document.format !== WORKFLOW_FORMAT) return false;
  if (document.version !== WORKFLOW_VERSION) return false;
  const save = makeGraphSave(challengeId, document);
  const checked = parseGraphSave(save, challengeId);
  if (!checked.ok) return false;
  return write(store, graphStorageKey(challengeId), JSON.stringify(save));
}

/** 只删新格式键；旧键留给回滚版本读取（07 §P8、P9）。 */
export function clearGraph(store: KeyValueStore | undefined, challengeId: string): boolean {
  if (store === undefined) return false;
  try {
    store.removeItem?.(graphStorageKey(challengeId));
    return true;
  } catch {
    return false;
  }
}

/** 导出原始存档文本（失败时给用户留的出口）。 */
export function exportRaw(raw: string): string {
  return JSON.stringify(
    {
      format: 'pwn2block.raw-save',
      version: GRAPH_SAVE_VERSION,
      raw,
    },
    null,
    2,
  );
}
