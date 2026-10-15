import { readFileSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { EncodingItemSchema, type EncodingItem } from '@pwn2block/shared';
import { presetsDir, repoRoot } from './paths';

/**
 * 默认编码表读取（06 §2.1）：`presets/<name>.json` 是一个 `EncodingItem[]`。
 *
 * 设计要点：
 * - **按仓库根解析**，不做 `require` / `import`，读进来后逐项过 shared 的 Schema；
 *   非法 JSON 或 Schema 不合法一律显式报错，绝不静默降级成空表——
 *   空表会让 `challenge:check` 通过、线上却发现所有字节都解码不了。
 * - **缓存**：同一份 preset 在一次进程里只读一次。
 * - preset 名限制为 `<小写字母开头 + 小写字母/数字/连字符>`，挡掉 `../` 之类的路径穿越。
 *
 * `presets/x86ish.json` 的取舍（02 §4.1 的内置作用全覆盖）：
 * - opcode 取值刻意贴真实 x86：`0x50` push、`0xc3` ret、`0xc9` leave、`0xe8` call、`0x90` nop…
 * - 本 ISA 把寄存器写进 opcode，而真实 x86 用 ModRM 编码操作数，所以
 *   `add/sub/mov` 的 R,R 与 R,M 形态、`shl`/`shr` 的两种移位量形态无法共用同一个 opcode：
 *   这里从真实 x86 的**未使用字节**（`0xc4`/`0xc5` VEX 前缀、`0xd6`/`0xd7` 废弃指令、`0x26` 段前缀）
 *   里取，避免撞上学习者以后会看到的真实助记符。
 * - `syscall`：`0x0e` = 调用号 60（exit）、`0x10` = 调用号 1（write）、`0x0f` = 无操作数形态
 *   （调用号运行时取 `nr` 寄存器）。**引用这张表的题目必须声明 syscallAbi 与 syscalls，
 *   且 60 / 1 都要在 syscalls 里**（`validate.ts` 的跨包校验会强制）。
 * - 表里出现的寄存器只有八个经典通用寄存器 + 无：引用本题的 `private.json`
 *   必须在 `registers` 里声明它们（编码表引用了未声明的寄存器会被拒绝加载）。
 * - 表里没有 `ret imm`、没有相对跳转、没有 R8–R15：P1 再说。
 */

export type PresetLoadResult =
  | { readonly ok: true; readonly name: string; readonly path: string; readonly items: readonly EncodingItem[] }
  | { readonly ok: false; readonly name: string; readonly path: string; readonly message: string };

const PRESET_NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

const EncodingItemsSchema = EncodingItemSchema.array().min(1);
const cache = new Map<string, PresetLoadResult>();

/** `presets/<name>.json` 的绝对路径。 */
export function presetPath(name: string, root: string = repoRoot()): string {
  return join(presetsDir(root), `${name}.json`);
}

/** 清空缓存：测试里换了仓库根或改写了 preset 文件后必须调用。 */
export function clearPresetCache(): void {
  cache.clear();
}

function fail(name: string, path: string, message: string): PresetLoadResult {
  return { ok: false, name, path, message };
}

/**
 * 读取并校验一份 preset。结果对象被缓存；同一路径返回同一个对象。
 */
export function loadPreset(name: string, root: string = repoRoot()): PresetLoadResult {
  if (!PRESET_NAME_RE.test(name)) {
    return fail(name, presetPath('invalid', root), `preset 名不合法：${name}（只允许小写字母、数字、连字符）`);
  }

  const path = normalize(presetPath(name, root));
  if (!isAbsolute(path)) {
    return fail(name, path, `preset 路径必须是绝对路径：${path}`);
  }

  const cached = cache.get(path);
  if (cached) return cached;

  const result = readPreset(name, path);
  cache.set(path, result);
  return result;
}

function readPreset(name: string, path: string): PresetLoadResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(name, path, `读取编码表失败：${detail}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(name, path, `编码表不是合法 JSON：${detail}`);
  }

  const parsed = EncodingItemsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const at = first?.path.join('.') ?? '<root>';
    return fail(name, path, `编码表不符合 EncodingItem[]（${at}）：${first?.message ?? ''}`);
  }

  const items = parsed.data;
  const seen = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const previous = seen.get(item.opcode);
    if (previous !== undefined) {
      return fail(name, path, `编码表里 opcode ${item.opcode} 重复声明（第 ${previous + 1} 项与第 ${index + 1} 项）`);
    }
    seen.set(item.opcode, index);
  }

  return { ok: true, name, path, items };
}
