import { sessionStorageKey } from '../viewmodel/storage';
import { canvasV2StorageKey } from './save';
import type { CanvasStore } from './save';

/**
 * 旧存档探测与导出（需求 §8；《节点画布大型修改》§8「存档与兼容」）。
 *
 * 新版画布不迁移旧图，但对旧存档只做三件事：**认出来、告诉用户、把原文导出去**。
 * 本模块不迁移、不改写、不清空；删除只发生在用户显式「主动新建新版画布」时
 * （`discardLegacyArchives`），而且只删本模块探测到的那几个键。
 *
 * 为什么单独成模块、不塞进 `save.ts`：`save.ts` 只认当前世代
 * （`pwn2block.canvas.v2.<题目>`）与「这是旧档」这一条失败原因；它不枚举存储、
 * 不认旧键的形状，读取路径上也不该顺手清理。旧键的形状是历史事实
 * （`graph/storage.ts` 的 `graph.v1` / 裸图、`viewmodel/storage.ts:40` 的 `canvas.v1`、
 * `@pwn2block/shared` 的 `LEGACY_WORKFLOW_FORMAT`，即 `pwn2block.workflow`），把它们集中在这里，
 * 将来再加一代存档只需往 `LEGACY_STORAGE_KEYS` 前面插一行。
 *
 * 三条硬约束：
 * 1. **不吞异常**：`getItem` / `key` / `removeItem` 抛错（隐私模式、配额、被策略拦下）
 *    一律向上抛，由界面决定提示还是降级。这里只有 `JSON.parse` 失败是可预期的
 *    「认不出」，归 `unknown`，不算错误。
 * 2. **只读遍历**：`length` + `key(i)` 正序扫一遍，扫描期间绝不删除——边遍历边删会让
 *    下标错位，漏掉后面的键。删除是 `discardLegacyArchives` 的独立一步，删的是扫描**结果**。
 * 3. **原文即导出**：`raw` 一字不改（不加 BOM、不重新序列化、不做换行归一），
 *    用户拿到的文件必须能原样喂回旧版本画布。
 */

/** 已知的旧存档键前缀，顺序即探测顺序（越新的越靠前，同一题优先报最新的）。 */
export const LEGACY_STORAGE_KEYS: readonly string[] = [
  'pwn2block.canvas.v1.',
  'pwn2block.graph.v1.',
  'pwn2block.graph.',
  'pwn2block.workflow',
];

/** 认不出的格式：不是 JSON，或能解析但既没有 `format` 也没有 Blockly 特征。 */
const FORMAT_UNKNOWN = 'unknown';
/** Blockly 时代的积木存档：没有 `format` 字段，只能靠顶层 `blocks` 或原文里的字样认出。 */
const FORMAT_BLOCKLY = 'blockly';
/** 拆不出题目 id 时，导出文件名里的兜底标签。 */
const UNKNOWN_CHALLENGE = 'unknown';

/** 旧存档都在这棵命名空间下；`p2b:view-tab` 之类别的键不归这里管。 */
const ARCHIVE_KEY_ROOT = 'pwn2block.';
/** 当前世代的键（`pwn2block.canvas.v2.`）：不是旧档，扫描时跳过。 */
const CURRENT_CANVAS_KEY_PREFIX = canvasV2StorageKey('');
/** 会话记录（`pwn2block.session.v1.`）：不是画布存档，扫描时跳过。 */
const SESSION_KEY_PREFIX = sessionStorageKey('');
/** `viewmodel/storage.ts` 探测可写性留下的探针键；本该立刻删掉，残留也不该报成旧档。 */
const PROBE_KEY_PREFIX = 'pwn2block.probe.';

/** 导出文件名里只允许这些字符；题目 id 的其它字符一律换成 `-`。 */
const UNSAFE_NAME_PATTERN = /[^a-z0-9._-]/g;

/**
 * 扫描需要的存储形状：浏览器 `Storage` 的**枚举能力**。
 *
 * `save.ts` 的 `CanvasStore` 只有 `getItem` / `setItem` / `removeItem`，枚举不出键；
 * 而「扫出所有旧存档」必须能问出「有哪些键」。所以这里单独声明 `length` + `key(i)`，
 * 由调用点的存储适配器满足（`localStorage` 本身就有）。本模块用不上 `setItem`，
 * 所以不要求它——扫描不该需要写权限。
 */
export interface ArchiveStore {
  getItem(key: string): string | null;
  removeItem(key: string): boolean;
  readonly length: number;
  key(index: number): string | null;
}

