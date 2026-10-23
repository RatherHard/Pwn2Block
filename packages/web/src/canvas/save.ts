import { canvas } from '@pwn2block/shared';

/**
 * 新版画布的本地存档（需求 §8；08 §4）。
 *
 * 与旧 `graph/storage.ts` 的关系：**键不同、格式不同、互不迁移**。
 * - 旧档在 `pwn2block.graph.v1.<题目>`（包装 + 依赖表）、`pwn2block.graph.<题目>`（裸图）与
 *   `pwn2block.canvas.v1.<题目>`（Blockly 积木）。三者都由旧 `loadGraph` 负责，这里一概不碰。
 * - 新档在 `pwn2block.canvas.v2.<题目>`：外层是 `CanvasSave`，内层是 `CanvasDocument`。
 *   读到旧工作流档（`pwn2block.workflow`）就报 `legacy`，**不猜、不迁移、不改写**——
 *   迁移会让「读到旧存档」变成静默改数据。
 * - 裸的 `pwn2block.canvas` 文档（带 `format` / `version`、没有存档外层）不是旧档，是**新版文档本身**：
 *   导入时按裸文档处理，题目 id 由调用方给出；给不出来就报 `challenge`，不猜归属。
 *
 * 外层的 `challengeId` 是**冗余**的，但它让「DB 键对了、内容却是另一道题」这种串档在读取时
 * 立刻暴露，而不是等到用户发现自己的图少了几个节点。内层文档的形状仍由
 * `parseCanvasDocument` 负责（含 `format` / `version` 的顺序与文案），这里不重复实现。
 */

export const CANVAS_SAVE_FORMAT = 'pwn2block.canvas-save';
export const CANVAS_SAVE_VERSION = 1;

/** 存档外层版本同时进键名：`v2` 与旧 `pwn2block.canvas.v1` 分属两套，永不互相覆盖。 */
const CANVAS_STORE_VERSION = 2;

export interface CanvasSave {
  readonly format: typeof CANVAS_SAVE_FORMAT;
  readonly version: number;
  readonly challengeId: string;
  readonly document: canvas.CanvasDocument;
}

export type CanvasSaveParse =
  | { readonly ok: true; readonly save: CanvasSave }
  | {
      readonly ok: false;
      readonly reason: 'legacy' | 'format' | 'version' | 'challenge' | 'invalid';
      readonly message: string;
    };

/**
 * 存档接口。
 *
 * **不复用旧 `viewmodel/storage.ts` 的 `KeyValueStore`**：那个接口的 `setItem` / `removeItem`
 * 返回 `void`（`removeItem` 还是可选的），拿不到「到底写进去了没有」；而这里要按
 * `saveGraph` 的口径把写入结果如实交给调用方。两者形状不同，所以在阶段三之前各留一份，
 * 届时由调用点写一个 `void → boolean` 的薄包装接起来（`try` 成功即 `true`）。
 */
export interface CanvasStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): boolean;
  removeItem(key: string): boolean;
}

export type CanvasLoad =
  | { readonly ok: true; readonly document: canvas.CanvasDocument; readonly source: 'canvas-v2' }
  | { readonly ok: false; readonly reason: 'empty' | 'corrupt'; readonly message: string; readonly raw?: string };

/** 新版画布的键。与旧的 `pwn2block.canvas.v1.<题目>`（Blockly）只差版本号，靠它区分。 */
export function canvasV2StorageKey(challengeId: string): string {
  return `pwn2block.canvas.v${CANVAS_STORE_VERSION}.${challengeId}`;
}

export function makeCanvasSave(challengeId: string, document: canvas.CanvasDocument): CanvasSave {
  return { format: CANVAS_SAVE_FORMAT, version: CANVAS_SAVE_VERSION, challengeId, document };
}

/**
 * 解析一份新版画布存档：外层形状 → `format` → `version` → 题目 id → 内层文档。
 *
 * `format` 分三种：
 * - `pwn2block.canvas-save`：本模块的包装，逐层往下查；
 * - `pwn2block.canvas`：**裸的新版画布文档**（没有存档外层，例如用户从「导出文档」拿到的文件）。
 *   题目 id 无法从文档里得知，所以必须由调用方指定题目；
 * - `pwn2block.workflow`：旧工作流存档，报 `legacy` 并保留原文提示，不猜、不迁移。
 *
 * 顺序是刻意的：先认出是哪种东西，再谈版本与题目，最后才验内层文档形状。
 * 内层文档的 `legacy` 整体上报 `legacy`，其余失败一律 `invalid`
 * （文案直接用 `parseCanvasDocument` 的，不做二次解释）。
 */
