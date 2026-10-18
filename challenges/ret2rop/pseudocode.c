/*
 * ret2rop —— challenges/ret2rop/program.asm 的 C 伪代码。
 *
 * 这不是能编译的源码：它用 C 的形状描述 VM 里那段伪汇编在做什么。
 * 寄存器直接用 VM 里的名字（RAX / RBX / RSP / RBP），方便对照寄存器视图。
 *
 *   程序入口 main ──call──▶ vuln ──read(0, buf, 0x100)──▶ leave; ret
 *          ▲                                                │
 *          └─────────── 正常返回就走 syscall 60（不判胜） ◀──┘
 *
 * text 段里还躺着三个 gadget 和 target：main 不会主动调用它们，
 * 它们只会在你构造的那条链上，被一个接一个的 ret「弹」进去。
 */

/* 三个 gadget：每段只有一两条指令，而且都以 ret 结尾。 */

void gadget_pop_rax(void)
{
    /* pop rax      ：rax = [rsp]；rsp += 8 */
}

void gadget_add_rax_10(void)
{
    /* add rax, 0x10：rax += 0x10 */
}

void gadget_mov_rbx_rax(void)
{
    /* mov rbx, rax ：rbx = rax */
}

/* target 只认一个结果：RBX 是不是 0x1010。 */
void target(void)
{
    if (rbx != 0x1010) {
        syscall(60);        /* 退出：判负 */
    }
    syscall(99);            /* FLAG = 1 并退出：判胜 */
}

void vuln(void)
{
    char buf[0x50];         /* 栈视图里标着「buf」的那一段 */

    /*
     * read(0, buf, 0x100)：想读 0x100 字节，却只给 buf 留了 0x50 字节。
     * 多出来的字节顺着栈往高地址写，会依次盖住 saved rbp 和返回地址。
     */
    ssize_t n = read(0, buf, 0x100);
    (void)n;

    /*
     * leave：rsp = rbp，再把 [rbp] 弹回 rbp；
     * ret  ：把 [rsp] 那 8 个字节当作下一条指令的地址跳过去。
     * 从这一条 ret 开始，栈上的字节就是控制流。
     */
}

int main(void)
{
    vuln();
    syscall(60);            /* vuln 正常返回就到这里：退出，不判胜 */
    return 0;
}
