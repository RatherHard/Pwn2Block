/*
 * ret2rop 的 C 伪代码，对应 program.asm。
 *
 * 寄存器写成全局变量：rax、rbx、rsp 就是寄存器视图里的 RAX、RBX、RSP。
 * 栈按 8 字节一格看，所以 rsp 是 uint64_t *，*rsp 就是栈顶那一格。
 *
 * main 只调用 vuln。三个 gadget 和 target 没有人调用，
 * 只能靠栈上排好的地址，被一个接一个的 return 跳进去。
 */

#include <stdint.h>
#include <stdlib.h>     /* exit：syscall 60 */
#include <unistd.h>     /* read：syscall 0 */

void win(void);         /* syscall 99：FLAG = 1 并退出，判胜 */

uint64_t rax, rbx;
uint64_t *rsp;

/*
 * 每个 gadget 都以 return（ret）结尾：执行完不回到调用者，
 * 而是跳到栈顶那一格写的地址，也就是链上的下一段。
 */

/* pop rax; ret */
void gadget_pop_rax(void)
{
    rax = *rsp++;       /* 弹出栈顶一格：链上紧跟在本 gadget 地址后面的那个值 */
}

/* add rax, 0x10; ret */
void gadget_add_rax_10(void)
{
    rax += 0x10;
}

/* mov rbx, rax; ret */
void gadget_mov_rbx_rax(void)
{
    rbx = rax;
}

void target(void)
{
    if (rbx == 0x1010)
        win();
    exit(0);
}

void vuln(void)
{
    char buf[0x50];     /* 栈上依次是 buf、saved rbp、ret addr */

    read(0, buf, 0x100);    /* 最多读 0x100 字节，buf 只有 0x50：多出的部分盖住后面两格 */
}                           /* leave; ret：跳到 ret addr 那一格写的地址 */

int main(void)
{
    vuln();
    exit(0);            /* vuln 正常返回就到这里：退出，不判胜 */
}
