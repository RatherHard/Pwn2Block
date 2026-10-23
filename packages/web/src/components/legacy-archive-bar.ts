import { LitElement, css, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import {
  discardLegacyArchives,
  legacyArchiveFile,
  legacyArchiveNotice,
  scanLegacyArchives,
  type LegacyArchive,
} from '../canvas/archive';
import type { CanvasStore } from '../canvas/save';
import { sharedStyles, terminalTheme } from '../theme';
import type { KeyValueStore } from '../viewmodel/storage';

/**
 * 旧档提示条 `<pwn2block-legacy-archive-bar>`（《节点画布大型修改》§8「存档与兼容」）。
 *
 * 新版画布不迁移旧图，但对旧存档只做三件事：**认出来、告诉用户、把原文导出去**。
 * 提示条是**非模态**的：它不挡画布、也不改任何存档；删除只发生在用户点第二次「确认丢弃」
 * 之后（`discardLegacyArchives`），而且只删扫描到的那几个旧键。
 *
 * 组件自己管扫描（`store` / `challengeId` 到位时扫一次、换题重扫、丢弃后重扫），
 * 外壳只把本地存储与题目 id 交进来，并在画布面板从 v2 键里读到旧档时贴一句 `alert`。
 *
 * 同模块导出 `canvasStoreOf`：`KeyValueStore.setItem` 返回 `void`，而画布存档与旧档探测
 * 都要知道「到底写进去了没有」（`canvas/save.ts` 的接口注释点名由调用点补这层包装）。
 * 页面壳对画布面板的存储绑定用的是同一个适配，避免两份形状不同的实现漂移。
 */

/** 可枚举存储的最小形状：旧档探测要按键扫描（`canvas/archive.ts` 的 `ArchiveStore`）。 */
interface EnumerableKeys {
  readonly length: number;
  key(index: number): string | null;
}

/**
 * 提示条的样式：与仓库其他组件同一套口径（只引用主题 token，不用渐变、阴影、半透明色）。
 * 层级靠 1px 边框与语义色区分；文案本身承载信息，颜色不是唯一载体（05 §7）。
 */
const legacyBarStyles = css`
  :host {
    display: block;
    flex: none;
    margin: 0 0 0.6rem;
  }

  :host([hidden]) {
    display: none;
  }

  .legacy {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.7rem;
    border: 1px solid var(--p2b-changed);
    border-radius: 0;
    color: var(--p2b-changed);
    background: var(--p2b-bg);
  }

  p {
    flex-basis: 100%;
    margin: 0;
  }

  .title {
    color: var(--p2b-fg);
  }

  .body {
    color: var(--p2b-dim);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    flex-basis: 100%;
  }
`;

export class LegacyArchiveBar extends LitElement {
  static override styles = [terminalTheme, sharedStyles, legacyBarStyles];

  static override properties = {
    store: { attribute: false },
    challengeId: { attribute: false },
    alert: { attribute: false },
  };

  /** 能按键枚举的存储（`localStorage` 本身）：扫描、导出、丢弃都走它。 */
  declare store?: CanvasStore;

  /** 当前题目：只提示这一题的旧档，另外列出键名不带题目归属的旧档（`pwn2block.workflow`）。 */
  declare challengeId?: string;

  /** 外壳贴过来的一句说明；这里不二次解释，原文交给用户判断。 */
  declare alert?: string;

  private archives: readonly LegacyArchive[] = [];
  /** 「新建新版画布」的二次确认：非模态，第二次点击才真的删。 */
  private confirming = false;
  /** 扫描 / 导出 / 丢弃失败的原因：显式显示，不静默吞掉。 */
  private failure?: string;

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has('store') || changed.has('challengeId')) this.scan();
  }

  override render() {
    const alert = this.failure ?? this.alert;
    const archives = this.archives;
    if (alert === undefined && archives.length === 0) return nothing;
    const notice = legacyArchiveNotice(archives);
    return html`<div class="legacy" role="status" aria-live="polite" aria-label="旧版画布存档提示">
      ${alert === undefined ? nothing : html`<p class="title">${alert}</p>`}
      ${archives.length === 0
        ? nothing
        : html`<p class="title">${notice.title}</p>
            <p class="body">${notice.body}</p>
            ${this.renderActions(archives.length)}`}
    </div>`;
  }

  /** 两个出口：导出原文（可回滚）与「新建新版画布」（二次确认后丢弃旧键）。 */
  private renderActions(count: number) {
    if (this.confirming) {
      return html`<div class="actions">
        <button type="button" @click=${this.onDiscard}>确认丢弃 ${count} 份旧存档</button>
        <button type="button" @click=${this.onCancel}>取消</button>
      </div>`;
    }
    return html`<div class="actions">
      <button type="button" @click=${this.onExport}>导出旧存档</button>
      <button type="button" @click=${this.onAskNew}>新建新版画布</button>
    </div>`;
  }

  /**
   * 扫一遍旧档（只读：`canvas/archive.ts` 保证扫描期间不删任何键）。
   * 读不出来时退化成一句说明，而不是显示「没有旧档」——那会把「读不到」说成「没有」。
   */
  private scan(): void {
    const store = this.store;
    const challengeId = this.challengeId;
    if (store === undefined || challengeId === undefined) return;
    this.confirming = false;
    try {
      this.archives = scanLegacyArchives(store, challengeId);
      this.failure = undefined;
    } catch (error) {
      this.archives = [];
      this.failure = `读不出本地旧存档：${messageOf(error)}`;
    }
  }

  /** 导出：逐份下载原文（`raw` 一字不改，能原样喂回旧版本画布）。 */
  private readonly onExport = (): void => {
    try {
      for (const archive of this.archives) {
        const file = legacyArchiveFile(archive);
        downloadText(file.name, file.text);
      }
      this.failure = undefined;
    } catch (error) {
      this.failure = `导出旧存档失败：${messageOf(error)}`;
    }
    this.requestUpdate();
  };

  /** 第一次点击只切到「确认」：丢弃不可撤销，不能一点就删。 */
  private readonly onAskNew = (): void => {
    this.confirming = true;
    this.requestUpdate();
  };

  private readonly onCancel = (): void => {
    this.confirming = false;
    this.requestUpdate();
  };

  /** 第二次点击才真的删：只删扫描到的旧键，v2 键与其它题目一概不动。 */
  private readonly onDiscard = (): void => {
    const store = this.store;
    const challengeId = this.challengeId;
    this.confirming = false;
    if (store === undefined || challengeId === undefined) {
      this.failure = '本地存储不可用：旧存档没有删除';
      this.requestUpdate();
      return;
    }
    let removed: number;
    try {
      removed = discardLegacyArchives(store, challengeId);
    } catch (error) {
      this.failure = `丢弃旧存档失败：${messageOf(error)}`;
      this.requestUpdate();
      return;
    }
    this.scan();
    if (removed === 0 && this.archives.length > 0) {
      this.failure = '旧存档没有被删除：本地存储拒绝了删除操作';
    }
    this.requestUpdate();
  };
}

