; pushpop（01 §4 第 2 关）：swap_top2 把栈顶两个字依次弹出来，再按相反顺序压回去。
; 汇编：pnpm challenge:asm pushpop —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
;
; 栈上的初始内容（text 段之外的数据）写在 private.json 的 stack 段 init 里：
; 0x7fffff00 那一个字是旧值（0xdeadbeefdeadbeef）。学习者只压一个字时，第二次 pop 会读它。
; 改了本文件的指令布局，就要同步 public.json 的 labels 与 solution.md 里的落点地址。

.vma text
swap_top2:
    pop rax          ; 0x58：rax = [rsp]，rsp += 8
    pop rcx          ; 0x59：rcx = [rsp]，rsp += 8
    push rax         ; 0x50：rsp -= 8，[rsp] = rax
    push rcx         ; 0x51：rsp -= 8，[rsp] = rcx，两个字在栈上换了位置
    syscall 60       ; 0x0e：exit(rdi)，本题用退出收尾
