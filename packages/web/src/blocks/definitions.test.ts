// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { MAX_STEPS_PER_RUN, ret2winPublic } from '@pwn2block/shared';
import { BLOCK_TYPES, FIELDS, FORBIDDEN_STATE_BLOCK_TYPES, INPUTS } from '../compiler/types';
import { BLOCK_SPECS, SHADOW_MATH_NUMBER } from './catalog';
import {
  BLOCK_MAX_INSTANCES,
  DEFAULT_VARIABLE_NAME,
  START_BLOCK_MAX_INSTANCES,
  blockDefinitionOf,
  defineAuthorBlockDefinitions,
  definePwn2BlockBlocks,
} from './definitions';

/**
 * 真实 Blockly 积木定义（H01，05 §3.1）。
 *
 * 这些用例全部用**真实 Blockly 对象**（`Blockly.inject` / `newBlock` / `getField`），
 * 不手写假对象：假对象只能证明"我的翻译函数被调用了"，证明不了"Blockly 认这套定义"。
 * 默认的 vitest 环境是 node，所以文件头指定 jsdom。
 */

/** 空工具箱即可：这些用例关心的是积木定义本身，工具箱另有专门用例。 */
const EMPTY_TOOLBOX = { kind: 'categoryToolbox' as const, contents: [] };

