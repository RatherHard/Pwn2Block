# Python 求值运行器

节点画布的「Python 节点」在**编译期**做的数据计算由这里执行（06 §6、07 §P6）。本目录只有
一个可执行文件 `runner.py` 和它的自测；服务端怎么选后端、怎么限额、怎么取消在
`packages/server/src/python.ts`。

依赖：**只用标准库**，Python 3.9+（开发与 CI 用 3.12/3.13 验证过）。不需要 pwntools。

## 协议

一个进程只处理一个任务，任务从 stdin 读、结果往 stdout 写：

```
stdin  -> {"requestId": "...", "code": "...", "outputType": "int|bool|bytes|text",
           "inputs": [{"name": "x", "type": "int", "value": {"kind": "int", "value": "123"}}]}

stdout -> {"requestId": "...", "ok": true, "value": {"kind": "bytes", "hex": "c0ffee"}}
      或  {"requestId": "...", "ok": false, "error": {"code": "runtime", "message": "...", "line": 3}}
```

- **stdout 只有这一行**，且是 ASCII（`json.dumps(ensure_ascii=True)`），不依赖终端编码。
  用户代码的 `print` / stderr 全部被捕获丢弃，只计入日志额度，永远不会混进协议。
- `requestId` 由服务端生成；服务端用它丢弃迟到结果。
- 输入名是 Python 变量名（`^[a-z][a-z0-9_]{0,15}$`），最多 8 个。输入可以覆盖同名工具，
  但代码必须自己给 `result` 赋值——`result` 不预置，漏赋值就是 `bad_output`。
- 每次都用一个**全新**的 `globals`，不继承上一次的任何全局变量。

### 错误码

| code | 触发条件 |
|---|---|
| `syntax` | `SyntaxError`（含 `IndentationError`）；带 `line` |
| `runtime` | 其它异常；`message` 只取异常那一行，`line` 取用户代码里的行号 |
| `bad_output` | 没有给 `result` 赋值、类型与声明不符、值无法编码（如文本含孤立代理项） |
| `too_large` | 输出超过 8KB、用户日志超过 4KB、整数超过 512 位十进制 |
| `invalid_request` | 任务本身不合法（正常由服务端 Schema 拦住，这是第二道） |

错误说明会被压成一行、截到 500 字符，并抹掉运行器自身的路径；**完整 traceback、宿主路径和
环境变量都不会回给客户端**。

## 工具函数

与 `packages/shared/src/workflow/toolkit.ts` **同一语义**（07 §P7 最后一条），字母表顺序、
子串宽度（4）和编码规则都相同：

| 工具 | 说明 |
|---|---|
| `cyclic(length, alphabet='lower')` | 定位序列，超过一条 de Bruijn（`k^4`）就循环重复 |
| `cyclic_find(needle, alphabet='lower')` | 首次出现的偏移；**找不到返回 `None`**，不是 `-1` |
| `de_bruijn(alphabet, n=4)` | 完整 de Bruijn 序列（FKM，字典序最小） |
| `ALPHABETS` | `lower` / `upper` / `digits` 三张字母表 |
| `p32/p64(value, endian='little', sign=False)` | 整数 → 4/8 字节（超范围抛 `OverflowError`，不静默截断） |
| `u32/u64(data, endian='little', sign=False)` | 最多 4/8 字节 → 整数；不足长度**右**补零（与 pwntools 一致） |
| `flat(*args, word_size=8, length=None, fill=b'\x00')` | bytes / str / 整数 / 布尔 / 列表与生成器的子集 |

两处与 pwntools 有意的差异：

1. `cyclic_find` 找不到时返回 `None` 而不是 `-1`——`-1` 会混进整数运算，变成「看起来像偏移
   的错误答案」（`toolkit.ts` 的 `cyclicFind` 返回 `undefined`，同一决定）。
2. `flat` 只实现常用子集，不支持 pwnlib 的打包器对象、字典复杂键和嵌套长度补齐；超长直接
   报错而不是截断。

注意：数值只有 `int`/`bool`/`bytes`/`text` 四种能进来、能出去，不传任意 Python 对象（06 §6）。

