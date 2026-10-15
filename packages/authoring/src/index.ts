/**
 * `@pwn2block/authoring` 的库接口（E01）。
 *
 * 注意：**可执行入口是 `src/cli.ts`**（`pnpm challenge:*` 指向它），
 * 这里刻意不 re-export `cli.ts`，否则 `import '@pwn2block/authoring'` 会顺带跑一遍 CLI。
 */
export * from './asm';
export * from './challenge-files';
export * from './check';
export * from './new-challenge';
export * from './paths';
export * from './presets';
export * from './private-init';
export * from './solve';
