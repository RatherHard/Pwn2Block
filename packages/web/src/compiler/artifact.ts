import type { PublicChallenge } from '@pwn2block/shared';
import { compileProgram } from './compile';
import { ACTION_ORIGIN_VERSION } from './types';
import type {
  ActionOrigin,
  CompiledAction,
  CompileError,
  CompilerLimits,
  NormalizedWorkspace,
} from './types';

/**
 * 编译产物与「编辑后过期」状态（05 §3、09 §3.2）。控制器、工具栏门禁与输出区都直接消费它。
 *
 * 为什么单独一个模块：三条规则——「记住编译产物」「改了积木就标已过期」
 * 「过期产物不许运行或提交」——是同一个状态机的三面。放在这里，界面只读 `state`，
 * 不必自己维护 revision / stale / errors 的耦合关系，也不会出现「清了错误但忘了标过期」。
 *
 * 纯逻辑：不碰 DOM、不看时间，可以脱离 Blockly 在 node 里直接单测。
 */

/** 一次成功编译的产物：动作 + 动作到积木的来源表（09 §3.4）。 */
export interface PayloadArtifact {
  readonly actions: readonly CompiledAction[];
  /** 与 `actions` 等长同序；`origins[i].index === i`。**不进网络 payload**。 */
  readonly origins: readonly ActionOrigin[];
  readonly originsVersion: number;
  /** 产出它时的追踪器 `revision`，用于识别「这是哪一次编译的产物」。 */
  readonly revision: number;
}

export interface PayloadCompileState {
  /** 最近一次**成功**编译的产物；编译失败或从未编译时为 `undefined`。 */
  readonly artifact: PayloadArtifact | undefined;
  /** 最近一次编译的错误；编译成功时清空。 */
  readonly errors: readonly CompileError[];
  /** 画布在编译之后又被编辑过：产物仍在，但已过期，需重新编译。 */
  readonly stale: boolean;
  /** 每次成功编译 +1；单调递增，`clear()` 也不回退（避免新旧产物撞号）。 */
  readonly revision: number;
}

export interface ArtifactTracker {
  readonly state: PayloadCompileState;
  /**
   * 编译并记录结果。成功时替换产物、`revision + 1`、`stale = false`；
   * 失败时**清空产物**、保留错误列表、`stale = false`（错误本身就是最新结果）。
   */
  compile(program: NormalizedWorkspace, challenge: PublicChallenge): PayloadArtifact | undefined;
  /**
   * 采用别处编译好的产物（画布路径）。动作与来源必须已对齐；成功时与 `compile` 一样
   * 替换产物、`revision + 1`、`stale = false`。来源的 `blockId` 在画布路径里是节点 id。
   */
  adopt(actions: readonly CompiledAction[], origins: readonly ActionOrigin[]): PayloadArtifact;
  /** 记录一次失败的编译：清空产物、保留错误，运行/提交门禁据此拦住。 */
  fail(errors: readonly CompileError[]): void;
  /**
   * 标记产物已过期（编辑事件、程序化装载之后由调用方主动调用）。
   * 没有产物时是空操作：没有东西可供过期。
   */
  noteEdit(): void;
  /** 全清：产物、错误、过期标记；`revision` 保留。切题或重新开始会话时用。 */
  clear(): void;
}

/** 检查「来源表与动作对齐」这条不变式：错位说明编译器有 bug，宁可显式报错也不静默定位错积木。 */
function assertOriginsAligned(
  actions: readonly CompiledAction[],
  origins: readonly ActionOrigin[],
): void {
  if (origins.length !== actions.length) {
    throw new Error(`来源表与动作不等长：actions=${actions.length} origins=${origins.length}`);
  }
  for (const [index, origin] of origins.entries()) {
    if (origin.index !== index) {
      throw new Error(`来源表下标错位：origins[${index}].index=${origin.index}`);
    }
  }
}

export function createArtifactTracker(limits?: Partial<CompilerLimits>): ArtifactTracker {
  let state: PayloadCompileState = { artifact: undefined, errors: [], stale: false, revision: 0 };

  return {
    get state(): PayloadCompileState {
      return state;
    },

    compile(program: NormalizedWorkspace, challenge: PublicChallenge): PayloadArtifact | undefined {
      const result = compileProgram(
        { program, challenge },
        limits === undefined ? undefined : { limits },
      );
      if (!result.ok) {
        state = { artifact: undefined, errors: result.errors, stale: false, revision: state.revision };
        return undefined;
      }

      assertOriginsAligned(result.actions, result.origins);
      const revision = state.revision + 1;
      const artifact: PayloadArtifact = {
        actions: result.actions,
        origins: result.origins,
        originsVersion: result.originsVersion,
        revision,
      };
      state = { artifact, errors: [], stale: false, revision };
      return artifact;
    },

    fail(errors: readonly CompileError[]): void {
      state = { artifact: undefined, errors, stale: false, revision: state.revision };
    },

    adopt(actions: readonly CompiledAction[], origins: readonly ActionOrigin[]): PayloadArtifact {
      assertOriginsAligned(actions, origins);
      const revision = state.revision + 1;
      // `originsVersion` 是来源表**格式**版本，不是产物修订号；两者混用会让第二次编译后的定位失效。
      const artifact: PayloadArtifact = { actions, origins, originsVersion: ACTION_ORIGIN_VERSION, revision };
      state = { artifact, errors: [], stale: false, revision };
      return artifact;
    },

    noteEdit(): void {
      if (state.artifact === undefined || state.stale) return;
      state = { ...state, stale: true };
    },

    clear(): void {
      state = { artifact: undefined, errors: [], stale: false, revision: state.revision };
    },
  };
}
