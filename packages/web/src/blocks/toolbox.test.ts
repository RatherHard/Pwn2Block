import { describe, expect, it } from 'vitest';
import type { AuthorBlock } from '@pwn2block/shared';
import { ret2winPublic } from '@pwn2block/shared';
import { BLOCK_TYPES } from '../compiler/types';
import {
  BLOCK_SPECS,
  FEED_ORDER_TIP,
  authorBlockSpec,
  blocksForChallenge,
  disabledActionTypes,
} from './catalog';
import { buildToolbox, toolboxBlockTypes } from './toolbox';

/**
 * 工具箱与目录测试（05 §3.1）。
 *
 * 重点两条：动作积木按 `allowedActions` 过滤，出题人积木按 `authorBlocks` 动态生成。
 * 全部是纯数据断言，不依赖 Blockly 渲染。
 */

/** 允许全部动作的题目，用来验证目录本身完整。 */
const openChallenge = {
  allowedActions: ['write_bytes', 'push', 'pop', 'call', 'ret', 'feed', 'step', 'run'],
};

const ALL_ACTION_BLOCKS = [
  BLOCK_TYPES.actionWriteBytes,
  BLOCK_TYPES.actionPush,
  BLOCK_TYPES.actionPop,
  BLOCK_TYPES.actionCall,
  BLOCK_TYPES.actionRet,
  BLOCK_TYPES.actionFeed,
  BLOCK_TYPES.actionStep,
  BLOCK_TYPES.actionRun,
];

describe('积木目录', () => {
  it('开始积木存在且唯一，属于「开始」分类', () => {
    const starts = BLOCK_SPECS.filter((spec) => spec.category === 'start');
    expect(starts.map((spec) => spec.type)).toEqual([BLOCK_TYPES.start]);
  });

  it('目录里没有任何读取当前状态的积木（05 §4）', () => {
    for (const spec of BLOCK_SPECS) {
      expect(spec.type.startsWith('state_')).toBe(false);
    }
  });

  it('每个动作积木都登记了对应的动作名', () => {
    const actionBlocks = BLOCK_SPECS.filter((spec) => spec.action !== undefined).map(
      (spec) => spec.type,
    );
    expect(actionBlocks).toEqual(ALL_ACTION_BLOCKS);
  });

  it('每个积木都有中文文案与 tooltip', () => {
    for (const spec of BLOCK_SPECS) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.tooltip.length).toBeGreaterThan(0);
    }
  });

  it('feed 的 tooltip 写明要排在触发 read 的 step / run 之前', () => {
    const feed = BLOCK_SPECS.find((spec) => spec.type === BLOCK_TYPES.actionFeed);
    expect(feed?.tooltip).toBe(FEED_ORDER_TIP);
    expect(FEED_ORDER_TIP).toContain('feed');
    expect(FEED_ORDER_TIP).toContain('step / run');
    expect(FEED_ORDER_TIP).toContain('EOF');
  });

  it('int 的宽度默认是 W，端序默认小端', () => {
    const intSpec = BLOCK_SPECS.find((spec) => spec.type === BLOCK_TYPES.bytesInt);
    const width = intSpec?.fields?.find((field) => field.name === 'WIDTH');
    const endian = intSpec?.fields?.find((field) => field.name === 'ENDIAN');
    expect(width?.defaultValue).toBe(8);
    expect(endian?.defaultValue).toBe('LITTLE');
  });
});

