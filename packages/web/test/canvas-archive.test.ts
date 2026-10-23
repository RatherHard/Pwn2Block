import { describe, expect, it } from 'vitest';
import {
  LEGACY_STORAGE_KEYS,
  discardLegacyArchives,
  legacyArchiveFile,
  legacyArchiveNotice,
  scanLegacyArchives,
  type LegacyArchive,
} from '../src/canvas/archive';
import { canvasV2StorageKey, type CanvasStore } from '../src/canvas/save';

/**
 * 旧存档探测与导出的验收（需求 §8）。
 *
 * 重点不是「能扫出来」，而是**扫的时候不骗人**：格式要认对、原文要一字不差、
 * 该抛的存储异常要抛出来、当前世代的键不能被当成旧档、删除只发生在显式丢弃时。
 */

/** 扫描要的存储：`CanvasStore` + 浏览器 `Storage` 的枚举能力。 */
type TestStore = CanvasStore & {
  readonly length: number;
  key(index: number): string | null;
};

function memoryStore(initial: Readonly<Record<string, string>> = {}): {
  readonly store: TestStore;
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const store: TestStore = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
      return true;
    },
    removeItem: (key) => data.delete(key),
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
  };
  return { store, data };
}

/** Blockly 时代的积木存档：没有 `format`，顶层 `blocks` 是对象。 */
const BLOCKLY_RAW = JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'p2b_action_feed' }] } });
/** `pwn2block.graph.v1.<题目>` 的内容：包装 + 依赖表。 */
const GRAPH_SAVE_RAW = JSON.stringify({ format: 'pwn2block.graph-save', version: 1, challengeId: 'ret2win' });
/** `pwn2block.graph.<题目>` / `pwn2block.workflow` 的内容：旧工作流文档。 */
const WORKFLOW_RAW = JSON.stringify({ format: 'pwn2block.workflow', version: 3, nodes: [] });
/** 上一版画布文档：`pwn2block.canvas` 但版本不是 2。 */
const OLD_CANVAS_RAW = JSON.stringify({ format: 'pwn2block.canvas', version: 1, nodes: [], layout: {}, main: [] });

const RET2WIN_KEYS: Readonly<Record<string, string>> = {
  'pwn2block.canvas.v1.ret2win': BLOCKLY_RAW,
  'pwn2block.graph.v1.ret2win': GRAPH_SAVE_RAW,
  'pwn2block.graph.ret2win': WORKFLOW_RAW,
};

describe('LEGACY_STORAGE_KEYS：探测顺序', () => {
  it('已知旧键前缀按由新到旧排列', () => {
    expect(LEGACY_STORAGE_KEYS[0]).toBe('pwn2block.canvas.v1.');
    expect(LEGACY_STORAGE_KEYS.indexOf('pwn2block.canvas.v1.')).toBeLessThan(
      LEGACY_STORAGE_KEYS.indexOf('pwn2block.graph.v1.'),
    );
    expect(LEGACY_STORAGE_KEYS.indexOf('pwn2block.graph.v1.')).toBeLessThan(
      LEGACY_STORAGE_KEYS.indexOf('pwn2block.graph.'),
    );
  });
});

