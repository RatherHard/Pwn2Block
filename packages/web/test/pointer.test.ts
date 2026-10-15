import { describe, expect, it } from 'vitest';
import {
  MAX_POINTER_HOPS,
  describePointerChain,
  resolvePointerChain,
} from '../src/viewmodel/pointer';
import { hexOf, makeReader, makeProjection, makeVma, memoryProjection, p64 } from './helpers';

/** 一条可控的指针链：0x100000 → 0x200000 → 0x100008 → 0x300000，全部已映射。 */
function chainProjection() {
  return memoryProjection(
    hexOf(0x1000, {
      0x00: p64(0x200000n),
      0x08: p64(0x300000n),
    }),
    {
      extraVmas: [
        makeVma({ id: 'mid', start: '0x200000', hex: hexOf(0x1000, { 0x00: p64(0x100008n) }) }),
        makeVma({ id: 'tail', kind: 'code', start: '0x300000', perm: 'rx', hex: hexOf(0x1000, { 0x00: p64(0x200000n) }) }),
      ],
    },
  );
}

describe('跳转链解析（05 §2.2）', () => {
  it('跟随映射内的指针，最多 3 跳（4 个地址）', () => {
    const reader = makeReader(chainProjection());
    const chain = resolvePointerChain(reader, 0x100000n);
    expect(chain.hops.map((hop) => hop.addr)).toEqual([0x100000n, 0x200000n, 0x100008n, 0x300000n]);
    expect(chain.stop).toBe('limit');
    expect(chain.hops.length).toBe(MAX_POINTER_HOPS + 1);
  });

  it('下一步落在未映射地址就停下，并保留已到达的地址', () => {
    const projection = memoryProjection(hexOf(0x10, { 0x00: p64(0xdeadbeefn) }));
    const chain = resolvePointerChain(makeReader(projection), 0x100000n);
    expect(chain.hops.map((hop) => hop.addr)).toEqual([0x100000n]);
    expect(chain.stop).toBe('not-address');
  });

  it('值本身不在任何 VMA 时视为数据，不生成链', () => {
    const projection = memoryProjection(hexOf(0x10));
    const chain = resolvePointerChain(makeReader(projection), 0xdeadbeefn);
    expect(chain.hops[0]?.state).toBe('unmapped');
    expect(describePointerChain(chain)).toBeUndefined();
  });

  it('小整数不当地址跟随（0 是最常见的数据）', () => {
    const projection = memoryProjection(hexOf(0x10, { 0x00: p64(0n) }));
    const chain = resolvePointerChain(makeReader(projection), 0x100000n);
    expect(chain.stop).toBe('not-address');
    expect(chain.hops.length).toBe(1);
  });

  it('隐藏 VMA：只标出隐藏与所属 VMA，绝不读内容', () => {
    const projection = memoryProjection(hexOf(0x10, { 0x00: p64(0x600000n) }), {
      extraVmas: [makeVma({ id: 'secret', kind: 'key', start: '0x600000', hidden: true })],
    });
    const chain = resolvePointerChain(makeReader(projection), 0x100000n);
    expect(chain.stop).toBe('hidden');
    expect(chain.hops.map((hop) => hop.state)).toEqual(['visible', 'hidden']);
    expect(chain.hops[1]?.vmaId).toBe('secret');
    expect(chain.hops[1]?.word).toBeUndefined();
    expect(chain.ascii).toBeUndefined();
    const described = describePointerChain(chain);
    expect(described?.arrows).toBe('→ 0x100000 → 0x600000');
    expect(described?.annotation).toBe('隐藏 VMA「secret」');
    expect(described?.hidden).toBe(true);
  });

  it('内容长度不足 8 字节时停在该跳（不猜半个字）', () => {
    const projection = makeProjection({
      vmas: [makeVma({ id: 'tiny', start: '0x500000', size: '0x1000', hex: '41424344' })],
    });
    const chain = resolvePointerChain(makeReader(projection), 0x500000n);
    expect(chain.stop).toBe('boundary');
    expect(chain.hops[0]?.word).toBeUndefined();
  });

  it('终点落在可执行区域时带上服务端伪汇编，并带公开标注名', () => {
    const projection = makeProjection({
      vmas: [
        makeVma({ id: 'code', kind: 'code', start: '0x300000', perm: 'rx', hex: hexOf(0x1000, { 0: 'c3' }) }),
        makeVma({ id: 'src', start: '0x100000', hex: hexOf(0x10, { 0: p64(0x300000n) }) }),
      ],
      disasm: [{ addr: '0x300000', bytes: 'c3', text: 'ret' }],
    });
    const chain = resolvePointerChain(makeReader(projection), 0x100000n, {
      labels: [{ name: 'win', addr: '0x300000', size: 1, kind: 'func' }],
    });
    const described = describePointerChain(chain);
    expect(described?.arrows).toBe('→ 0x100000 → 0x300000');
    expect(described?.annotation).toBe('ret · win');
  });

  it('终点是普通数据时没有 ASCII、没有伪汇编、也没有附注', () => {
    const projection = makeProjection({
      vmas: [
        makeVma({ id: 'src', start: '0x100000', size: '0x10', hex: hexOf(0x10, { 0: p64(0x200000n) }) }),
        makeVma({ id: 'data', start: '0x200000', size: '0x10', hex: hexOf(0x10, { 0: '0102030405060708' }) }),
      ],
    });
    const chain = resolvePointerChain(makeReader(projection), 0x100000n, { maxHops: 1 });
    expect(chain.hops.map((hop) => hop.addr)).toEqual([0x100000n, 0x200000n]);
    expect(chain.ascii).toBeUndefined();
    expect(chain.text).toBeUndefined();
    expect(describePointerChain(chain)?.annotation).toBeUndefined();
  });

  it('ASCII 从终点处读，指向字符串缓冲区时能显示出来', () => {
    const projection = makeProjection({
      vmas: [
        makeVma({ id: 'src', start: '0x100000', size: '0x10', hex: hexOf(0x10, { 0: p64(0x200000n) }) }),
        makeVma({ id: 'str', start: '0x200000', size: '0x10', hex: '68656c6c6f00000000' }),
      ],
    });
    const chain = resolvePointerChain(makeReader(projection), 0x100000n, { maxHops: 1 });
    expect(chain.hops.map((hop) => hop.addr)).toEqual([0x100000n, 0x200000n]);
    expect(chain.ascii).toBe('hello');
    expect(describePointerChain(chain)?.annotation).toBe('"hello"');
  });
});
