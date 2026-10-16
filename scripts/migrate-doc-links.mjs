/* global console */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const legacyDocs = [
  '01-产品与范围.md',
  '02-VM模块.md',
  '03-题目包格式.md',
  '04-会话与API.md',
  '05-前端交互.md',
  '06-出题指南.md',
  '07-工程约定.md',
  '08-Agent并行开发日程.md',
  '09-契约冻结.md',
  '10-前端美术与页面设计任务书.md',
  '11-部署与内部试用.md',
  '12-六题交付说明.md',
  '13-D7验收与交接.md',
  '14-MVP未完成事项.md',
  '15-本地体验与自测.md',
];

const archive = (name) => `docs/archive/mvp-2026-10-16/${name}`;

// 这些文件中的旧路径是历史契约引用，保留章节号并指向只读归档。
const historicalReplacements = legacyDocs.map((name) => ({
  from: `docs/${name}`,
  to: archive(name),
}));

const fileReplacements = new Map([
  // 这些字符串是实际的静态边界探测路径，必须指向当前仍存在的文档。
  ['packages/server/test/c04-static.test.ts', [
    { from: 'docs/01-产品与范围.md', to: 'docs/01-基本架构.md' },
  ]],
  ['tests/acceptance/s06-publish-boundary.test.ts', [
    { from: 'docs/04-会话与API.md', to: 'docs/01-基本架构.md' },
  ]],
  ['tests/acceptance/s04-payload-boundary.test.ts', [
    {
      from: '契约依据（03 §3、04 §2/§5.1、',
      to: `契约依据（${archive('03-题目包格式.md')} §3、${archive('04-会话与API.md')} §2/§5.1、`,
    },
  ]],
  // CLAUDE.md 这一处原本省略了第二个文档的 docs/archive 前缀。
  ['CLAUDE.md', [
    { from: '、`08-Agent并行开发日程.md`', to: `、\`${archive('08-Agent并行开发日程.md')}\`` },
  ]],
]);

const targetFiles = [
  'CLAUDE.md',
  '.env.example',
  'design/frontend/README.md',
  'tests/acceptance/README.md',
  'tests/acceptance/api-lifecycle.test.ts',
  'tests/acceptance/s04-payload-boundary.test.ts',
  'tests/acceptance/s06-publish-boundary.test.ts',
  'tests/e2e/closed-loop.spec.ts',
  'tests/integration/rejected-batch-semantics.test.ts',
  'packages/authoring/src/asm.ts',
  'packages/engine/src/syscall.ts',
  'packages/server/test/c04-static.test.ts',
];

// 短引用没有文件名后缀，但仍然指向已经归档的历史章节。
const shorthandReplacements = [
  { from: '`docs/08`', to: `\`${archive('08-Agent并行开发日程.md')}\`` },
  { from: '`docs/07`', to: `\`${archive('07-工程约定.md')}\`` },
  { from: '`docs/09`', to: `\`${archive('09-契约冻结.md')}\`` },
  { from: '`docs/05`', to: `\`${archive('05-前端交互.md')}\`` },
  { from: '`docs/06`', to: `\`${archive('06-出题指南.md')}\`` },
];

const allReplacements = [...historicalReplacements, ...shorthandReplacements];

function applyReplacements(text, replacements) {
  let updated = text;
  let count = 0;
  for (const { from, to } of replacements) {
    let offset = 0;
    while (true) {
      const index = updated.indexOf(from, offset);
      if (index === -1) break;
      updated = `${updated.slice(0, index)}${to}${updated.slice(index + from.length)}`;
      offset = index + to.length;
      count += 1;
    }
  }
  return { updated, count };
}

function migrateFile(relativePath) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`目标文件不存在：${relativePath}`);
  }

  const custom = fileReplacements.get(relativePath) ?? [];
  const replacements = [...custom, ...allReplacements];
  const original = readFileSync(absolutePath, 'utf8');
  const { updated, count } = applyReplacements(original, replacements);
  if (updated !== original) {
    writeFileSync(absolutePath, updated, 'utf8');
    console.log(`更新 ${relativePath}（${count} 处）`);
  }
  return count;
}

function removeLegacyDocs() {
  let removed = 0;
  for (const name of legacyDocs) {
    const absolutePath = resolve(root, 'docs', name);
    if (dirname(absolutePath) !== resolve(root, 'docs')) {
      throw new Error(`拒绝删除 docs 目录之外的路径：${absolutePath}`);
    }
    if (!existsSync(absolutePath)) continue;
    if (!statSync(absolutePath).isFile()) {
      throw new Error(`拒绝删除非普通文件：${absolutePath}`);
    }
    unlinkSync(absolutePath);
    console.log(`删除旧入口 docs/${name}`);
    removed += 1;
  }
  return removed;
}

function assertCurrentDocsExist() {
  const required = [
    'docs/README.md',
    'docs/01-基本架构.md',
    'docs/02-已实现需求.md',
    'docs/03-未实现需求.md',
    'docs/04-已完成工作.md',
    'docs/05-未完成工作.md',
  ];
  for (const relativePath of required) {
    if (!existsSync(join(root, relativePath))) {
      throw new Error(`当前文档缺失：${relativePath}`);
    }
  }
}

function findOldReferences() {
  const extensions = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.json', '.example']);
  const ignored = new Set(['.git', 'node_modules', 'coverage', '.tmp']);
  const results = [];

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name) || (directory === join(root, 'docs') && entry.name === 'archive')) continue;
      if (resolve(directory, entry.name) === resolve(root, 'scripts/migrate-doc-links.mjs')) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!extensions.has(extname(entry.name)) && entry.name !== '.env.example') continue;
      const text = readFileSync(absolutePath, 'utf8');
      for (const name of legacyDocs) {
        if (text.includes(`docs/${name}`)) {
          results.push(relative(root, absolutePath));
          break;
        }
      }
    }
  }

  visit(root);
  return results;
}

assertCurrentDocsExist();
let changed = 0;
for (const relativePath of targetFiles) changed += migrateFile(relativePath);
const removed = removeLegacyDocs();
const leftovers = findOldReferences();
if (leftovers.length > 0) {
  throw new Error(`仍存在旧文档路径引用：${leftovers.join(', ')}`);
}

console.log(`完成：更新 ${changed} 处，删除 ${removed} 个旧文档入口。`);
