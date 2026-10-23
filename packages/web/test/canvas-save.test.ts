import { describe, expect, it } from 'vitest';
import { canvas } from '@pwn2block/shared';
import {
  CANVAS_SAVE_FORMAT,
  CANVAS_SAVE_VERSION,
  canvasV2StorageKey,
  clearCanvas,
  loadCanvas,
  makeCanvasSave,
  parseCanvasSave,
  saveCanvas,
  type CanvasStore,
} from '../src/canvas/save';

/**
 * 新版画布存档的验收（需求 §8）。
 *
 * 重点不是「能存能取」，而是**读到不该读的东西时怎么失败**：旧档、未来版本、串题的档、
 * 内层坏掉的档，各自的失败原因必须分得开，因为界面要据此给不同的下一步
 * （旧档→导出后重做；坏档→导出原文；串题→不加载）。
 */

const CHALLENGE = 'ret2win';

/** 失败用例的键必须能区分：`raw` 原样带回是「导出原文」的唯一来源。 */
function memoryStore(initial: Readonly<Record<string, string>> = {}): {
  readonly store: CanvasStore;
  readonly data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    store: {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => {
        data.set(key, value);
        return true;
      },
      removeItem: (key) => data.delete(key),
    },
  };
}

/** 写不进去的存储：模拟配额满 / 隐私模式。 */
const READ_ONLY_STORE: CanvasStore = {
  getItem: () => null,
  setItem: () => false,
  removeItem: () => false,
};