describe('scanLegacyArchives：键形与格式识别', () => {
  it('空存储扫不出任何旧档', () => {
    const { store } = memoryStore();
    expect(scanLegacyArchives(store)).toEqual([]);
  });

  it('三类旧键各一条：格式与题目 id 各自认对', () => {
    const { store } = memoryStore(RET2WIN_KEYS);
    const archives = scanLegacyArchives(store);

    expect(archives.map((archive) => archive.key)).toEqual([
      'pwn2block.canvas.v1.ret2win',
      'pwn2block.graph.v1.ret2win',
      'pwn2block.graph.ret2win',
    ]);
    expect(archives.map((archive) => archive.format)).toEqual([
      'blockly',
      'pwn2block.graph-save',
      'pwn2block.workflow',
    ]);
    expect(archives.map((archive) => archive.challengeId)).toEqual(['ret2win', 'ret2win', 'ret2win']);
  });

  it('同一题的多个旧键按 canvas.v1 → graph.v1 → graph 排序', () => {
    const { store } = memoryStore({
      'pwn2block.graph.ret2win': WORKFLOW_RAW,
      'pwn2block.graph.v1.ret2win': BLOCKLY_RAW,
      'pwn2block.canvas.v1.ret2win': OLD_CANVAS_RAW,
    });
    expect(scanLegacyArchives(store).map((archive) => archive.key)).toEqual([
      'pwn2block.canvas.v1.ret2win',
      'pwn2block.graph.v1.ret2win',
      'pwn2block.graph.ret2win',
    ]);
  });

  it('有 format 字段就以字段为准：旧版画布文档仍报 pwn2block.canvas', () => {
    const { store } = memoryStore({ 'pwn2block.canvas.v1.ret2win': OLD_CANVAS_RAW });
    const archives = scanLegacyArchives(store);
    expect(archives[0].format).toBe('pwn2block.canvas');
  });

  it('pwn2block.canvas 但 version: 3 仍归旧版，不因「版本认得」被放过', () => {
    const { store } = memoryStore({
      'pwn2block.canvas.v1.ret2win': JSON.stringify({ format: 'pwn2block.canvas', version: 3, nodes: [] }),
    });
    const archives = scanLegacyArchives(store);
    expect(archives).toHaveLength(1);
    expect(archives[0].format).toBe('pwn2block.canvas');
  });

  it('没有 format、顶层有 blocks 对象 → blockly', () => {
    const { store } = memoryStore({ 'pwn2block.canvas.v1.ret2win': BLOCKLY_RAW });
    expect(scanLegacyArchives(store)[0].format).toBe('blockly');
  });

  it('没有 format、原文出现 blockly 字样 → blockly', () => {
    const raw = JSON.stringify([{ blockly: 'workspace' }]);
    const { store } = memoryStore({ 'pwn2block.canvas.v1.ret2win': raw });
    expect(scanLegacyArchives(store)[0].format).toBe('blockly');
  });

  it('不是 JSON → unknown，原文一字不改', () => {
    const raw = '这不是 JSON，是用户手改坏的存档\n第二行';
    const { store } = memoryStore({ 'pwn2block.graph.ret2win': raw });
    const archives = scanLegacyArchives(store);
    expect(archives[0].format).toBe('unknown');
    expect(archives[0].raw).toBe(raw);
    expect(archives[0].bytes).toBe(raw.length);
  });

  it('能解析但没有 format 也没有 Blockly 特征 → unknown', () => {
    const { store } = memoryStore({ 'pwn2block.graph.ret2win': JSON.stringify({ nodes: [] }) });
    expect(scanLegacyArchives(store)[0].format).toBe('unknown');
  });

  it('当前世代的 v2 键不出现在结果里', () => {
    const { store } = memoryStore({ [canvasV2StorageKey('ret2win')]: JSON.stringify({ format: 'pwn2block.canvas-save' }) });
    expect(scanLegacyArchives(store)).toEqual([]);
  });

  it('会话记录与视图标签不是画布存档，不出现在结果里', () => {
    const { store } = memoryStore({
      'pwn2block.session.v1.ret2win': JSON.stringify({ sessionId: 'abcdef0123456789' }),
      'p2b:view-tab': 'stack',
    });
    expect(scanLegacyArchives(store)).toEqual([]);
  });

  it('键形认不出任何旧前缀时 challengeId 为 undefined，但仍要能导出', () => {
    const { store } = memoryStore({ 'pwn2block.legacy-mystery': OLD_CANVAS_RAW });
    const archives = scanLegacyArchives(store);
    expect(archives).toHaveLength(1);
    expect(archives[0].challengeId).toBeUndefined();
    expect(legacyArchiveFile(archives[0]).text).toBe(OLD_CANVAS_RAW);
  });

  it('challengeId 过滤只返回该题', () => {
    const { store } = memoryStore({
      ...RET2WIN_KEYS,
      'pwn2block.canvas.v1.other': BLOCKLY_RAW,
      'pwn2block.graph.v1.other.v2': BLOCKLY_RAW,
    });
    const archives = scanLegacyArchives(store, 'ret2win');
    expect(archives.map((archive) => archive.challengeId)).toEqual(['ret2win', 'ret2win', 'ret2win']);
  });

  it('不带题目 id 的旧键不因过滤被排除', () => {
    const { store } = memoryStore({ 'pwn2block.workflow': WORKFLOW_RAW, ...RET2WIN_KEYS });
    const archives = scanLegacyArchives(store, 'ret2win');
    expect(archives.map((archive) => archive.key)).toContain('pwn2block.workflow');
    expect(archives.map((archive) => archive.challengeId)).toContain(undefined);
  });

  it('同一份存储两次扫描结果相等（顺序不依赖遍历顺序）', () => {
    const { store } = memoryStore({ ...RET2WIN_KEYS, 'pwn2block.workflow': WORKFLOW_RAW });
    expect(scanLegacyArchives(store, 'ret2win')).toEqual(scanLegacyArchives(store, 'ret2win'));
    expect(scanLegacyArchives(store)).toEqual(scanLegacyArchives(store));
  });
});

describe('scanLegacyArchives：存储异常不吞', () => {
  it('getItem 抛错（隐私模式）向上抛，不归 unknown、不返回空', () => {
    const store: TestStore = {
      getItem: () => {
        throw new Error('存储被禁用');
      },
      setItem: () => true,
      removeItem: () => true,
      length: 1,
      key: () => 'pwn2block.graph.ret2win',
    };
    expect(() => scanLegacyArchives(store)).toThrow('存储被禁用');
  });

  it('存储没有 length / key 时显式报错，不假装「没有旧存档」', () => {
    const plain: CanvasStore = { getItem: () => null, setItem: () => true, removeItem: () => true };
    expect(() => scanLegacyArchives(plain)).toThrow(/length/);
  });
});