describe('按题目过滤动作积木', () => {
  it('ret2win 只允许 step / run，其余动作积木不出现', () => {
    const types = blocksForChallenge(ret2winPublic).map((spec) => spec.type);
    expect(types).toContain(BLOCK_TYPES.actionStep);
    expect(types).toContain(BLOCK_TYPES.actionRun);
    expect(types).not.toContain(BLOCK_TYPES.actionWriteBytes);
    expect(types).not.toContain(BLOCK_TYPES.actionPush);
    expect(types).not.toContain(BLOCK_TYPES.actionPop);
    expect(types).not.toContain(BLOCK_TYPES.actionCall);
    expect(types).not.toContain(BLOCK_TYPES.actionRet);
    expect(types).not.toContain(BLOCK_TYPES.actionFeed);
  });

  it('字节与通用积木不受 allowedActions 影响', () => {
    const types = toolboxBlockTypes(ret2winPublic);
    expect(types).toContain(BLOCK_TYPES.bytesAddr);
    expect(types).toContain(BLOCK_TYPES.bytesConcat);
    expect(types).toContain(BLOCK_TYPES.controlsRepeat);
  });

  it('disabledActionTypes 列出被本题禁用的动作', () => {
    expect([...disabledActionTypes(ret2winPublic)].sort()).toEqual(
      ['call', 'feed', 'pop', 'push', 'ret', 'write_bytes'],
    );
    expect(disabledActionTypes(openChallenge)).toEqual([]);
  });
});

describe('出题人积木', () => {
  it('ret2win 的 gets 出现在「出题人积木」分类里，带上 tooltip', () => {
    const toolbox = buildToolbox(ret2winPublic);
    const authorCategory = toolbox.contents.find((category) => category.name === '出题人积木');
    expect(authorCategory?.contents).toEqual([{ kind: 'block', type: 'author_gets' }]);

    const spec = blocksForChallenge(ret2winPublic).find((item) => item.type === 'author_gets');
    expect(spec?.label).toBe('gets(buf)');
    expect(spec?.tooltip).toBe('从 buf 起写入字节，不检查长度');
  });

  it('没有 authorBlocks 时不生成该分类', () => {
    const toolbox = buildToolbox({ allowedActions: ['step'] });
    expect(toolbox.contents.map((category) => category.name)).toEqual([
      '开始',
      '通用',
      '字节',
      '动作',
    ]);
  });

  it('参数按类型生成输入槽，名字就是参数名（与编译器一致）', () => {
    const block: AuthorBlock = {
      id: 'readfile',
      label: 'readfile(fd, buf, data)',
      params: [
        { name: 'fd', type: 'int' },
        { name: 'buf', type: 'addr' },
        { name: 'data', type: 'bytes' },
      ],
      expand: [{ type: 'write_bytes', addr: '$buf', hex: '$data' }],
    };
    expect(authorBlockSpec(block)).toEqual({
      type: 'author_readfile',
      label: 'readfile(fd, buf, data)',
      category: 'author',
      tooltip: 'readfile(fd, buf, data)（出题人积木，动作由服务端展开，03 §3）',
      inputs: [
        { name: 'fd', kind: 'value', label: 'fd（int）' },
        { name: 'buf', kind: 'value', label: 'buf（addr）' },
        { name: 'data', kind: 'value', label: 'data（bytes）' },
      ],
    });
  });

  it('没有 tooltip 的出题人积木给出默认说明', () => {
    const block: AuthorBlock = {
      id: 'noop',
      label: 'noop()',
      params: [],
      expand: [{ type: 'step', count: 1 }],
    };
    expect(authorBlockSpec(block).tooltip).toContain('服务端展开');
  });
});

describe('工具箱数据', () => {
  it('分类顺序固定，且是 Blockly 的 categoryToolbox 形状', () => {
    const toolbox = buildToolbox(ret2winPublic);
    expect(toolbox.kind).toBe('categoryToolbox');
    expect(toolbox.contents.map((category) => category.name)).toEqual([
      '开始',
      '通用',
      '字节',
      '动作',
      '出题人积木',
    ]);
    for (const category of toolbox.contents) {
      expect(category.kind).toBe('category');
      expect(category.colour).toMatch(/^#[0-9a-f]{6}$/);
      for (const entry of category.contents) expect(entry.kind).toBe('block');
    }
  });

  it('工具箱里的每个类型都有自己的积木描述', () => {
    const described = new Set(BLOCK_SPECS.map((spec) => spec.type));
    for (const type of toolboxBlockTypes(ret2winPublic)) {
      expect(described.has(type) || type.startsWith('author_')).toBe(true);
    }
  });
});