## 资源限制（尽力而为）

`resource` 模块可用时（POSIX），运行器在 `exec` 用户代码**之前**设置：

- `RLIMIT_AS = PWN2BLOCK_RUNNER_MEMORY_MB`（默认 64，与 `PYTHON_EVAL_MEMORY_MB` 一致）。
  这个上限把解释器自身已占的地址空间也算在内，所以用户代码实际可用的是「64MB 减去解释器」。
- `RLIMIT_CPU = PWN2BLOCK_RUNNER_CPU_SECONDS`（默认 3 秒，超时由服务端按墙钟先兜住）。
- `RLIMIT_NOFILE = 32`。

`resource` 不可用时（Windows）**明确降级**：不设这些限制，只在 stderr 打一行
`resource limits unavailable (no resource module)`，此时内存/CPU 只能靠上层（docker 的
`--memory`/`--cpus` 或服务端超时）。

另外，运行器在跑用户代码前会**清空 `os.environ`**：即使 `process` 后端忘了清环境，
用户代码也读不到宿主凭据。

## 隔离声明（请按字面读）

**普通子进程不是隔离完成的证据**（07 §2）。本目录的代码只提供「协议 + 尽力限额」。

| 后端 | 谁提供隔离 | 能挡住什么 |
|---|---|---|
| `docker` | `docker run --network=none --read-only --memory=… --pids-limit=64 --user 65534:65534` | 网络、宿主文件系统（只读挂载 runner.py）、其它进程、内存与 CPU |
| `process` | **没有隔离** | 只有独立进程 + 独立临时 cwd + 空环境 + 超时；文件、网络、子进程都**没有**限制。仅用于开发与本机验证 |
| `none`（默认） | —— | 不可用。服务端直接回 `unavailable`，绝不退化成宿主直接执行 |

因此 `capability()` 只在 `docker` 后端下返回 `isolated: true`。不要用 `process` 后端作为
「已隔离」的证据，也不要在生产环境启用它。

## 自测

```bash
cd packages/python-runner
python -m unittest discover -s . -p "test_*.py" -v
```

仓库根也提供了一个便捷脚本：`pnpm test:python`（它用 `python`；Linux 上若只有 `python3`，
按上面那条直接跑，CI 用的就是 `python3`）。

不依赖 docker、不依赖第三方包；子进程用例会真的起一个解释器走 stdin/stdout。CI 在 Linux 上
跑同一组用例（见 `.github/workflows/ci.yml`）。服务端那一侧的 `process` 后端会把 `runner.py`
当真正的运行器启动，docker 后端的用例在守护进程或镜像缺席时整组跳过——**跳过不等于通过**。

## 已知未做

- 没有 pip 依赖、也没有 `pwn` 模块：只提供上表那几个 pwntools 风格工具。
- `process` 后端不做文件/网络/进程限制（见上表），它只是开发入口。
- 没有镜像构建脚本：`docker` 后端直接用 `PWN2BLOCK_PYTHON_IMAGE`（默认 `python:3.12-alpine`）
  挂载 `runner.py`，不预装任何包。
- `RLIMIT_AS` 的 64MB 是「解释器 + 用户数据」的总量；若换成体积更大的基础镜像，需要调大
  `PWN2BLOCK_RUNNER_MEMORY_MB` 并单独验证。启动时若发现解释器自己已用掉 48MB 以上，运行器会
  跳过这条限制并在 stderr 记一行说明（不假装设过）。
- 日志捕获是在 `sys.stdout` / `sys.stderr` 这一层：代码若直接写 fd 1（`os.write(1, …)`）会绕过它，
  于是 stdout 变成多行，服务端按 `bad_output` 拒掉这次求值。也就是说这类输出只能把自己的
  求值弄失败，伪造不了结果（`requestId` 在服务端手里，且类型与大小还要再过一遍校验）。
- 没有做 seccomp / user namespace 之外的额外裁剪；隔离强度就是 docker 那几个参数，
  不要把它当成「任意代码执行沙箱」的完整证明。
