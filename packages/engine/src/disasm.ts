import { bytesToHex, formatHex, hasPerm } from '@pwn2block/shared';
import type { DisasmEntry, VmState, VmaInit } from '@pwn2block/shared';
import { decodeAt } from './decode';
import type { EngineEnv } from './env';
import { isRegionVisible } from './layout';

/**
 * 反汇编（02 §4、04 §4）：服务端针对**可见的可执行区域**做线性扫描，随投影下发。
 * 前端不自己实现解码器。
 *
 * - 隐藏且未 `reveal` 的区域不出现（S01：隐藏区无 hex / disasm）。
 * - 未命中编码表的字节显示为 `db 0x??`（这里带真实字节值），每次前进 1 字节；
 *   与真实反汇编器一样，线性扫描不跟踪控制流，所以 `ret` 之后还会继续。
 * - 扫描范围只到“有效前缀”为止（init 补丁覆盖到的末尾，或最后一个非零字节）：
 *   一页干净内存全是零，不下发 4096 条 `db 0x00` 撑爆投影；同时这个边界
 *   也当作解码窗口，所以“最后一个有效字节是半个指令”会如实报成 `db`。
 */

export function disassembleState(env: EngineEnv, state: VmState): readonly DisasmEntry[] {
  const entries: DisasmEntry[] = [];
  const inits = new Map(env.vmas.map((vma) => [vma.id, vma]));

  for (const region of env.layoutIndex.regions) {
    if (!hasPerm(region.perm, 'x')) continue;
    if (!isRegionVisible(state, region)) continue;

    const bytes = env.memory.readVma(state.memory, region.id);
    if (bytes === undefined) continue;

    const end = usedPrefix(bytes, inits.get(region.id));
    let offset = 0;
    while (offset < end) {
      const addr = region.start + BigInt(offset);
      const result = decodeAt(bytes.subarray(offset, end), addr, env.lookup);
      if (!result.ok) {
        const byte = bytes[offset] ?? 0;
        entries.push({
          addr: formatHex(addr),
          bytes: bytesToHex(bytes.subarray(offset, offset + 1)),
          text: `db 0x${byte.toString(16).padStart(2, '0')}`,
        });
        offset += 1;
        continue;
      }

      const instruction = result.instruction;
      entries.push({
        addr: formatHex(addr),
        bytes: bytesToHex(instruction.bytes),
        text: instruction.text,
        ...(instruction.target === undefined ? {} : { target: formatHex(instruction.target) }),
      });
      offset += instruction.length;
    }
  }

  return entries;
}

/**
 * 有效前缀长度 = max（init 补丁覆盖到的末尾，最后一个非零字节 + 1）。
 *
 * 前者保证出题人写的指令一个字节不少（`mov eax, 1` 的尾巴全是 0）；
 * 后者覆盖“程序运行期往可写区写了一段代码再跳过去”的题目。
 */
function usedPrefix(bytes: Uint8Array, vma: VmaInit | undefined): number {
  let end = 0;
  if (vma !== undefined) {
    for (const patch of vma.init) {
      const stop = Number(patch.at - vma.start) + patch.bytes.length;
      if (stop > end) end = stop;
    }
  }
  for (let index = bytes.length - 1; index >= end; index -= 1) {
    if (bytes[index] !== 0) {
      end = index + 1;
      break;
    }
  }
  return Math.max(0, Math.min(end, bytes.length));
}