export interface LegacyArchive {
  readonly key: string;
  /** 从键里拆出的题目 id；键形不符合任何旧前缀时为 undefined（仍然要能导出）。 */
  readonly challengeId: string | undefined;
  /** 识别出的格式标识：`pwn2block.workflow`、`pwn2block.canvas`、`blockly` 或 `unknown`。 */
  readonly format: string;
  /** 原文，导出时一字不改。 */
  readonly raw: string;
  /** `raw.length`（UTF-16 码元），界面按它显示「12 KB」这类粗略大小。 */
  readonly bytes: number;
}

/**
 * 扫出所有旧存档；`challengeId` 给定时只看这一题。
 *
 * 结果按「同一题取最新格式」与键名排序，同一份存储两次扫描必然 `toEqual`：
 * 排序键只有档位（`LEGACY_STORAGE_KEYS` 的下标）与键名本身，不依赖遍历顺序。
 *
 * 过滤的边界是刻意的：只有**能拆出题目 id**的键才受 `challengeId` 约束。像
 * `pwn2block.workflow` 这种键本身不带题目归属，用户仍有导出的必要，
 * 所以任何一次探测都会看到它，不因过滤被悄悄漏掉。
 */
export function scanLegacyArchives(store: CanvasStore, challengeId?: string): readonly LegacyArchive[] {
  const enumerable = asArchiveStore(store);
  const length = enumerable.length;
  const found: LegacyArchive[] = [];

  for (let index = 0; index < length; index += 1) {
    const key = enumerable.key(index);
    if (key === null || !isArchiveKey(key)) continue;

    const shape = readKeyShape(key);
    if (challengeId !== undefined && shape.challengeId !== undefined && shape.challengeId !== challengeId) {
      continue;
    }

    const raw = enumerable.getItem(key);
    // `null` 表示扫描途中被别的标签页删了；空串是旧接口「删键」的退化写法，都当没有。
    if (raw === null || raw === '') continue;
    found.push({ key, challengeId: shape.challengeId, format: classifyFormat(raw), raw, bytes: raw.length });
  }

  return [...found].sort(compareArchives);
}

/** 导出文件名与内容（内容 = 原文，保证可回滚）。文件名只用安全字符。 */
export function legacyArchiveFile(archive: LegacyArchive): { readonly name: string; readonly text: string } {
  const label = safeChallengeLabel(archive.challengeId);
  return { name: `pwn2block-legacy-${label}-${archiveOrdinal(archive.key)}.json`, text: archive.raw };
}

/** 提示文案：返回一句中文说明 + 建议动作，界面直接显示。 */
export function legacyArchiveNotice(
  archives: readonly LegacyArchive[],
): { readonly title: string; readonly body: string } {
  if (archives.length === 0) {
    return {
      title: '没有发现旧版画布存档',
      body: '本地没有需要导出的旧存档，可以直接新建新版画布；新版画布与旧存档互不覆盖。',
    };
  }
  const bytes = archives.reduce((total, archive) => total + archive.bytes, 0);
  return {
    title: `发现 ${archives.length} 份旧版画布存档，新版画布读不了`,
    body:
      `旧存档不会被自动迁移、清空或覆盖。建议先「导出」原文备份（共 ${formatBytes(bytes)}），` +
      `确认备份后再主动「新建」新版画布；导出后旧存档仍保留，直到你明确丢弃。` +
      `涉及题目：${challengeSummary(archives)}。`,
  };
}

