; ret2win 夹具程序（03 §4）。汇编结果 c9c30f0e 必须与 private.json 里 text 段的 init 一致：
; challenge:check 会重新汇编一遍做比对，challenge:asm 负责把它写回（E01）。
.vma text
vuln:
    leave
    ret
win:
    syscall 99
lose:
    syscall 60
