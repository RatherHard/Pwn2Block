/*
 * ret2rop 的 C 伪代码，对应 program.asm。
 *
 * 原题 vuln 的栈上有一个 struct frame（buf[0x20] + mask[0x20]），后面紧跟着
 * n、i、saved rbp、ret addr。流程是：先 read 16 字节 name，再往 frame.mask
 * 填 32 字节随机密钥，然后 read(0, frame.buf, 0x100) 溢出；返回前用
 * frame.buf[i] ^= frame.mask[i] 原地混淆，最后 leave; ret。
 *
 * 两个关键点：
 *   - frame.mask 只有 0x20 字节，i >= 0x20 时 mask[i] 读到的是 n、i、
 *     saved rbp、ret addr 以及调用者栈上的字节；这些位置也在 read 范围内。
 *   - n 和 i 落在 frame.buf + 0x40 / + 0x48，正好在溢出区里；循环体写到
 *     这两个位置时会改掉自己的上界和计数器。
 *
 * 这里用固定字节模拟 getRandom（VM 没有随机源）；原题是逐字节循环，VM 的
 * 访存单位是 8 字节字，所以 program.asm 按字走，n/i 槽仍对应 +0x40 / +0x48。
 * 每个 gadget 末尾的 ret 在 C 里就是函数 return：返回到栈顶写着的下一段地址。
 */

#include <stdint.h>
#include <unistd.h>
#include <stdlib.h>

char name[16];                    /* 0x401000：system 的参数 */

/* VM 的 shell：syscall 98，置 FLAG=1 并退出；判胜还要求 RDI == &name */
void shell(void);

/* 固定伪随机源：把 32 字节复制到 dst（原题是 getrandom，失败再读 /dev/urandom） */
void getRandom(void *dst, unsigned long n);

uint64_t rsi, rdi;
uint64_t *rsp;                    /* 栈按 8 字节一格看 */

/* pop rsi; ret */
void gadget_pop_rsi(void)
{
    rsi = *rsp++;                 /* 弹出栈顶一格到 RSI */
}

/* mov rdi, rsi; ret */
void gadget_mov_rdi_rsi(void)
{
    rdi = rsi;                    /* system 的第一个参数 */
}

struct frame {
    char buf[0x20];               /* 0x7ffffea0：read 的目标 */
    char mask[0x20];              /* 0x7ffffec0：XOR 的「密钥」 */
};

void vuln(void)
{
    struct frame frame;           /* 0x7ffffea0，共 0x40 字节 */
    unsigned long n;              /* 0x7ffffee0 = frame + 0x40 */
    unsigned long i;              /* 0x7ffffee8 = frame + 0x48 */

    read(0, name, sizeof(name));  /* 1. 先读 16 字节 name */
    getRandom(frame.mask, 0x20);  /* 2. 密钥区在 frame.mask */
    n = read(0, frame.buf, 0x100);/* 3. 溢出：frame.buf 只有 0x20 */

    /* 4. 原地 XOR。frame.buf + i 会一路写穿 mask、n、i、saved rbp、ret；
     *    frame.mask + i 在 i >= 0x20 时读到 mask 之后的 n/i/saved rbp/ret，
     *    这些字节同样来自刚才的 read。 */
    for (i = 0; i < n; i += 8)
        *(uint64_t *)(frame.buf + i) ^= *(uint64_t *)(frame.mask + i);
}                                 /* leave; ret */

void shell(void)
{
    /* syscall 98：FLAG = 1; exit */
}

int main(void)
{
    vuln();
    exit(0);                      /* vuln 正常返回：退出，不判胜 */
}