/**
 * `KeyValueStore` → `CanvasStore`：旧接口的 `setItem` 返回 `void`，画布要的是
 * 「到底写进去了没有」。内层存储带 `length` / `key`（例如 `localStorage`）时把枚举能力
 * 一并透出——旧档扫描靠它；缺了就只能提示「读不出本地旧存档」，而不是谎报「没有旧档」。
 */
export function canvasStoreOf(store: KeyValueStore): CanvasStore {
  return new CanvasStoreAdapter(store);
}

class CanvasStoreAdapter implements CanvasStore {
  private readonly keys: EnumerableKeys | undefined;

  constructor(private readonly inner: KeyValueStore) {
    this.keys = enumerableOf(inner);
  }

  getItem(key: string): string | null {
    return this.inner.getItem(key);
  }

  setItem(key: string, value: string): boolean {
    try {
      this.inner.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  removeItem(key: string): boolean {
    try {
      if (this.inner.removeItem !== undefined) {
        this.inner.removeItem(key);
        return true;
      }
      // 没有 `removeItem` 的实现退化成写空串：读取侧一律把空串当「没有」。
      this.inner.setItem(key, '');
      return true;
    } catch {
      return false;
    }
  }

  get length(): number {
    return this.keys?.length ?? 0;
  }

  key(index: number): string | null {
    return this.keys?.key(index) ?? null;
  }
}

/** 按键枚举能力：运行时真的问一遍形状，缺了就返回 `undefined`（不靠类型断言）。 */
function enumerableOf(store: KeyValueStore): EnumerableKeys | undefined {
  const candidate: unknown = store;
  if (!isRecord(candidate)) return undefined;
  const length: unknown = candidate['length'];
  const key: unknown = candidate['key'];
  if (typeof length !== 'number' || typeof key !== 'function') return undefined;
  return {
    length,
    key: (index: number) => {
      const value: unknown = key.call(candidate, index);
      return typeof value === 'string' ? value : null;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 交给浏览器下载旧档原文：`Blob` + 对象 URL + `<a download>`，文件名来自 `legacyArchiveFile`。 */
function downloadText(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

customElements.define('pwn2block-legacy-archive-bar', LegacyArchiveBar);

declare global {
  interface HTMLElementTagNameMap {
    'pwn2block-legacy-archive-bar': LegacyArchiveBar;
  }
}
