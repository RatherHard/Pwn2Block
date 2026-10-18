; ret2rop：原题 .tmp/chall/ret2rop 的 VM 版。
;
; 原题 vuln 的栈上有一个 0x40 字节的 struct frame：
;   struct frame { char buf[0x20]; char mask[0x20]; };
; 后面紧跟着 n、i、saved rbp、ret addr。read(0, frame.buf, 0x100) 会一路写穿
; frame、n、i、saved rbp 和 ret addr；返回前再用 mask 做一次原地 XOR：
;
;   for (i = 0; i < n; i++)
;       frame.buf[i] ^= frame.mask[i];
;
; n 和 i 就落在 buf+0x40 / buf+0x48，正好在溢出区里；循环体写到这两个位置时会
; 改掉自己的上界和计数器。mask 只有 0x20 字节，i >= 0x20 时读到的是 n、i、
; saved rbp、ret addr 以及调用者栈上的字节——它们也都在这次 read 的范围内。
;
; 本移植保留这条自修改 XOR，但 VM 的访存单位是 8 字节字，所以循环按字走；
; 原来逐字节的 n/i 槽在字边界上正好是 buf+0x40 / buf+0x48。
;
; 三个片段不会被 main 主动调用，只能靠栈上的地址依次 ret 进去：
;   pop rsi; ret         rsi = [rsp]; rsp += 8
;   mov rdi, rsi; ret    rdi = rsi（system 的第一个参数）
;   shell                syscall 98：FLAG = 1 并退出；判胜还要求 RDI 指向 name
;
; 汇编：pnpm challenge:asm ret2rop —— 把指令编码写回 private.json 的 text 段 init。
; 改了本文件，要同步 public.json 的 labels、private.json 的初始寄存器，
; 以及 solution.md 里的链地址。

.vma text
main:
    call vuln            ; 0xe8：压入返回地址（下一条 = 0x400009）后跳到 vuln
    syscall 60           ; 0x0e：vuln 正常返回就走到这里，退出（判负）
vuln:
    push rbp             ; 0x55：保存调用者的帧指针
    mov rbp, rsp         ; 0x05：建立自己的栈帧
    sub rsp, 0x50        ; 0x07：frame 0x40 + n 8 + i 8 = 0x50；buf = rsp

    ; read(0, name, 0x10)：先把 16 字节命令读进全局 name
    mov rdi, 0           ; 0xbf：fd = 0
    mov rsi, name        ; 0xbe：目标 = name
    mov rdx, 0x10        ; 0xba：最多 16 字节
    syscall 0            ; 0x11：read

    ; getRandom(frame.mask, 0x20)：固定伪随机源，复制 32 字节到 buf+0x20
    mov rdi, 0x7ffffec0  ; 0xbf：dst = frame.mask = buf + 0x20
    mov rsi, 0x20        ; 0xbe：长度 32
    syscall 318          ; 0x16：getrandom（custom：copy 0x500000 → 0x7ffffec0）

    ; read(0, frame.buf, 0x100)：溢出点，0x100 > 0x20
    mov rdi, 0           ; 0xbf：fd = 0
    mov rsi, rsp         ; 0x06：目标 = buf
    mov rdx, 0x100       ; 0xba：最多 0x100 字节
    syscall 0            ; 0x11：read，返回值 n 在 RAX

    ; n = RAX；i = 0（原题把这两个局部变量放在 frame 之后）
    mov [rsp+0x40], rax  ; 0x22：n 槽
    mov rax, 0           ; 0xb8
    mov [rsp+0x48], rax  ; 0x22：i 槽
xor_loop:
    mov rcx, [rsp+0x48]  ; 0x20：rcx = i
    mov rax, [rsp+0x40]  ; 0x21：rax = n
    mov rdx, rax         ; 0x89：rdx = n
    cmp rcx, rdx         ; 0x1a：i < n ?
    jae xor_done         ; 0x73：i >= n 就结束
    mov rdx, rsp         ; 0x23：rdx = buf
    add rdx, rcx         ; 0x19：rdx = buf + i
    mov rax, [rdx]       ; 0x24：rax = *(buf + i)
    xor rax, [rdx+0x20]  ; 0x25：rax ^= *(buf + i + 0x20)（mask 在 buf+0x20）
    mov [rdx], rax       ; 0x26：写回
    mov rcx, [rsp+0x48]  ; 0x20：重新读 i（循环体可能刚改过 i 槽）
    add rcx, 8           ; 0x1e：下一个 8 字节字
    mov [rsp+0x48], rcx  ; 0x28：写回 i 槽
    jmp xor_loop         ; 0xe9
xor_done:
    leave                ; 0xc9：rsp = rbp; pop rbp
    ret                  ; 0xc3：ip = [rsp] —— 从这一刻起，栈顶就是控制流

gadget_pop_rsi:
    pop rsi              ; 0x5e：rsi = [rsp]; rsp += 8
    ret                  ; 0xc3

gadget_mov_rdi_rsi:
    mov rdi, rsi         ; 0x1f：rdi = rsi
    ret                  ; 0xc3

shell:
    syscall 98           ; 0x12：FLAG = 1 并退出（判胜入口）
    syscall 60           ; 0x0e：兜底，正常不会走到

.vma data
name:
    .byte 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
