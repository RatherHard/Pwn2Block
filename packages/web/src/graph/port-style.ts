import type { PortType } from '@pwn2block/shared';

/**
 * 端口配色与中文名（06 §3）。
 *
 * 从这里拆出去是因为画布文件接近行数上限，而端口样式在画布、图例与提示文案里共用；
 * 颜色只引用主题变量，不写死色值。
 */

export const PORT_COLORS: Readonly<Record<PortType, string>> = {
  int: 'var(--p2b-code)',
  bool: 'var(--p2b-hidden)',
  bytes: 'var(--p2b-data)',
  text: 'var(--p2b-ip)',
};

export const PORT_LABELS: Readonly<Record<PortType, string>> = {
  int: '整数',
  bool: '布尔',
  bytes: '字节',
  text: '文本',
};
