# Python 求值后端：部署与诊断

状态：已实现（`none` / `process` / `docker` 三种后端）；在目标部署环境完成 Docker 隔离验证前，不能把「已隔离」当作已验证事实。

日期：2026-10-18

本文件对应 [07-实施计划](07-节点画布与Python数据处理实施计划.md) P6 的部署条目（07 §P6），解释怎么起、怎么配、怎么查。求值协议本身见 [08-技术决策](08-节点画布技术决策.md) §5。

## 1. 三种后端

| `PWN2BLOCK_PYTHON_BACKEND` | 隔离证据 | 用途 |
|---|---|---|
| `none`（默认） | 无 | Python 节点明确报不可用，**绝不**退化为宿主直接执行 |
| `docker` | 有（容器边界） | 唯一可声称隔离的后端 |
| `process` | 无（`isolated=false`） | 仅本机开发；报告里必须写「未隔离」 |

能力由 `GET /api/capabilities` 公开，前端据此显示「不可用 / 已隔离 / 未隔离」；客户端不能提高额度。

## 2. 启动

```bash
# 开发机（不隔离，只用于联调）
PWN2BLOCK_PYTHON_BACKEND=process PWN2BLOCK_PYTHON_EXECUTABLE=python3 pnpm dev

# 部署（隔离）
PWN2BLOCK_PYTHON_BACKEND=docker \
PWN2BLOCK_PYTHON_IMAGE=python:3.12-alpine \
PWN2BLOCK_PYTHON_DOCKER=docker \
pnpm start
```

- Docker 后端要求宿主有可用的 `docker` 命令，且镜像已预拉取（生产环境不要依赖运行期联网拉取）。
- `process` 后端要求 `python3` 在 `PATH` 里，或显式给 `PWN2BLOCK_PYTHON_EXECUTABLE`。
- 求值器只加载任务运行库和临时目录里的脚本，不继承服务端凭据（环境变量白名单），不挂载题目包与 VM。

## 3. 额度（客户端不能改）

默认值集中在 `packages/shared/src/limits.ts`，服务端按请求重新校验：

| 项 | 默认 |
|---|---|
| 单次超时 | 2000 ms |
| 内存 | 64 MB |
| 代码长度 | 20 000 字符 |
| 输出 / 用户日志 | 8 KB / 4 KB |
| 输入个数 / 整数位数 | 8 / 512 |
| 并发 / 排队 | 2 / 8 |
| 每次编译求值次数 | 64 |

容器另外限制 `--network=none`、`--read-only`、`--pids-limit=64`、`--user nobody`、`--rm`；超时或取消后按容器名补杀，避免留下跑满 CPU 的任务。

## 4. 诊断

- `GET /api/capabilities`：后端、是否隔离、不可用原因。启动失败也走这里，不会静默回退。
- 日志事件 `python_unavailable` / `python_spawn_failed` / `python_timeout` / `python_overflow` / `python_cancelled`：都带节点级原因，不泄露宿主路径或秘密。
- 本机自检：`pnpm test:python`（真实后端用例；没有 Docker 守护进程时相关 7 项**跳过**，跳过不等于通过）。
- 浏览器端：画布面板顶部显示 Python 状态；语义编辑会取消在途请求，迟到结果不覆盖新产物。

## 5. 部署验收清单（缺一不可）

1. `GET /api/capabilities` 返回 `backend: "docker", isolated: true`。
2. 容器内无网络：`socket` 连接被拒；无宿主文件：读取 `/etc/passwd` 之外的挂载点不存在；`subprocess`/`fork` 受 pids 限制。
3. 大整数、字节输出、异常、死循环、输出超额、取消、排队上限各跑一遍，错误文案不含宿主路径。
4. 任务间状态隔离：连续两次求值互不可见，临时目录在结束后被删除。
5. 在目标机器上重跑 `pnpm test:python`，确认那 7 项**真正执行**且通过。

第 5 项已在本机（Docker Desktop + python:3.12-alpine）跑通：python-real 19/19 通过；目标部署环境仍需按本清单复跑后再对外声称已验证。
