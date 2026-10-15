# pushpop 参考解法

考点是**栈指针每动一次就是一个字宽（8 字节）**，以及**后进先出**：`pop` 最先读到的是最后压进去的那个字。

`swap_top2`（0x400000）先 `pop rax`、再 `pop rcx`。要让 `rax = 0x1337`、`rcx = 0x0bad`，栈上必须是：

- `rsp` 指着的那个槽（第 2 次 `push` 的落点 0x7ffffef0）放 `0x1337`；
- 它上面那个槽（第 1 次 `push` 的落点 0x7ffffef8）放 `0x0bad`。

于是压入顺序与寄存器顺序**相反**：先压 `rcx` 要的值，再压 `rax` 要的值。每次 `push` 让 `rsp` 减 8，
压完两个字 `rsp` 正好停在 0x7ffffef0；两条 `pop` 依次把 `0x1337`、`0x0bad` 读进 `rax`、`rcx`，
`rsp` 回到 0x7fffff00。随后程序自己的两次 `push` 把这两个字按相反顺序写回栈上，`syscall exit` 结束。

payload 只有三步：`push 0x0bad` → `push 0x1337` → `run`。

```json
{
  "actions": [
    { "type": "push", "value": "0x0bad" },
    { "type": "push", "value": "0x1337" },
    { "type": "run" }
  ],
  "expectedVerdict": "won",
  "note": "先压 rcx 要的值、再压 rax 要的值：后进先出"
}
```
