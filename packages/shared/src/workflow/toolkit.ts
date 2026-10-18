/**
 * 定位序列工具的语义（与 pwntools 的 `cyclic` / `cyclic_find` 对齐，06 §6、07 §P7）。
 *
 * 放在 shared 的原因：内置的「生成定位序列」「查找序列偏移」节点和 Python 节点提供的
 * 同名工具必须是**同一套**字母表、匹配宽度和编码规则（07 §P7 最后一条）。两处各写一份
 * 就会出现「节点找到偏移 40、Python 找到 44」这种最难查的差异。
 *
 * 序列是 de Bruijn 序列（字母表长度 k、子串宽度 n=4）：任意 4 字节子串在整条序列里恰好
 * 出现一次，所以「4 字节的覆盖值 → 偏移」是唯一的。pwntools 用的也是这套：
 * `cyclic(16) === 'aaaabaaacaaadaaa'`、`cyclic_find('baaa') === 4`。
 */

/** 可选字母表。顺序即 de Bruijn 的顺序，决定生成的具体字节，不能随便改。 */
export const ALPHABETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
} as const;

export type AlphabetName = keyof typeof ALPHABETS;

/** 子串宽度：与 pwntools 默认值一致，改它会让偏移值与教程对不上。 */
export const CYCLIC_SUBSEQUENCE_WIDTH = 4;

/** 字母表名 → 字符表；未知名字退回小写字母（校验器会先拦非法值）。 */
export function alphabetOf(name: string): string {
  return name in ALPHABETS ? ALPHABETS[name as AlphabetName] : ALPHABETS.lower;
}

const cache = new Map<string, string>();

/**
 * 生成完整 de Bruijn 序列（长度 `k^n`）。FKM 算法，字典序最小——
 * 这正是 pwntools 的结果，所以 `cyclic(k)` 的开头能逐字节对上。
 */
export function deBruijnSequence(alphabet: string, n: number = CYCLIC_SUBSEQUENCE_WIDTH): string {
  const key = `${alphabet}\u0000${n}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  if (alphabet.length === 0 || n < 1) return '';

  const k = alphabet.length;
  const a = new Array<number>(k * n).fill(0);
  const out: string[] = [];
  const db = (t: number, p: number): void => {
    if (t > n) {
      if (n % p === 0) {
        for (let j = 1; j <= p; j += 1) out.push(alphabet[a[j] ?? 0] as string);
      }
      return;
    }
    a[t] = a[t - p] as number;
    db(t + 1, p);
    for (let j = (a[t - p] as number) + 1; j < k; j += 1) {
      a[t] = j;
      db(t + 1, t);
    }
  };
  db(1, 1);

  const sequence = out.join('');
  cache.set(key, sequence);
  return sequence;
}

/**
 * 取长度为 `length` 的定位序列：超过一条 de Bruijn 的长度就**循环重复**（这就是 cyclic 的名字）。
 */
export function cyclicSequence(alphabet: string, length: number): string {
  if (length <= 0) return '';
  const pattern = deBruijnSequence(alphabet);
  if (pattern.length === 0) return '';
  if (length <= pattern.length) return pattern.slice(0, length);
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}

/**
 * 在定位序列里找 `needle` 第一次出现的偏移。
 *
 * 找不到返回 `undefined`（调用方负责给「没找到」的明确提示，而不是 -1 混进整数运算）。
 * 序列是循环的，所以 `needle` 可以**跨接缝**：末尾接回开头继续找。
 * 含字母表外字节的 needle 永远找不到：序列只由字母表字符组成。
 */
export function cyclicFind(
  needle: Uint8Array,
  alphabet: string,
  width: number = CYCLIC_SUBSEQUENCE_WIDTH,
): number | undefined {
  if (needle.length === 0) return undefined;
  const sequence = deBruijnSequence(alphabet, width);
  if (sequence.length === 0) return undefined;
  // 不用 `String.fromCharCode(...needle)`：needle 可能有几十万字节，展开参数会爆栈。
  let text = '';
  for (const byte of needle) text += String.fromCharCode(byte);
  const wrapped = sequence + sequence.slice(0, Math.min(needle.length - 1, sequence.length));
  const offset = wrapped.indexOf(text);
  return offset < 0 ? undefined : offset;
}
