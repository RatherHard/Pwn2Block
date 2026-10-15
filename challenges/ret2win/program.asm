; ret2win（03 §4）：vuln 停在 leave 之前，学习者要覆盖返回地址回到 win。
; 汇编：pnpm challenge:asm ret2win —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
;
; 注意：栈上的初始返回地址（text 段之外的数据）写在 private.json 的 stack 段 init 里，
; 它指向 lose（0x400003）。改了本文件的布局就要同步那个地址。

.vma text
vuln:
    leave
    ret
win:
    syscall 99
lose:
    syscall 60