/** 显式「主动新建新版画布」时才调用：只删探测到的旧键，不动 v2 键。返回删掉的数量。 */
export function discardLegacyArchives(store: CanvasStore, challengeId?: string): number {
  const archives = scanLegacyArchives(store, challengeId);
  let removed = 0;
  for (const archive of archives) {
    // `removeItem` 抛错（隐私模式）时向上抛：删失败必须让调用方知道，不能假装清干净了。
    if (store.removeItem(archive.key)) removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// 键形与格式识别
// ---------------------------------------------------------------------------

interface KeyShape {
  /** 在 `LEGACY_STORAGE_KEYS` 里的下标：0 最新；`length` 表示认不出键形。 */
  readonly tier: number;
  /** 键里拆出的题目 id；键名不带题目 id（或认不出键形）时为 undefined。 */
  readonly challengeId: string | undefined;
}

/** 按 `LEGACY_STORAGE_KEYS` 的顺序取**第一个**匹配的前缀：`graph.` 不会抢走 `graph.v1.`。 */
function readKeyShape(key: string): KeyShape {
  const index = LEGACY_STORAGE_KEYS.findIndex((prefix) => key.startsWith(prefix));
  if (index < 0) return { tier: LEGACY_STORAGE_KEYS.length, challengeId: undefined };
  const rest = key.slice(LEGACY_STORAGE_KEYS[index].length);
  return { tier: index, challengeId: rest === '' ? undefined : rest };
}

/** 只看键：是不是本模块该管的旧存档候选（当前世代与会话记录除外）。 */
function isArchiveKey(key: string): boolean {
  if (!key.startsWith(ARCHIVE_KEY_ROOT)) return false;
  if (key.startsWith(CURRENT_CANVAS_KEY_PREFIX)) return false;
  if (key.startsWith(SESSION_KEY_PREFIX)) return false;
  return !key.startsWith(PROBE_KEY_PREFIX);
}

/**
 * 只分类，不迁移：
 * 1. 能 JSON 解析且 `format` 是非空字符串 → 直接用该字段（`pwn2block.workflow` 就是旧工作流，
 *    `pwn2block.canvas` 且 `version !== 2` 就是旧版画布文档；这里不读版本，也不判断可读性）；
 * 2. 没有 `format` 但有 Blockly 特征（顶层 `blocks` 是对象，或原文出现 `blockly` 字样）→ `blockly`；
 * 3. 其余（含解析失败）→ `unknown`。
 */
function classifyFormat(raw: string): string {
  const parsed = parseJson(raw);
  if (parsed === undefined) return FORMAT_UNKNOWN;

  if (isRecord(parsed)) {
    const format = parsed['format'];
    if (typeof format === 'string' && format !== '') return format;
    if (isRecord(parsed['blocks'])) return FORMAT_BLOCKLY;
  }
  return raw.toLowerCase().includes('blockly') ? FORMAT_BLOCKLY : FORMAT_UNKNOWN;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 档位升序（0 最新），同档位按键名升序：不用 `localeCompare`，避免不同机器排序不一致。 */
function compareArchives(left: LegacyArchive, right: LegacyArchive): number {
  const tierDelta = readKeyShape(left.key).tier - readKeyShape(right.key).tier;
  if (tierDelta !== 0) return tierDelta;
  if (left.key < right.key) return -1;
  return left.key > right.key ? 1 : 0;
}

/**
 * 文件名里的序号 = 档位 + 1（1 是最新一代旧格式，往下依次更旧）。
 * 认不出档位（键形不符合任何旧前缀）记 0：既不冒充某个已知档位，也让文件名保持安全字符。
 */
function archiveOrdinal(key: string): number {
  const tier = readKeyShape(key).tier;
  return tier >= LEGACY_STORAGE_KEYS.length ? 0 : tier + 1;
}

function safeChallengeLabel(challengeId: string | undefined): string {
  if (challengeId === undefined) return UNKNOWN_CHALLENGE;
  const safe = challengeId.replace(UNSAFE_NAME_PATTERN, '-');
  return safe === '' ? UNKNOWN_CHALLENGE : safe;
}

/** 文案里的题目清单：去重、保持扫描结果的顺序，认不出归属的记 `unknown`。 */
function challengeSummary(archives: readonly LegacyArchive[]): string {
  const labels = archives.map((archive) => archive.challengeId ?? UNKNOWN_CHALLENGE);
  return [...new Set(labels)].join('、');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round((bytes / 1024) * 10) / 10} KB`;
}

/**
 * 把 `CanvasStore` 收窄成可枚举的 `ArchiveStore`。
 *
 * 不用 `as`：运行时真的问一遍 `length` / `key` 是否是所需的形状。缺了就**显式抛错**，
 * 而不是悄悄返回空列表——那会让界面显示「没有旧存档」，然后在用户新建画布时把旧数据
 * 变成不可达的孤儿。调用点应传带枚举能力的适配器（`localStorage` 本身就有）。
 */
function asArchiveStore(store: CanvasStore): ArchiveStore {
  const candidate: unknown = store;
  if (!isArchiveStore(candidate)) {
    throw new Error('这个存储不支持按键枚举（缺少 length / key），无法扫描旧存档');
  }
  return candidate;
}

function isArchiveStore(value: unknown): value is ArchiveStore {
  if (!isRecord(value)) return false;
  return typeof value['length'] === 'number' && typeof value['key'] === 'function';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析失败返回 `undefined` 作哨兵：`JSON.parse` 永远不会产出 `undefined`，不会和合法内容撞上。 */
function parseJson(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return undefined;
  }
}
