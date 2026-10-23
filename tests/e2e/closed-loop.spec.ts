import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import {
  addToolNode,
  dragBetween,
  inspectorOf,
  nodeIdOf,
  openChallenge,
  panelOf,
  portOf,
  readDocument,
  selectNode,
  type CanvasDocumentJson,
} from './helpers';

/**
 * 新版画布的闭环：真实浏览器 + 真实后端 + 生产构建，不 mock API。
 *
 * 这条用例走的是「建图 → 编译 → 判题 → 刷新恢复」整条链路：
 * 1. 首屏是**只有一个开始节点**的新文档（新版画布不再要求用户先自己放一个开始节点）；
 * 2. 从工具箱加方法节点、在检查器里选 `gets(buf)`、把整数值接到 `data` 端口：
 *    接得上（目录按 ANY 放行），但编译期按题目声明判类型不符——错误进输出区，
 *    点「定位积木」能选中出错的节点；
 * 3. 用面板的 `setDocument()`（「导入存档」走的同一个入口）装进一份合法 payload，
 *    编译成功、提交判题、拿到判题结论；
 * 4. 刷新后新档把图装回来并重新编译一次。
 *
 * **已知缺口**（阶段三未完成，见 `docs/节点画布改版计划.md` §4）：画布只产出
 * `{ type: 'block' }`，不产出 `step` / `run`，所以本题的判胜 payload 目前**无法**从界面构造出来。
 * 这就是第 3 步走 `setDocument()` 而不是走点的原因——判胜与 flag 的断言等这个缺口补上以后再放回来。
 * （字面值种类切换已在侧栏补上，空字节串可以直接从界面造出来，见
 * `packages/web/test/canvas-panel-value-kind.test.ts`。）
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

/** 32 字节全 `41`：写满 buf + saved rbp + ret addr，返回地址会变成 0x4141414141414141。 */
const PAYLOAD_WRONG = '41'.repeat(32);

async function capture(page: Page, info: TestInfo, name: string): Promise<void> {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function openRunMenu(page: Page): Promise<Locator> {
  const menu = page.locator('pwn2block-top-bar details.menu');
  if ((await menu.getAttribute('open')) === null) {
    await page.locator('pwn2block-top-bar summary').filter({ hasText: /^运行$/ }).click();
  }
  await expect(menu).toHaveAttribute('open', '');
  return menu;
}

async function runCommand(page: Page, name: string): Promise<void> {
  const menu = await openRunMenu(page);
  await menu.getByRole('button', { name, exact: true }).click();
}

/** 一份「开始 → gets(buf)」的合法文档：方法块的动作展开仍由服务端完成。 */
function payloadDocument(hex: string) {
  return {
    format: 'pwn2block.canvas',
    version: 2,
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'call', kind: 'method', block: 'gets', args: { data: 'payload' } },
      { id: 'payload', kind: 'value', value: { kind: 'byte', hex } },
    ],
    layout: { start: { x: 48, y: 48 }, call: { x: 48, y: 200 }, payload: { x: 320, y: 48 } },
    main: ['start', 'call'],
  };
}

/** 通过面板公开的导入入口替换文档（重置历史、立即落盘、重新编译）。 */
async function installDocument(page: Page, document: ReturnType<typeof payloadDocument>): Promise<void> {
  await panelOf(page).evaluate((element, next) => {
    if (!('setDocument' in element) || typeof element.setDocument !== 'function') {
      throw new Error('画布面板没有 setDocument');
    }
    element.setDocument(next);
  }, document);
}

function kindsOf(document: CanvasDocumentJson): readonly string[] {
  return document.nodes.map((node) => node.kind);
}

test('画布闭环：建图、编译错误定位、判题结论与刷新恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await openChallenge(page);
  const panel = panelOf(page);

  await test.step('首屏是一份空文档：只有一个开始节点，没有任何错误', async () => {
    expect(kindsOf(await readDocument(page))).toEqual(['start']);
    await expect(panel.locator('.status-error')).toContainText('错误 0');
    await expect(panel.locator('.status-unconnected')).toContainText('未接线 0 处');
    await capture(page, info, '01-empty-canvas');
  });

  await test.step('方法节点选 gets(buf) 后才长出参数端口，未接线只提示不报错', async () => {
    await addToolNode(page, 'method');
    const methodId = await nodeIdOf(page, 'method');
    await selectNode(page, methodId);
    await inspectorOf(page).locator('.field-block').selectOption('gets');
    await expect(portOf(page, methodId, 'data')).toHaveClass(/\bhollow\b/);
    await expect(panel.locator('.status-unconnected')).toContainText('未接线 1 处');
    await expect(panel.locator('.status-error')).toContainText('错误 0');
  });

  await test.step('整数值接到 bytes 参数上：编译期报类型不符，点「定位积木」高亮出错的节点', async () => {
    await addToolNode(page, 'value');
    const methodId = await nodeIdOf(page, 'method');
    const valueId = await nodeIdOf(page, 'value');
    await dragBetween(page, portOf(page, methodId, 'data'), panel.locator(`.node-box[data-node="${valueId}"]`));
    await expect(portOf(page, methodId, 'data')).toHaveClass(/\bconnected\b/);
    await expect(panel.locator('.status-error')).not.toContainText('错误 0');

    const output = page.locator('pwn2block-app .output');
    await expect(output).toContainText('需要字节串');
    await output.getByRole('button', { name: '定位积木' }).first().click();
    // 高亮只持续 1.2s（`CanvasHighlight`），所以这里等的是「出现过」而不是「一直在」。
    await expect(panel.locator('.node-box.highlight')).toHaveCount(1);
    await capture(page, info, '02-compile-failed');
  });

  await test.step('装入合法 payload：编译成功，动作数与状态栏一致', async () => {
    await installDocument(page, payloadDocument(PAYLOAD_WRONG));
    await expect(panel.locator('.status-error')).toContainText('错误 0');
    await expect(panel.locator('.status-unconnected')).toContainText('未接线 0 处');
    await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/1');
    await capture(page, info, '03-compiled');
  });

  await test.step('提交判题：结论由服务端给出（本题还缺 step/run，只能跑到「没有达成目标」）', async () => {
    await runCommand(page, '提交判题');
    const verdict = page.locator('pwn2block-verdict-panel');
    await expect(verdict).toBeVisible();
    await expect(verdict).toContainText('payload 跑完了，但没有达成目标');
    await capture(page, info, '04-verdict');
  });

  await test.step('刷新后新档把图装回来并重新编译一次', async () => {
    const before = (await readDocument(page)).nodes.map((node) => `${node.kind}:${node.id}`);
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(page.locator('pwn2block-app p.status')).toContainText('动作 0/1');
    const after = (await readDocument(page)).nodes.map((node) => `${node.kind}:${node.id}`);
    expect(after).toEqual(before);
    await capture(page, info, '05-restored');
  });

  expect(errors).toEqual([]);
});
