; ret2rop：从 ret2win 再往前走一步——不再只改一个返回地址跳进现成函数，而是用 ret
; 把一串 gadget（以 ret 结尾的小片段）接起来，让程序按你排好的顺序执行它们。
;
; 程序从 main 开始：call vuln → vuln 建立栈帧，read(0, buf, 0x100) 往只有 0x50
; 字节的 buf 里读，最后 leave; ret 把栈顶那 8 字节当作返回地址跳过去。
;
; 三个 gadget 和 target 都不会被 main 主动调用，它们的用处是：
;   pop rax; ret         rax = [rsp]; rsp += 8
;   add rax, 0x10; ret   rax += 0x10
;   mov rbx, rax; ret    rbx = rax
;   target               rbx == 0x1010 才判胜，否则退出
; 让 vuln 的 ret 先落到第一个 gadget，剩下的段地址依次排在栈上即可。
;
; 汇编：pnpm challenge:asm ret2rop —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
;
; 下面这些 opcode 不在 presets/x86ish.json 里，由 public.json 的 encoding 声明：
;   0x05 mov rbp, rsp    0x06 mov rsi, rsp    0x07 sub rsp, imm
;   0x11 syscall read    0x12 syscall win    0x13 add rax, imm
;   0x14 mov rbx, rax    0x15 cmp rbx, imm
; 其余都取自 preset（0x55 push rbp、0xe8 call、0xc9 leave、0xc3 ret、0x58 pop rax、
; 0xbf mov rdi, imm、0xba mov rdx, imm、0x75 jne、0x0e syscall exit）。
;
; 改了本文件的布局，就要同步 public.json 的 labels、private.json 的初始寄存器，
; 以及 solution.md 里的链地址。

.vma text
main:
    call vuln            ; 0xe8：压入返回地址（下一条 = 0x400009）后跳到 vuln
    syscall 60           ; 0x0e：vuln 正常返回就走到这里，直接退出（判负）
vuln:
    push rbp             ; 0x55：保存调用者的帧指针
    mov rbp, rsp         ; 0x05：建立自己的栈帧
    sub rsp, 0x50        ; 0x07：给 buf 留 0x50 字节
    mov rdi, 0           ; 0xbf：read 的 fd = 0（stdin）
    mov rsi, rsp         ; 0x06：read 的目标 = buf
    mov rdx, 0x100       ; 0xba：一次最多读 0x100 字节 —— 比 buf 大
    syscall 0            ; 0x11：read(0, buf, 0x100)
    leave                ; 0xc9：rsp = rbp; pop rbp
    ret                  ; 0xc3：ip = [rsp] —— 从这一刻起，栈顶就是控制流
gadget_pop_rax:
    pop rax              ; 0x58：rax = [rsp]; rsp += 8
    ret                  ; 0xc3
gadget_add_rax_10:
    add rax, 0x10        ; 0x13：rax += 0x10
    ret                  ; 0xc3
gadget_mov_rbx_rax:
    mov rbx, rax         ; 0x14：rbx = rax
    ret                  ; 0xc3
target:
    cmp rbx, 0x1010      ; 0x15：链要算出来的结果
    jne lose             ; 0x75：不对就退出（判负）
    syscall 99           ; 0x12：FLAG = 1 并退出（判胜）
lose:
    syscall 60           ; 0x0e：exit(0)
