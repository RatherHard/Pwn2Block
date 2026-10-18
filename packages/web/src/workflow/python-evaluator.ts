import {
  CapabilitiesResponseSchema,
  PythonEvalRequestSchema,
  PythonEvalResultSchema,
} from '@pwn2block/shared';
import type { PythonCapability } from '@pwn2block/shared';
import type { PythonEvaluator, PythonEvalResult } from './types';

/**
 * 画布侧的 Python 求值入口（06 §6；07 §P7）。
 *
 * 契约：
 * - **不在浏览器执行**：这里只发一个带代码、输出类型和命名输入的请求；没有服务端隔离运行器时
 *   返回 `unavailable`，绝不退回宿主执行（06 §6、08 §2）。
 * - **可替换**：`PythonEvaluator` 接口由编译管线注入，测试用假实现，生产走 HTTP。
 * - **响应要校验**：服务端返回的每个字段都可能是坏数据，先过 Schema 再交给编译器。
 * - **可取消**：请求带 `AbortSignal`，取消映射成 `cancelled` 结果而不是异常穿透编译器。
 */

export const PYTHON_EVAL_ENDPOINT = '/api/python/eval';
export const CAPABILITIES_ENDPOINT = '/api/capabilities';

export interface HttpPythonOptions {
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}

/** 建一个走 HTTP 的求值器；每次编译新建一个，取消信号跟着这次编译走。 */
export function createHttpPython(options: HttpPythonOptions = {}): PythonEvaluator {
  const endpoint = options.endpoint ?? PYTHON_EVAL_ENDPOINT;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  return {
    async evaluate(request): Promise<PythonEvalResult> {
      const parsed = PythonEvalRequestSchema.safeParse(request);
      if (!parsed.success) {
        return { ok: false, error: { code: 'invalid_request', message: 'Python 请求不合法：检查代码、输入与输出类型' } };
      }
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(parsed.data),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (options.signal?.aborted === true) {
          return { ok: false, error: { code: 'cancelled', message: 'Python 求值已取消' } };
        }
        return {
          ok: false,
          error: { code: 'unavailable', message: `连不上 Python 求值服务：${messageOf(error)}` },
        };
      }
      if (!response.ok) {
        return { ok: false, error: { code: statusCodeOf(response.status), message: `求值服务返回 HTTP ${response.status}` } };
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: { code: 'bad_output', message: '求值服务返回的不是 JSON' } };
      }
      const result = PythonEvalResultSchema.safeParse(body);
      if (!result.success) {
        return { ok: false, error: { code: 'bad_output', message: '求值服务返回的字段不完整或类型不对' } };
      }
      return result.data;
    },
  };
}

/** 读一次能力：网络失败返回 `undefined`，由界面说明「未知」，不假装可用。 */
export async function fetchPythonCapability(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PythonCapability | undefined> {
  try {
    const response = await fetchImpl(CAPABILITIES_ENDPOINT, { headers: { accept: 'application/json' } });
    if (!response.ok) return undefined;
    const parsed = CapabilitiesResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.python : undefined;
  } catch {
    return undefined;
  }
}

/** HTTP 状态码 → 节点级错误码；只有请求体问题才是调用方的错。 */
function statusCodeOf(status: number): 'unavailable' | 'quota' | 'too_large' | 'invalid_request' | 'runtime' {
  if (status === 429) return 'quota';
  if (status === 413) return 'too_large';
  if (status === 400) return 'invalid_request';
  if (status === 503 || status === 502 || status === 504) return 'unavailable';
  return 'runtime';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
