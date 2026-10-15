; endian（01 §4 第 1 关 · 认识内存与小端序）：
; vuln 把 [RBP+0x8] 处的 8 个字节读成一个 64 位值放进 RAX，然后退出；
; 学习者要往那块槽（0x7fffff08）写 8 个字节，让程序读出来的 RAX 等于 0x1122334455667788。
;
; 汇编：pnpm challenge:asm endian —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
; 两条指令的 opcode 取自 presets/x86ish.json（0x8d = mov rax, [rbp+disp]；0x0e = syscall exit），
; 本题的 encoding 只保留这两项，其余全部 remove。
;
; 注意：目标槽是「RBP 的初值 + 0x8」，RBP 的初值写在 private.json 的 initRegisters 里，
; 槽的地址同时写进了 public.json 的 labels（0x7fffff08）。改了这个初始值就要同步这两处。

.vma text
vuln:
    mov rax, [rbp+0x8]
    syscall 60
