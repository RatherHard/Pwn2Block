; callret（01 §4 第 3 关 · call / ret）：call 把返回地址压进栈，ret 把它弹出并跳过去。
; 汇编：pnpm challenge:asm callret —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
;
; 布局与地址（改动本文件就要同步 public.json 的 labels 与 solution.md）：
;   vuln        0x400000  call helper（9 字节：1 字节 opcode + 8 字节立即数）→ 压入 0x400009、ip = helper
;   after_call  0x400009  syscall 60   ← 它就是 call 压进栈的那个返回地址，正常返回后从这里退出（判负）
;   helper      0x40000a  ret          ← 弹出当前栈顶当地址跳过去；本题的胜负就在这里
;   win         0x40000b  syscall 99   ← 置 FLAG=1 并退出（判胜）
;
; 初始 RSP = 0x7fffff00（写在 private.json 的 initRegisters 里），所以：
;   开局栈上还没有返回地址（call 未执行）；执行 call 之后 RSP = 0x7ffffef8、[0x7ffffef8] = 0x400009；
;   学习者再 push 一个字，落点就是 0x7ffffef0 —— 那一格正是 ret 会弹出的栈顶。
;
; opcode 取自 presets/x86ish.json：0xe8 = call imm、0xc3 = ret、0x0e = syscall exit；
; 0x11（syscall win，const:99）是本题自己 add 的，presets 里没有这一项。
; 本题的 encoding 只保留这四项，其余全部 remove。

.vma text
vuln:
    call helper      ; 0xe8 + 8 字节立即数：rsp -= 8，[rsp] = 下一条地址，ip = helper
after_call:
    syscall 60       ; 0x0e：正常返回后落到这里，结束程序但不判胜
helper:
    ret              ; 0xc3：ip = [rsp]，rsp += 8
win:
    syscall 99       ; 0x11：FLAG = 1 并退出