describe('parseCanvasSave：往返与失败原因', () => {
  it('makeCanvasSave → parseCanvasSave 往返相等（经过一次 JSON）', () => {
    const document = canvas.emptyCanvasDocument();
    const save = makeCanvasSave(CHALLENGE, document);

    expect(save.format).toBe(CANVAS_SAVE_FORMAT);
    expect(save.version).toBe(CANVAS_SAVE_VERSION);

    // 走一遍 JSON：模拟真正落盘再读回来的那份数据。
    const parsed = parseCanvasSave(JSON.parse(JSON.stringify(save)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save).toEqual(save);
    expect(parsed.save.document).toEqual(document);
  });

  it('旧工作流存档判 legacy，文案非空且点明不兼容', () => {
    const legacyWorkflow = parseCanvasSave({ format: 'pwn2block.workflow', version: 3, nodes: [] });
    expect(legacyWorkflow.ok).toBe(false);
    if (legacyWorkflow.ok) return;
    expect(legacyWorkflow.reason).toBe('legacy');
    expect(legacyWorkflow.message).toContain('旧版画布存档');
  });

  it('裸的新版画布文档（pwn2block.canvas）配合题目 id 可导入', () => {
    const document = canvas.emptyCanvasDocument();
    const parsed = parseCanvasSave(document, CHALLENGE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.save.format).toBe(CANVAS_SAVE_FORMAT);
    expect(parsed.save.challengeId).toBe(CHALLENGE);
    expect(parsed.save.document).toEqual(document);
  });

  it('裸的新版画布文档没给题目 id 时判 challenge，不猜归属', () => {
    // 裸文档不是「坏了」，缺的是「它属于哪道题」这条信息：界面该问一次，而不是让用户修文件。
    const parsed = parseCanvasSave(canvas.emptyCanvasDocument());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('challenge');
    expect(parsed.message).toContain('认不出属于哪道题');
  });

  it('外层是新格式、内层文档是旧格式时，整体仍报 legacy', () => {
    const parsed = parseCanvasSave({
      format: CANVAS_SAVE_FORMAT,
      version: CANVAS_SAVE_VERSION,
      challengeId: CHALLENGE,
      document: { format: 'pwn2block.workflow', version: 1, nodes: [] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('legacy');
    expect(parsed.message).toContain('旧版画布存档');
  });

  it('未来版本判 version', () => {
    const save = makeCanvasSave(CHALLENGE, canvas.emptyCanvasDocument());
    const parsed = parseCanvasSave({ ...save, version: 99 });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('version');
    expect(parsed.message).toContain('99');
  });

  it('别的题目的存档判 challenge，不加载', () => {
    const save = makeCanvasSave(CHALLENGE, canvas.emptyCanvasDocument());
    const parsed = parseCanvasSave(save, 'other-challenge');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('challenge');
    expect(parsed.message).toContain('other-challenge');
  });

  it('内层文档坏掉（nodes 不是数组）判 invalid，文案带出错路径', () => {
    const parsed = parseCanvasSave({
      format: CANVAS_SAVE_FORMAT,
      version: CANVAS_SAVE_VERSION,
      challengeId: CHALLENGE,
      document: { format: 'pwn2block.canvas', version: 2, nodes: 'nope', layout: {}, main: [] },
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid');
    expect(parsed.message).toContain('存档格式不对');
  });

  it('不是对象的输入判 invalid，不猜', () => {
    const parsed = parseCanvasSave(42);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe('invalid');
    expect(parsed.message).not.toBe('');
  });
});

describe('loadCanvas：空 / 坏 / 有效', () => {
  it('没存过是新画布，不是错误', () => {
    const loaded = loadCanvas(memoryStore().store, CHALLENGE);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('empty');
    expect(loaded.message).toBe('还没有保存过新版画布');
  });

  it('坏 JSON 判 corrupt，原文原样带回', () => {
    const raw = '{ not json';
    const loaded = loadCanvas(memoryStore({ [canvasV2StorageKey(CHALLENGE)]: raw }).store, CHALLENGE);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('corrupt');
    expect(loaded.raw).toBe(raw);
  });

  it('内容过不了校验也判 corrupt，并保留原文', () => {
    const raw = JSON.stringify({ format: 'pwn2block.workflow', version: 1 });
    const loaded = loadCanvas(memoryStore({ [canvasV2StorageKey(CHALLENGE)]: raw }).store, CHALLENGE);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.reason).toBe('corrupt');
    expect(loaded.raw).toBe(raw);
    expect(loaded.message).toContain('旧版画布存档');
  });

  it('存过的档读回来是 canvas-v2，文档相等', () => {
    const memory = memoryStore();
    const document = canvas.emptyCanvasDocument();
    expect(saveCanvas(memory.store, CHALLENGE, document)).toBe(true);

    const loaded = loadCanvas(memory.store, CHALLENGE);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.source).toBe('canvas-v2');
    expect(loaded.document).toEqual(document);
  });
});

describe('saveCanvas / clearCanvas', () => {
  it('键名按题目分开，且不与旧 Blockly 档的 v1 键重合', () => {
    expect(canvasV2StorageKey(CHALLENGE)).toBe('pwn2block.canvas.v2.ret2win');
    expect(canvasV2StorageKey('a')).not.toBe(canvasV2StorageKey('b'));
  });

  it('写入成功返回 true，落盘的是可被重新解析的存档', () => {
    const memory = memoryStore();
    expect(saveCanvas(memory.store, CHALLENGE, canvas.emptyCanvasDocument())).toBe(true);

    const raw = memory.data.get(canvasV2StorageKey(CHALLENGE));
    expect(raw).toBeDefined();
    if (raw === undefined) return;
    const parsed = parseCanvasSave(JSON.parse(raw), CHALLENGE);
    expect(parsed.ok).toBe(true);
  });

  it('写失败返回 false：存储拒绝写入与没有存储同口径', () => {
    expect(saveCanvas(READ_ONLY_STORE, CHALLENGE, canvas.emptyCanvasDocument())).toBe(false);
    expect(saveCanvas(undefined, CHALLENGE, canvas.emptyCanvasDocument())).toBe(false);
  });

  it('clearCanvas 删掉新版键', () => {
    const memory = memoryStore();
    expect(saveCanvas(memory.store, CHALLENGE, canvas.emptyCanvasDocument())).toBe(true);
    expect(memory.data.has(canvasV2StorageKey(CHALLENGE))).toBe(true);

    expect(clearCanvas(memory.store, CHALLENGE)).toBe(true);
    expect(memory.data.has(canvasV2StorageKey(CHALLENGE))).toBe(false);
    expect(loadCanvas(memory.store, CHALLENGE).ok).toBe(false);
  });

  it('clearCanvas 在没有存储时返回 false', () => {
    expect(clearCanvas(undefined, CHALLENGE)).toBe(false);
  });
});
