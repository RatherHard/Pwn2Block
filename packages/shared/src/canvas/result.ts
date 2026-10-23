/**
 * 结果类型：新画布的语义模块一律用返回值报错，不用异常。
 *
 * 求值、转换、切片都可能因为学习者的输入失败，而一处失败不应该让整张图崩掉：
 * 上层要能把错误变成「带节点 id 的问题」，并继续计算别处。异常只留给真正的程序错误。
 */
export type CanvasResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export function ok<T>(value: T): CanvasResult<T> {
  return { ok: true, value };
}

export function fail<T>(message: string): CanvasResult<T> {
  return { ok: false, message };
}
