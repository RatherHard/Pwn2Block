import type { AuthorBlock, AuthorParam } from '../challenge';
import { CANVAS_MAX_METHOD_ARGS } from '../limits';

/**
 * 题目公开方法（需求 §5.4）。
 *
 * 新画布不暴露通用的 `feed/write/push/pop/call/ret/step/run` 入口，只暴露**题目自己声明**的方法。
 * 声明来源是题目包的 `authorBlocks`：`id` 是方法标识、`label` 是显示名、`params` 是参数名与类型、
 * `expand` 是服务端展开的原子动作模板。画布只负责把参数值固定进 `{ type: 'block', id, args }`，
 * **展开仍然由服务端完成**，客户端提交的动作序列里不出现展开结果（01 §6 第 3 条、03 §3）。
 *
 * 这一层是 `AuthorBlock` 到画布语义的最小适配：画布不需要知道模板长什么样，
 * 只需要知道「有哪些方法、各要几个什么类型的参数」，以及按参数类型把值编码成动作参数。
 */

/** 参数类型沿用现有方法声明：字节串、整数、地址（需求 §5.4「首版沿用现有方法参数类型」）。 */
export type CanvasMethodParamType = AuthorParam['type'];

export interface CanvasMethodParam {
  readonly name: string;
  readonly type: CanvasMethodParamType;
}

export interface CanvasMethodDecl {
  /** 方法标识，等于 `authorBlocks[].id`。 */
  readonly id: string;
  /** 显示名，等于 `authorBlocks[].label`。 */
  readonly label: string;
  readonly params: readonly CanvasMethodParam[];
  /** 展开出的原子动作条数：用于容量预估与界面提示，不参与参数校验。 */
  readonly actionCount: number;
}

/** 只依赖 `authorBlocks` 这一处：校验器与生成器都不需要完整公开题目包。 */
export interface CanvasMethodSource {
  readonly authorBlocks?: readonly AuthorBlock[];
}

/** 把题目声明转成画布方法目录；参数超过上限的声明直接跳过（由题目包校验负责报错）。 */
export function canvasMethodsOf(source: CanvasMethodSource): readonly CanvasMethodDecl[] {
  const blocks = source.authorBlocks ?? [];
  const methods: CanvasMethodDecl[] = [];
  for (const block of blocks) {
    if (block.params.length > CANVAS_MAX_METHOD_ARGS) continue;
    methods.push({
      id: block.id,
      label: block.label,
      params: block.params.map((param) => ({ name: param.name, type: param.type })),
      actionCount: block.expand.length,
    });
  }
  return methods;
}

export function canvasMethodById(
  methods: readonly CanvasMethodDecl[],
  id: string,
): CanvasMethodDecl | undefined {
  return methods.find((method) => method.id === id);
}

/** 参数类型的中文名，用于错误文案。 */
export const METHOD_PARAM_LABELS: Readonly<Record<CanvasMethodParamType, string>> = {
  bytes: '字节串',
  int: '整数',
  addr: '地址',
};
