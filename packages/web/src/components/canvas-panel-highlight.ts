/**
 * 「定位到某个节点」的高亮（需求 §6.4：`locate` 滚动过去并高亮 1.2 秒后自动消失）。
 *
 * 状态只有「当前高亮谁」和「那个定时器」，但两者必须一起清，否则连续两次 `locate`
 * 会让第一次的定时器提前熄掉第二次的高亮——所以收在一个小对象里，调用方只管 `show`。
 */

/** 高亮持续时间：1.2 秒（需求给的数值）。 */
const HIGHLIGHT_MS = 1200;

export class CanvasHighlight {
  private nodeId: string | undefined;
  private timer: number | undefined;

  /** `onExpire` 在自动熄灭时调用（组件里就是请求重渲染）。 */
  constructor(private readonly onExpire: () => void) {}

  current(): string | undefined {
    return this.nodeId;
  }

  /** 高亮某个节点：重设定时器，1.2 秒后自动熄灭。 */
  show(nodeId: string): void {
    this.nodeId = nodeId;
    this.clearTimer();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.nodeId = undefined;
      this.onExpire();
    }, HIGHLIGHT_MS);
    this.onExpire();
  }

  /** 卸载或换文档时立刻熄灭，不留下悬着的定时器。 */
  clear(): void {
    this.clearTimer();
    this.nodeId = undefined;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