export function parseCanvasSave(raw: unknown, expectedChallengeId?: string): CanvasSaveParse {
  if (!isRecord(raw)) {
    return { ok: false, reason: 'invalid', message: '存档不是一个对象，认不出是不是新版画布存档' };
  }

  const format = raw['format'];
  if (format === canvas.CANVAS_FORMAT) return parseBareDocument(raw, expectedChallengeId);
  if (format === canvas.LEGACY_WORKFLOW_FORMAT) {
    return { ok: false, reason: 'legacy', message: legacyMessage(format) };
  }
  if (format !== CANVAS_SAVE_FORMAT) {
    return {
      ok: false,
      reason: 'format',
      message: `存档格式是 ${String(format)}，不是新版画布存档格式 ${CANVAS_SAVE_FORMAT}；请新建画布后再保存`,
    };
  }

  const version = raw['version'];
  if (version !== CANVAS_SAVE_VERSION) {
    return {
      ok: false,
      reason: 'version',
      message: `存档版本 ${String(version)} 不受支持，当前只认版本 ${CANVAS_SAVE_VERSION}`,
    };
  }

  const challengeId = raw['challengeId'];
  if (typeof challengeId !== 'string' || challengeId === '') {
    return { ok: false, reason: 'invalid', message: '存档没有记录题目 id，无法判断它属于哪道题' };
  }
  if (expectedChallengeId !== undefined && challengeId !== expectedChallengeId) {
    return {
      ok: false,
      reason: 'challenge',
      message: `存档属于题目 ${challengeId}，当前题目是 ${expectedChallengeId}；不加载别的题目的画布`,
    };
  }

  const document = canvas.parseCanvasDocument(raw['document']);
  if (!document.ok) {
    const reason = document.reason === 'legacy' ? 'legacy' : 'invalid';
    return { ok: false, reason, message: document.message };
  }
  return {
    ok: true,
    save: {
      format: CANVAS_SAVE_FORMAT,
      version: CANVAS_SAVE_VERSION,
      challengeId,
      document: document.document,
    },
  };
}

/**
 * 裸文档：形状由 `parseCanvasDocument` 判，题目 id 只能来自调用方。
 *
 * 没给题目就报 `challenge` 而不是 `invalid`：文档本身没问题，缺的是「它属于哪道题」这条信息，
 * 界面据此可以再问一次题目，而不是让用户去修文件。
 */
function parseBareDocument(
  raw: Record<string, unknown>,
  expectedChallengeId: string | undefined,
): CanvasSaveParse {
  const document = canvas.parseCanvasDocument(raw);
  if (!document.ok) {
    return { ok: false, reason: bareFailureReason(document.reason), message: document.message };
  }
  if (expectedChallengeId === undefined || expectedChallengeId === '') {
    return {
      ok: false,
      reason: 'challenge',
      message: '这份是新版画布文档本身，没有存档外层，认不出属于哪道题；请指定题目后导入',
    };
  }
  return { ok: true, save: makeCanvasSave(expectedChallengeId, document.document) };
}

/**
 * 裸文档的失败原因映射。
 *
 * `legacy` / `format` 在这一分支不可达（`format` 已经确认是 `pwn2block.canvas`），
 * 归到 `invalid` 只为让映射是完备的，不额外解释。
 */
function bareFailureReason(
  reason: canvas.ParseCanvasFailureReason,
): 'legacy' | 'invalid' | 'version' {
  if (reason === 'version') return 'version';
  if (reason === 'legacy') return 'legacy';
  return 'invalid';
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

/**
 * 读存档。
 *
 * 三种结果对应三种界面动作：`empty` → 空画布；`canvas-v2` → 装进画布；
 * `corrupt` → **保留原文**（`raw` 原样带回，界面给「导出原文」的出口），绝不静默覆盖。
 */
export function loadCanvas(store: CanvasStore | undefined, challengeId: string): CanvasLoad {
  const raw = read(store, canvasV2StorageKey(challengeId));
  if (raw === undefined) return { ok: false, reason: 'empty', message: '还没有保存过新版画布' };

  const parsed = parseJson(raw);
  if (parsed === undefined) {
    return {
      ok: false,
      reason: 'corrupt',
      message: '新版画布存档不是合法 JSON：已保留原文，可导出后手工处理',
      raw,
    };
  }
  const result = parseCanvasSave(parsed, challengeId);
  if (!result.ok) {
    return { ok: false, reason: 'corrupt', message: `新版画布存档不可用：${result.message}`, raw };
  }
  return { ok: true, document: result.save.document, source: 'canvas-v2' };
}

/**
 * 写存档；返回是否真的落盘（与旧 `saveGraph` 同口径：`false` 只表示本地保存不可用，
 * 调用方不该因此中断做题）。
 *
 * 写之前**自证一遍**：调用方可能手工拼了一份不一致的文档，坏数据不该进存储。
 */
export function saveCanvas(
  store: CanvasStore | undefined,
  challengeId: string,
  document: canvas.CanvasDocument,
): boolean {
  const save = makeCanvasSave(challengeId, document);
  const checked = parseCanvasSave(save, challengeId);
  if (!checked.ok) return false;
  return write(store, canvasV2StorageKey(challengeId), JSON.stringify(save));
}

/** 只删新版键；旧档留给回滚的版本读取（07 §P9 第 6 条）。 */
export function clearCanvas(store: CanvasStore | undefined, challengeId: string): boolean {
  if (store === undefined) return false;
  try {
    return store.removeItem(canvasV2StorageKey(challengeId));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 旧工作流（`pwn2block.workflow`）不认，但要说清那是旧档，别让用户以为文件坏了。 */
function legacyMessage(format: unknown): string {
  return `这是旧版画布存档（${String(format)}），新版画布不兼容；请先导出旧文件，再新建画布`;
}

/** 读不到（没存过、存储被禁、读到空串）一律当作「没有」；空串是旧接口删键的退化写法。 */
function read(store: CanvasStore | undefined, key: string): string | undefined {
  if (store === undefined) return undefined;
  try {
    const raw = store.getItem(key);
    return raw === null || raw === '' ? undefined : raw;
  } catch {
    return undefined;
  }
}

function write(store: CanvasStore | undefined, key: string, value: string): boolean {
  if (store === undefined) return false;
  try {
    return store.setItem(key, value);
  } catch {
    return false;
  }
}

/**
 * 解析失败返回 `undefined` 作哨兵：`JSON.parse` 永远不会产出 `undefined`（`null` 才是 `null`），
 * 所以这个哨兵不会和合法内容撞上。
 */
function parseJson(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return undefined;
  }
}
