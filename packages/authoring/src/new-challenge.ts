import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChallengeIdSchema, flagEnvVarName, renderSolutionTemplate } from '@pwn2block/shared';
import { CHALLENGE_FILE_NAMES } from './challenge-files';
import { challengeDir, repoRoot } from './paths';

/**
 * `challenge:new <id>`：从模板生成 `challenges/<id>/` 的四个文件（06 §1、§2.3）。
 *
 * 模板刻意做成**能过 `challenge:check` 的最小骨架**：编码表引用默认 preset、
 * 声明 preset 用到的 syscalls（60 / 1）、栈布局与 label 对齐、`flag` 写环境变量引用。
 * 出题人只需要改 `briefing`、写 `program.asm`、把偏移写进 `solution.md`。
 *
 * 已存在的文件默认不覆盖（要覆盖加 `--force`），避免把出题人的手写内容冲掉。
 */

export interface NewChallengeOptions {
  readonly root?: string;
  readonly force?: boolean;
}

export type NewChallengeResult =
  | { readonly ok: true; readonly id: string; readonly dir: string; readonly written: readonly string[] }
  | { readonly ok: false; readonly id: string; readonly message: string };

export function createChallenge(
  id: string,
  options: NewChallengeOptions = {},
): NewChallengeResult {
  const parsed = ChallengeIdSchema.safeParse(id);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? '题目 id 不合法';
    return { ok: false, id, message: `题目 id 不合法：${message}` };
  }

  const root = options.root ?? repoRoot();
  const dir = challengeDir(id, root);
  const files: readonly (readonly [string, string])[] = [
    [CHALLENGE_FILE_NAMES.public, renderPublicTemplate(id)],
    [CHALLENGE_FILE_NAMES.private, renderPrivateTemplate(id)],
    [CHALLENGE_FILE_NAMES.asm, renderAsmTemplate()],
    [CHALLENGE_FILE_NAMES.solution, renderSolutionTemplate(id)],
  ];

  if (!options.force) {
    const existing = files
      .map(([name]) => name)
      .filter((name) => existsSync(join(dir, name)));
    if (existing.length > 0) {
      return {
        ok: false,
        id,
        message: `目标目录已有题目文件，拒绝覆盖：${existing.join(', ')}（确认要覆盖时加 --force）`,
      };
    }
  }

  mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) writeFileSync(join(dir, name), text, 'utf8');
  return { ok: true, id, dir, written: files.map(([name]) => name) };
}

/** 公开包模板：preset 引用 + 本题特有 opcode + 与 private 对齐的 label。 */
function renderPublicTemplate(id: string): string {
  return `{
  "id": "${id}",
  "title": "TODO：短标题",
  "briefing": "TODO：一句话考点 + 程序做了什么。",
  "archBits": 64,
  "encoding": {
    "preset": "x86ish",
    "add": [
      { "opcode": "0x11", "op": "syscall", "operands": ["const:99"], "mnemonic": "syscall win" }
    ]
  },
  "syscallAbi": { "nr": "RAX", "args": ["RDI", "RSI", "RDX"], "ret": "RAX" },
  "syscalls": [
    { "nr": 60, "name": "exit", "kind": "exit", "doc": "exit(code)" },
    { "nr": 1, "name": "write", "kind": "write", "doc": "write(fd, buf, count)" },
    {
      "nr": 99,
      "name": "win",
      "kind": "custom",
      "doc": "置 FLAG=1 并退出",
      "effects": [{ "type": "set_reg", "reg": "FLAG", "value": "0x1" }, { "type": "exit" }]
    }
  ],
  "fds": [
    { "fd": 0, "name": "stdin", "kind": "stdin" },
    { "fd": 1, "name": "stdout", "kind": "stdout" }
  ],
  "labels": [
    { "name": "buf", "addr": "0x7fffff00", "size": 16, "kind": "buffer" },
    { "name": "saved rbp", "addr": "0x7fffff10", "size": 8, "kind": "saved_bp" },
    { "name": "ret addr", "addr": "0x7fffff18", "size": 8, "kind": "ret_addr" }
  ],
  "allowedActions": ["step", "run", "undo", "reset"],
  "authorBlocks": [
    {
      "id": "gets",
      "label": "gets(buf)",
      "tooltip": "从 buf 起写入字节，不检查长度",
      "params": [{ "name": "data", "type": "bytes" }],
      "expand": [{ "type": "write_bytes", "addr": "0x7fffff00", "hex": "$data" }]
    }
  ],
  "hints": [{ "text": "TODO：先观察栈上 buf 与返回地址的距离。" }]
}
`;
}

/** 私有包模板：寄存器、栈布局、判胜谓词、环境变量 flag 引用。 */
function renderPrivateTemplate(id: string): string {
  const envVar = flagEnvVarName(id);
  return `{
  "registers": ["RAX", "RCX", "RDX", "RBX", "RSP", "RBP", "RSI", "RDI", "RIP", "FLAG"],
  "roles": { "sp": "RSP", "bp": "RBP", "ip": "RIP" },
  "initRegisters": { "RSP": "0x7fffff00", "RBP": "0x7fffff10", "RIP": "0x400000" },
  "vmas": [
    {
      "id": "text",
      "kind": "code",
      "start": "0x400000",
      "size": "0x1000",
      "perm": "rx",
      "hidden": false,
      "init": [{ "at": "0x400000", "hex": "c9c3" }]
    },
    {
      "id": "stack",
      "kind": "stack",
      "start": "0x7fffe000",
      "size": "0x2000",
      "perm": "rw",
      "hidden": false,
      "init": [{ "at": "0x7fffff10", "hex": "40ffff7f000000000300400000000000" }]
    }
  ],
  "win": { "reg_eq": { "reg": "FLAG", "value": "0x1" } },
  "fail": [
    { "all": [{ "exited": {} }, { "not": { "reg_eq": { "reg": "FLAG", "value": "0x1" } } }] }
  ],
  "flag": "env:${envVar}"
}
`;
}

/** `program.asm` 骨架：`.vma` 段、标签、三种内置作用各来一条。 */
function renderAsmTemplate(): string {
  return `; TODO：写程序。汇编器（challenge:asm）在 D2–D3 接通，现在也可以直接手写 private.json 的 init。
; 约定：jmp / call 的目标写标签，汇编器算出绝对地址（06 §2.2）。

.vma text
vuln:
    leave
    ret
win:
    syscall 99
lose:
    syscall 60
`;
}
