/** 只在当前投影可见 VMA 内搜索完整字节，不读取隐藏内容或请求额外内存。 */
import type { Projection } from '@pwn2block/shared';

export type ByteSearchMode = 'hex' | 'ascii';
export type ByteSearchResult =
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'missing' }
  | { readonly kind: 'found'; readonly addr: bigint };

/** 返回地址最小的匹配；不跨越 VMA 边界。ASCII 输入中的空格也是搜索内容。 */
export function searchVisibleBytes(
  projection: Projection, text: string, mode: ByteSearchMode,
): ByteSearchResult {
  let needle: string;
  if (mode === 'hex') {
    needle = text.replace(/\s/g, '').toLowerCase();
    if (!/^(?:[0-9a-f]{2})+$/.test(needle)) {
      return { kind: 'invalid', message: 'hex 搜索请填写完整字节，例如 41 42；可用空白分隔。' };
    }
  } else {
    if (text.length === 0 || Array.from(text).some((char) => char.charCodeAt(0) > 0x7f)) {
      return { kind: 'invalid', message: 'ASCII 搜索请填写非空的 ASCII 字符串。' };
    }
    needle = Array.from(text, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  }
  let first: bigint | undefined;
  for (const vma of projection.vmas) {
    if (vma.hidden || vma.hex === undefined) continue;
    const hex = vma.hex.toLowerCase();
    let index = hex.indexOf(needle);
    // 十六进制字符串的奇数下标落在半个字节内，不能算作匹配。
    while (index >= 0 && index % 2 !== 0) index = hex.indexOf(needle, index + 1);
    if (index < 0) continue;
    const addr = BigInt(vma.start) + BigInt(index / 2);
    if (first === undefined || addr < first) first = addr;
  }
  return first === undefined ? { kind: 'missing' } : { kind: 'found', addr: first };
}
