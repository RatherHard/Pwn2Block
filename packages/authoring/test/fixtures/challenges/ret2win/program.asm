; ret2win 夹具程序（03 §4）。汇编器 D2 接通前，字节直接写在 private.json 的 init 里。
.vma text
vuln:
    leave
    ret
win:
    syscall 99
lose:
    syscall 60
