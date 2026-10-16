# callret 参考解法

**一句话考点**：`call` 把**返回地址**压进栈顶（`rsp` 因此下降一个字宽），`ret` 把**当前栈顶**那个字弹出并当地址跳过去 —— 本题的胜负就取决于这两件事的先后。

从初态看，`vuln`（0x400000）的第一条指令还没执行：`rsp = 0x7fffff00`，栈上**没有**返回地址。

三个动作：

1. **`step 1`**：执行 `call helper`。它先把返回地址（`call` 后面那条 `syscall 60`，也就是 0x400009）压进栈：
   `rsp` 从 0x7fffff00 变成 **0x7ffffef8**，`[0x7ffffef8] = 0x400009`，`ip` 跳到 `helper`（0x40000a）。
   此刻 `rsp` 指着的那一格，就是 `ret` 接下来要弹的栈顶。
2. **`push 0x40000b`**：`push` 先把 `rsp` 减 8 到 **0x7ffffef0**，再把 `win` 的地址写进这个新的栈顶。
   于是 `ret` 弹到的不是 `call` 压进去的返回地址，而是我们放上去的 `win`。
3. **`run`**：`helper` 的 `ret` 把 0x7ffffef0 处的 0x40000b 弹进 `ip`，落在 `win`；`syscall 99` 把 `FLAG` 置 1 并结束程序 → 判胜。

**为什么顺序不能反**：`call` 永远把返回地址压在**当时**的栈顶。如果在 `call` 之前就 `push`，返回地址会压在你要用的那个字上面，`ret` 弹到的仍然是 0x400009，程序回到 `call` 后面那条 `syscall 60` 直接退出（判负）。所以必须让 `call` 先执行，再用 `push` 盖在它上面。

payload 从初始状态回放：地址与动作都是字面量，不含任何读运行时状态的构造。

```json
{
  "actions": [
    { "type": "step", "count": 1 },
    { "type": "push", "value": "0x40000b" },
    { "type": "run" }
  ],
  "expectedVerdict": "won",
  "note": "step 1 让 call 把返回地址压到 0x7ffffef8（rsp 随之落到那一格），push 再让 rsp 降到 0x7ffffef0 并写入 win 的地址，ret 弹出的就是它"
}
```