function makeHost(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

/** 注入一个真实工作区；调用方负责 `dispose()`。 */
function injectWorkspace(host: HTMLElement): Blockly.WorkspaceSvg {
  definePwn2BlockBlocks();
  return Blockly.inject(host, { toolbox: EMPTY_TOOLBOX, renderer: 'thrasos' });
}

function fieldValue(block: Blockly.Block, name: string): unknown {
  return block.getField(name)?.getValue();
}

function shadowTypeOf(block: Blockly.Block, inputName: string): string | undefined {
  const target = block.getInput(inputName)?.connection?.targetBlock();
  return target === null || target === undefined ? undefined : target.type;
}

describe('积木定义：注册与文案', () => {
  it('目录里的每个积木都能注册，并且中文文案与 tooltip 来自 catalog', () => {
    definePwn2BlockBlocks();
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      for (const spec of BLOCK_SPECS) {
        expect(Blockly.Blocks[spec.type], `未注册：${spec.type}`).toBeDefined();
      }
      const start = workspace.newBlock(BLOCK_TYPES.start);
      // tooltip 是 catalog 里的原话，不是这里另写一份。
      expect(start.tooltip).toBe(BLOCK_SPECS[0]?.tooltip);
      expect(BLOCK_SPECS[0]?.type).toBe(BLOCK_TYPES.start);
      expect(start.getColour()).toBeTruthy();
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('幂等：重复调用不会重复注册', () => {
    definePwn2BlockBlocks();
    expect(definePwn2BlockBlocks()).toBe(0);
  });

  it('登记了全部动作积木的容量约束：开始积木只允许一个', () => {
    expect(START_BLOCK_MAX_INSTANCES).toBe(1);
    expect(BLOCK_MAX_INSTANCES[BLOCK_TYPES.start]).toBe(1);
  });

  it('读状态类的保留类型名不会被注册成积木（05 §4：工具箱里根本没有）', () => {
    definePwn2BlockBlocks();
    // 用一个独立的出题人积木（不碰 ret2win 那份）验证：注册出题人积木也不会冒出保留名。
    defineAuthorBlockDefinitions({
      authorBlocks: [
        {
          id: 'selfcheck',
          label: '自证积木',
          params: [],
          expand: [{ type: 'step', count: 1 }],
        },
      ],
    });
    for (const type of FORBIDDEN_STATE_BLOCK_TYPES) {
      expect(Blockly.Blocks[type], `不该注册读状态积木：${type}`).toBeUndefined();
    }
    // 自证：Blockly 认得出注册过的类型，所以上面的 undefined 不是"什么都没注册"。
    expect(Blockly.Blocks[BLOCK_TYPES.actionRet]).toBeDefined();
    expect(Blockly.Blocks.author_selfcheck).toBeDefined();
  });
});

describe('积木定义：画布形态', () => {
  it('开始积木只有下一个连接，没有上一个连接', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const start = workspace.newBlock(BLOCK_TYPES.start);
      expect(start.previousConnection).toBeNull();
      expect(start.nextConnection).not.toBeNull();
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('值积木有输出连接；语句积木有前后连接', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const number = workspace.newBlock(BLOCK_TYPES.mathNumber);
      expect(number.outputConnection).not.toBeNull();
      expect(number.previousConnection).toBeNull();

      // pop() 没有输入槽，是典型语句积木。
      const pop = workspace.newBlock(BLOCK_TYPES.actionPop);
      expect(pop.previousConnection).not.toBeNull();
      expect(pop.nextConnection).not.toBeNull();
      expect(pop.outputConnection).toBeNull();
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('未登记画布形态的积木会显式抛错，而不是猜成值块', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      Blockly.common.defineBlocks({
        not_registered_shape: blockDefinitionOf({
          type: 'not_in_block_shapes',
          label: '未登记',
          category: 'generic',
          tooltip: '故意未登记画布形态',
        }),
      });
      expect(() => workspace.newBlock('not_registered_shape')).toThrow(/未登记画布形态/);
    } finally {
      workspace.dispose();
      host.remove();
    }
  });
});

describe('积木定义：字段与影子积木', () => {
  it('数字 / 下拉字段带上 catalog 的默认值', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const int = workspace.newBlock(BLOCK_TYPES.bytesInt);
      expect(fieldValue(int, FIELDS.width)).toBe(8);
      expect(fieldValue(int, FIELDS.endian)).toBe('LITTLE');
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('值输入槽挂上 math_number 影子积木（数字输入不用先拖积木）', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const padding = workspace.newBlock(BLOCK_TYPES.bytesPadding);
      padding.initSvg();
      expect(shadowTypeOf(padding, INPUTS.byte)).toBe(SHADOW_MATH_NUMBER);
      expect(shadowTypeOf(padding, INPUTS.count)).toBe(SHADOW_MATH_NUMBER);
      // 没有声明影子的输入保持空着，由编译器给出「缺少输入」的显式错误。
      const feed = workspace.newBlock(BLOCK_TYPES.actionFeed);
      feed.initSvg();
      expect(shadowTypeOf(feed, INPUTS.bytes)).toBeUndefined();
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('step / run 的影子值是文档里的默认值，而不是数字积木的 0', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const step = workspace.newBlock(BLOCK_TYPES.actionStep);
      step.initSvg();
      const stepShadow = step.getInput(INPUTS.count)?.connection?.targetBlock();
      expect(stepShadow?.type).toBe(SHADOW_MATH_NUMBER);
      expect(stepShadow?.getFieldValue(FIELDS.num)).toBe(1);

      const run = workspace.newBlock(BLOCK_TYPES.actionRun);
      run.initSvg();
      const runShadow = run.getInput(INPUTS.maxSteps)?.connection?.targetBlock();
      expect(runShadow?.type).toBe(SHADOW_MATH_NUMBER);
      expect(runShadow?.getFieldValue(FIELDS.num)).toBe(MAX_STEPS_PER_RUN);
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('变量字段默认用有名字的变量，而不是 Blockly 自动生成的 item', () => {
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      const get = workspace.newBlock(BLOCK_TYPES.varsGet);
      get.initSvg();
      const field = get.getField(FIELDS.variable) as Blockly.FieldVariable;
      expect(field.getText()).toBe(DEFAULT_VARIABLE_NAME);
      // v13 的变量表挂在 `getVariableMap()` 上（`Workspace.getAllVariables` 已不存在）。
      expect(
        workspace
          .getVariableMap()
          .getAllVariables()
          .map((variable) => variable.getName()),
      ).toEqual([DEFAULT_VARIABLE_NAME]);
    } finally {
      workspace.dispose();
      host.remove();
    }
  });
});

describe('积木定义：出题人积木', () => {
  it('按公开包注册 author_<id> 积木，输入槽名就是参数名', () => {
    definePwn2BlockBlocks();
    const host = makeHost();
    const workspace = injectWorkspace(host);
    try {
      expect(defineAuthorBlockDefinitions(ret2winPublic)).toBe(1);
      const gets = workspace.newBlock('author_gets');
      gets.initSvg();
      expect(gets.getInput('data')).toBeDefined();
      // 出题人积木是动作：接在语句链上。
      expect(gets.previousConnection).not.toBeNull();
      expect(gets.nextConnection).not.toBeNull();
      expect(gets.tooltip).toBe(ret2winPublic.authorBlocks?.[0]?.tooltip);
    } finally {
      workspace.dispose();
      host.remove();
    }
  });

  it('重复注册同一题的出题人积木不会重复定义', () => {
    definePwn2BlockBlocks();
    defineAuthorBlockDefinitions(ret2winPublic);
    expect(defineAuthorBlockDefinitions(ret2winPublic)).toBe(0);
  });
});
