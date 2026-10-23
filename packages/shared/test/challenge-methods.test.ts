import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ActionSchema, BlockActionSchema, expandBlock, isBlockAction, type BlockAction } from '../src/actions';
import { SubmitRequestSchema } from '../src/api';
import { AuthorBlockSchema, PublicChallengeSchema, type AuthorBlock, type PublicChallenge } from '../src/challenge';
import { generateCanvasActions } from '../src/canvas/actions';
import { CANVAS_FORMAT, CANVAS_VERSION, type CanvasDocument, type CanvasNode } from '../src/canvas/document';

/**
 * 题目公开方法与权限面的验收（《节点画布大型修改》AT-19）。
 *
 * 新画布不给通用 `feed/write/push/pop/call/ret/step/run` 节点入口（需求 §5.4），
 * 「参考解法仍能完成」因此完全取决于题目包自己声明的 `authorBlocks`：
 * 每一道题都必须有方法入口，每个方法都能被画布配上最小合法参数生成 `{type:'block', id, args}`，
 * 而且**权限面不能比旧画布更大**——展开出的动作要么落在该题 `allowedActions` 内，
 * 要么只能是不带地址参数、落点写死在题目包里的窄接口（`docs/02-已实现需求.md`「逐题公开方法」）。
 *
 * 这里读的是**磁盘上的真实题目包**，不是测试里手搓的假包：题目包改坏了、方法没补、权限放大了，
 * 这条验收才会红。
 */

const CHALLENGE_ROOT = fileURLToPath(new URL('../../../challenges', import.meta.url));

/** `docs/02-已实现需求.md`「逐题公开方法」一节的 7 道题与各自的方法 id（顺序不可交换，比对用）。 */
const DOCUMENTED_METHODS: Readonly<Record<string, readonly string[]>> = {
  callret: ['push_value'],
  endian: ['write_bytes'],
  localvar: ['gets'],
  pushpop: ['push_value', 'pop_value'],
  ret2rop: ['name', 'introduce'],
  ret2win: ['gets'],
  stackframe: ['capture'],
};

/**
 * 固定落点窄接口：方法参数只有 `data`（字节串内容），落点写死在题目包模板里。
 *
 * 判定见 `权限面` 一节：展开动作里出现 `allowedActions` 之外的种类时，**必须**落在这张清单上；
 * 清单与 `docs/02-已实现需求.md` 的说明一一对应（`gets` / `capture` / `name` / `introduce`
 * 是不带地址参数的固定落点窄接口）。
 */
const NARROW_INTERFACES: readonly string[] = [
  'localvar/gets',
  'ret2rop/name',
  'ret2rop/introduce',
  'ret2win/gets',
  'stackframe/capture',
];

/** 展开动作全部落在 `allowedActions` 内的方法：权限与旧画布完全同一套动作。 */
const COVERED_METHODS: readonly string[] = [
  'callret/push_value',
  'endian/write_bytes',
  'pushpop/push_value',
  'pushpop/pop_value',
];

interface ChallengePack {
  readonly id: string;
  readonly challenge: PublicChallenge;
  readonly blocks: readonly AuthorBlock[];
}

