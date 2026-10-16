; stackframe（01 §4 第 4 关 · 栈帧）：
; vuln 的前两条指令建立栈帧：push rbp → mov rbp, rsp；
; 之后 read(0, buf, 0x20) 往帧内的 buf 读入字节，最后 leave → ret 收栈并返回。
;
; 程序停在 mov rbp, rsp 执行完之后（RIP = 0x400002，也就是 mov rsi 之前），此时：
;   RSP = RBP = 0x7ffffef8
;   [rbp]    = 0x7ffffef8  调用者保存的旧 rbp（saved rbp）
;   [rbp+8]  = 0x7fffff00  返回地址（ret addr），初值指向 lose
;   buf      = [rbp-0x10] = 0x7ffffee8
; 学习者的 payload 从 capture(buf) 读进 buf，越界覆盖到 [rbp+8]，把返回地址改成 win，
; 让 leave; ret 返回到 win。考点是「返回地址在帧里的哪个位置」——地址必须从 RBP 算出来。
;
; 汇编：pnpm challenge:asm stackframe —— 它把下面这些指令编译成 private.json 里 text 段的 init 字节。
;
; 本文件用到的两个 opcode 不在 presets/x86ish.json 里，由 public.json 的 encoding 声明：
;   0x05 = mov rbp, rsp（建立帧）      0xb7 = mov rax, imm（win 里把调用号放进 RAX）
; 其余 opcode 都取自 preset（0xbe = mov rsi, imm 用来把 buf 的地址放进 RSI）。
; 改了本文件的指令布局，就要同步 public.json 的 labels、private.json 的
; 初始寄存器（RSP/RBP 与栈上两个字的初值）以及 solution.md 里的落点地址。

.vma text
vuln:
    push rbp             ; 0x55：rsp -= 8，[rsp] = 旧 rbp —— 帧从这里开始
    mov rbp, rsp         ; 0x05：帧指针指向刚压进来的旧 rbp
    mov rsi, 0x7ffffee8  ; 0xbe：read 的目标是帧内的 buf（= [rbp-0x10]）
    mov rdx, 0x20        ; 0xba：一次最多读 0x20 字节，比 buf 本身大
    mov rax, 0           ; 0xb8：调用号 0 = read
    syscall 0            ; 0x11：read(0, buf, 0x20)，整段写进栈
    leave                ; 0xc9：rsp = rbp; pop rbp —— 用帧指针收栈
    ret                  ; 0xc3：从 [rsp] 取出返回地址跳过去
win:
    mov rax, 99          ; 0xb7：调用号 99 = win
    syscall              ; 0x0f：调用号取自 RAX —— 置 FLAG=1 并退出
lose:
    syscall 60           ; 0x0e：exit(0)，未判胜即退出