describe('legacyArchiveFile：文件名与内容', () => {
  it('文件名带安全题目 id 与格式序号', () => {
    const { store } = memoryStore({ ...RET2WIN_KEYS, 'pwn2block.workflow': WORKFLOW_RAW });
    const names = scanLegacyArchives(store).map((archive) => legacyArchiveFile(archive).name);
    expect(names).toEqual([
      'pwn2block-legacy-ret2win-1.json',
      'pwn2block-legacy-ret2win-2.json',
      'pwn2block-legacy-ret2win-3.json',
      'pwn2block-legacy-unknown-4.json',
    ]);
  });

  it('题目 id 的其它字符替换成 -，文件名只用安全字符', () => {
    const { store } = memoryStore({ 'pwn2block.graph.题/目: v1': OLD_CANVAS_RAW });
    const name = legacyArchiveFile(scanLegacyArchives(store)[0]).name;
    expect(name).toMatch(/^pwn2block-legacy-[a-z0-9._-]+-\d+\.json$/);
    expect(name).not.toContain('/');
    expect(name).not.toContain(':');
    expect(name).not.toContain(' ');
  });

  it('内容与原文逐字相等（含换行与中文），不加 BOM', () => {
    const raw = '{\n  "format": "pwn2block.workflow",\n  "说明": "旧档，保留换行与中文"\n}\n';
    const { store } = memoryStore({ 'pwn2block.workflow': raw });
    const file = legacyArchiveFile(scanLegacyArchives(store)[0]);
    expect(file.text).toBe(raw);
    expect(file.text.startsWith('\uFEFF')).toBe(false);
    expect(file.text).toContain('\n  "说明"');
  });
});

describe('discardLegacyArchives：只删探测到的旧键', () => {
  it('删旧键、保留 v2 与其它题的旧键，返回删除数量，再扫为空', () => {
    const document = JSON.stringify({ format: 'pwn2block.canvas-save', version: 1, challengeId: 'ret2win' });
    const { store, data } = memoryStore({
      ...RET2WIN_KEYS,
      'pwn2block.graph.v1.other': GRAPH_SAVE_RAW,
      [canvasV2StorageKey('ret2win')]: document,
    });

    expect(discardLegacyArchives(store, 'ret2win')).toBe(3);
    expect(data.has(canvasV2StorageKey('ret2win'))).toBe(true);
    expect(data.has('pwn2block.graph.v1.other')).toBe(true);
    expect(scanLegacyArchives(store, 'ret2win')).toEqual([]);
  });

  it('按「只删扫描结果」的口径，不带题目 id 的全局旧键也在删除范围内', () => {
    const { store, data } = memoryStore({
      'pwn2block.workflow': WORKFLOW_RAW,
      [canvasV2StorageKey('ret2win')]: JSON.stringify({ format: 'pwn2block.canvas-save', version: 1 }),
    });
    expect(discardLegacyArchives(store, 'ret2win')).toBe(1);
    expect(data.has('pwn2block.workflow')).toBe(false);
    expect(data.has(canvasV2StorageKey('ret2win'))).toBe(true);
  });

  it('removeItem 抛错时向上抛，不汇报「已清干净」', () => {
    const store: TestStore = {
      getItem: () => WORKFLOW_RAW,
      setItem: () => true,
      removeItem: () => {
        throw new Error('删不掉');
      },
      length: 1,
      key: () => 'pwn2block.graph.ret2win',
    };
    expect(() => discardLegacyArchives(store)).toThrow('删不掉');
  });
});

describe('legacyArchiveNotice：界面文案', () => {
  it('没有旧档时 title / body 非空且给出下一步', () => {
    const notice = legacyArchiveNotice([]);
    expect(notice.title.length).toBeGreaterThan(0);
    expect(notice.body.length).toBeGreaterThan(0);
    expect(notice.body).toContain('新建');
  });

  it('有旧档时说明数量与大小，并给出「导出」「新建」的建议动作', () => {
    const { store } = memoryStore({ ...RET2WIN_KEYS, 'pwn2block.workflow': WORKFLOW_RAW });
    const archives: readonly LegacyArchive[] = scanLegacyArchives(store);
    const notice = legacyArchiveNotice(archives);

    expect(notice.title).toContain('4');
    expect(notice.title.length).toBeGreaterThan(0);
    expect(notice.body).toContain('导出');
    expect(notice.body).toContain('新建');
    expect(notice.body).toMatch(/\d+(\.\d+)? (B|KB)/);
    expect(notice.body).toContain('ret2win');
  });
});