function challengeIds(): readonly string[] {
  return readdirSync(CHALLENGE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 读一个题目包并过 `PublicChallengeSchema`：坏包显式抛错，不靠后面的断言间接报。 */
function loadPack(id: string): ChallengePack {
  const text = readFileSync(join(CHALLENGE_ROOT, id, 'public.json'), 'utf8');
  const parsed: unknown = JSON.parse(text);
  const result = PublicChallengeSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues[0]?.message ?? '未知原因';
    throw new Error(`${id}/public.json 不是合法的公开题目包：${detail}`);
  }
  return { id, challenge: result.data, blocks: result.data.authorBlocks ?? [] };
}

const PACKS: readonly ChallengePack[] = challengeIds().map(loadPack);

/** 最小合法参数：字节串给一个字节，整数与地址给 0（与画布 `encodeArgument` 的口径一致）。 */
function minimalArgsOf(block: AuthorBlock): Record<string, string> {
  const args: Record<string, string> = {};
  for (const param of block.params) args[param.name] = param.type === 'bytes' ? '00' : '0x0';
  return args;
}

function blockActionOf(block: AuthorBlock): BlockAction {
  return { type: 'block', id: block.id, args: minimalArgsOf(block) };
}

/** 展开一条方法声明；模板坏掉时直接抛出，让调用方那条用例失败而不是被吞掉。 */
function expandedActionsOf(pack: ChallengePack, block: AuthorBlock): ReturnType<typeof expandBlock> {
  return expandBlock({ authorBlocks: pack.challenge.authorBlocks }, blockActionOf(block));
}

/** 「最小画布」：开始节点 + 每个参数一个零值字面值 + 该方法节点本身。 */
function minimalDocumentOf(block: AuthorBlock): CanvasDocument {
  const nodes: CanvasNode[] = [{ kind: 'start', id: 'start' }];
  const args: Record<string, string> = {};
  for (const param of block.params) {
    const id = `arg-${param.name}`;
    nodes.push({
      kind: 'value',
      id,
      value: param.type === 'bytes' ? { kind: 'byte', hex: '00' } : { kind: 'int', value: '0' },
    });
    args[param.name] = id;
  }
  nodes.push({ kind: 'method', id: 'call', block: block.id, args });
  return { format: CANVAS_FORMAT, version: CANVAS_VERSION, nodes, layout: {}, main: ['start', 'call'] };
}

describe('题目包的方法声明（阶段三交付）', () => {
  it('7 道题都有公开包，且每题都声明了非空的 authorBlocks', () => {
    expect(PACKS.map((pack) => pack.id)).toEqual(Object.keys(DOCUMENTED_METHODS));
    const missing = PACKS.filter((pack) => pack.blocks.length === 0).map((pack) => pack.id);
    expect(missing).toEqual([]);
  });

  it('每题的方法 id 清单与 docs/02-已实现需求.md「逐题公开方法」一致', () => {
    const actual: Record<string, readonly string[]> = {};
    for (const pack of PACKS) actual[pack.id] = pack.blocks.map((block) => block.id);

    expect(actual).toEqual(DOCUMENTED_METHODS);
  });

  it('每个 authorBlock 都过 AuthorBlockSchema，id 与参数名在同一题内唯一', () => {
    const problems: string[] = [];
    for (const pack of PACKS) {
      for (const block of pack.blocks) {
        const parsed = AuthorBlockSchema.safeParse(block);
        if (!parsed.success) {
          const detail = parsed.error.issues[0]?.message ?? '未知原因';
          problems.push(`${pack.id}/${block.id}: ${detail}`);
        }
      }
      const ids = pack.blocks.map((block) => block.id);
      if (new Set(ids).size !== ids.length) problems.push(`${pack.id}: 方法 id 重复（${ids.join('、')}）`);
    }

    expect(problems).toEqual([]);
  });

  it('每个方法的展开模板都能展开成合法原子动作，并被提交请求接受', () => {
    const problems: string[] = [];
    for (const pack of PACKS) {
      for (const block of pack.blocks) {
        const name = `${pack.id}/${block.id}`;
        const expansion = expandedActionsOf(pack, block);
        if (!expansion.ok) {
          problems.push(`${name}: ${expansion.detail}`);
          continue;
        }
        if (expansion.actions.length !== block.expand.length) {
          problems.push(`${name}: 展开出 ${expansion.actions.length} 条动作，模板写了 ${block.expand.length} 条`);
        }
        for (const expanded of expansion.actions) {
          if (!ActionSchema.safeParse(expanded).success) problems.push(`${name}: 展开结果不是合法动作`);
        }
        const parsed = SubmitRequestSchema.safeParse({ actions: expansion.actions });
        if (!parsed.success) problems.push(`${name}: 提交请求不接受展开结果`);
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('画布入口：每题每个方法都能生成动作（AT-19）', () => {
  it('最小合法参数能生成 {type:"block", id, args}，id 等于声明 id', () => {
    const problems: string[] = [];
    for (const pack of PACKS) {
      for (const block of pack.blocks) {
        const name = `${pack.id}/${block.id}`;
        const result = generateCanvasActions(minimalDocumentOf(block), { challenge: pack.challenge });
        if (!result.ok) {
          problems.push(`${name}: ${result.issues.map((issue) => issue.message).join('；')}`);
          continue;
        }
        const [action] = result.sequence.actions;
        if (result.sequence.actions.length !== 1) {
          problems.push(`${name}: 期望 1 条动作，生成 ${result.sequence.actions.length} 条`);
          continue;
        }
        if (!isBlockAction(action)) {
          problems.push(`${name}: 生成的不是 block 动作`);
          continue;
        }
        if (action.id !== block.id) problems.push(`${name}: 动作 id 是 ${action.id}`);
        const expected = JSON.stringify(minimalArgsOf(block));
        if (JSON.stringify(action.args) !== expected) {
          problems.push(`${name}: 参数是 ${JSON.stringify(action.args)}，期望 ${expected}`);
        }
        // 生成的 block 动作交回服务端同一个展开器，必须能展开（提交前后的口径一致）。
        if (!expandBlock({ authorBlocks: pack.challenge.authorBlocks }, action).ok) {
          problems.push(`${name}: 生成的 block 动作无法被 expandBlock 展开`);
        }
        if (!BlockActionSchema.safeParse(action).success) problems.push(`${name}: block 动作形状不合法`);
        if (!SubmitRequestSchema.safeParse({ actions: [action] }).success) {
          problems.push(`${name}: 提交请求不接受这条 block 动作`);
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('权限面：方法入口没有扩大（AT-19）', () => {
  it('展开动作要么落在 allowedActions 内，要么是不带地址参数的固定落点窄接口', () => {
    const covered: string[] = [];
    const narrow: string[] = [];

    for (const pack of PACKS) {
      for (const block of pack.blocks) {
        const name = `${pack.id}/${block.id}`;
        const expansion = expandedActionsOf(pack, block);
        if (!expansion.ok) throw new Error(`${name}: ${expansion.detail}`);

        const outside = expansion.actions
          .map((action) => action.type)
          .filter((type) => !pack.challenge.allowedActions.includes(type));
        if (outside.length === 0) {
          covered.push(name);
          continue;
        }

        /*
         * 落到这里说明方法展开出了该题没放开的动作种类。唯一的合法理由是「固定落点窄接口」：
         * 1. 参数表只有一个 `data`（字节串）——用户能改的只有喂进去的内容，改不了数值与落点；
         * 2. 参数里没有 `addr` / `int`——用户无法自己指定写到哪个地址、写什么数值；
         * 3. 模板只有两种：`write_bytes` 把落点 `addr` 写成字面常量（不是 `$` 占位符），
         *    或者 `feed` 往 stdin 追加（**根本没有落点参数**，地址由程序自己 read 的目标决定）。
         * 任何一条不成立都说明权限真的变大了，不允许用兜底分支放过。
         */
        expect(block.params.map((param) => `${param.name}:${param.type}`)).toEqual(['data:bytes']);
        for (const template of block.expand) {
          expect(template.type === 'write_bytes' || template.type === 'feed').toBe(true);
          if (template.type !== 'write_bytes') continue;
          expect(template.addr.startsWith('$')).toBe(false);
        }
        narrow.push(name);
      }
    }

    expect(covered).toEqual(COVERED_METHODS);
    expect(narrow).toEqual(NARROW_INTERFACES);
  });

  it('窄接口只放行一个数据参数，展开不产生调用、跳转或寄存器写入', () => {
    const problems: string[] = [];
    for (const pack of PACKS) {
      for (const block of pack.blocks) {
        const name = `${pack.id}/${block.id}`;
        if (!NARROW_INTERFACES.includes(name)) continue;
        if (block.params.length !== 1) problems.push(`${name}: 窄接口只允许 1 个参数`);
        for (const param of block.params) {
          if (param.type === 'addr' || param.type === 'int') problems.push(`${name}: 窄接口不接受 ${param.type} 参数`);
        }
        const expansion = expandedActionsOf(pack, block);
        if (!expansion.ok) {
          problems.push(`${name}: ${expansion.detail}`);
          continue;
        }
        for (const action of expansion.actions) {
          if (action.type !== 'write_bytes' && action.type !== 'feed') {
            problems.push(`${name}: 窄接口展开出了 ${action.type}`);
          }
        }
      }
    }

    expect(problems).toEqual([]);
  });
});
