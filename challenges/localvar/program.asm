; Local variable overwrite: buf is 16 bytes and access follows it.
; Load access through [rbp+0x10], then exit normally.
.vma text
check_access:
    mov rax, [rbp+0x10]
    syscall 60
