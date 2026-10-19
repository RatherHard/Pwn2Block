import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * 节点画布闭环：真实浏览器 + 真实后端 + 生产构建，不 mock API。
 *
 * 用界面本身构造 ret2win 的 payload：节点库里放「开始」「题目专用动作」「执行指令」，
 * 检查器里选 `gets(buf)`、填字节、把单步次数改成 3，然后编译、先提交一次错的
 * （验证来源定位把出错动作指回画布），再改对并提交拿到 flag。
 */
test.skip(process.env.PWN2BLOCK_E2E !== '1', '需要 PWN2BLOCK_E2E=1 和已启动的真实后端');

const PAYLOAD_WRONG = '41'.repeat(32);
const PAYLOAD_WIN = '41'.repeat(16) + '42'.repeat(8) + '0200400000000000';

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

/** 画布上的节点 id（读面板自己的文档，不猜 DOM 顺序）。 */
async function nodeIdOf(page: Page, kind: string): Promise<string> {
  const panel = page.locator('pwn2block-graph-panel');
  const id = await panel.evaluate((element, wanted) => {
    const document = (element as unknown as { currentDocument(): { nodes: { id: string; kind: string }[] } })
      .currentDocument();
    return document.nodes.find((node) => node.kind === wanted)?.id;
  }, kind);
  if (id === undefined) throw new Error(`画布上没有 ${kind} 节点`);
  return id;
}

async function selectNode(page: Page, kind: string): Promise<Locator> {
  const id = await nodeIdOf(page, kind);
  const node = page.locator(`pwn2block-graph-canvas .node[data-node="${id}"]`);
  // 用面板自己的定位入口选中：它会展开容器并把视口移到节点，比按坐标点画布稳定。
  await page
    .locator('pwn2block-graph-panel')
    .evaluate((element, nodeId) => (element as unknown as { locate(request: { nodeId: string }): void }).locate({ nodeId }), id);
  await expect(page.locator('pwn2block-graph-panel aside.inspector')).toContainText(id);
  return node;
}

async function addNode(page: Page, label: string): Promise<void> {
  const library = page.locator('pwn2block-graph-panel').getByRole('complementary', { name: '节点库' });
  await library.getByRole('searchbox', { name: '搜索节点' }).fill(label);
  await library.getByRole('button', { name: label, exact: true }).click();
}

async function setAuthorData(page: Page, hex: string): Promise<void> {
  const node = await selectNode(page, 'action.author');
  const id = await node.getAttribute('data-node');
  if (id === null) throw new Error('节点没有 id');
  const inspector = page.locator('pwn2block-graph-panel aside.inspector');
  const block = inspector.locator(`input#${id}-id`);
  await block.fill('gets');
  await block.press('Tab');
  const input = inspector.locator(`input#${id}-data`);
  await input.fill(hex);
  await input.dispatchEvent('change');
  const saved = await page.locator('pwn2block-graph-panel').evaluate((element, nodeId) => {
    const document = (element as unknown as {
      currentDocument(): { nodes: { id: string; params: Record<string, unknown> }[] };
    }).currentDocument();
    return document.nodes.find((candidate) => candidate.id === nodeId)?.params;
  }, id);
  expect(saved).toMatchObject({ data: hex });
}

test('画布闭环：构造 payload、错误定位、改对后提交判胜并在刷新后恢复', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');
  const panel = page.locator('pwn2block-graph-panel');
  const picker = page.getByRole('region', { name: '选择题目' });
  if (await picker.isVisible()) await picker.getByRole('button').first().click();
  await expect(panel).toBeVisible();

  await test.step('首次进入是空画布：没有预置节点，只提示下一步（10 §5）', async () => {
    await expect(panel.locator('.empty-hint')).toBeVisible();
    const nodes = await panel.evaluate((element) =>
      (element as unknown as { currentDocument(): { nodes: unknown[] } }).currentDocument().nodes.length,
    );
    expect(nodes).toBe(0);
    await capture(page, info, '01-empty-canvas');
  });

  await test.step('从节点库依次放「开始」「题目专用动作」「执行指令」', async () => {
    await addNode(page, '开始');
    await addNode(page, '题目专用动作');
    await addNode(page, '执行指令');
    expect(await nodeIdOf(page, 'start')).toBe('start');
    await setAuthorData(page, PAYLOAD_WRONG);

    const stepId = await nodeIdOf(page, 'action.step');
    await selectNode(page, 'action.step');
    const count = page.locator(`pwn2block-graph-panel aside.inspector input#${stepId}-count`);
    await count.fill('3');
    await count.press('Tab');

    await panel.getByRole('button', { name: '编译', exact: true }).click();
    await expect(panel).toContainText('编译成功');
    await expect(page.locator('pwn2block-app .status')).toContainText('动作 0/2');
  });
  await capture(page, info, '02-compiled-graph');

  await test.step('先提交错误 payload：判题被拒，画布高亮产生被拒动作的节点', async () => {
    await runCommand(page, '提交判题');
    const verdict = page.locator('pwn2block-verdict-panel');
    await expect(verdict).toBeVisible();
    await expect(verdict).toContainText('运行失败');
    await expect(verdict).toContainText('第 2 个动作「step」');

    await capture(page, info, '03-failed-verdict');
  });

  await test.step('回到调试、改成正确地址再提交：判胜并下发 flag', async () => {
    await page
      .locator('pwn2block-verdict-panel')
      .getByRole('button', { name: '回到调试', exact: true })
      .click();
    await expect(panel).toBeVisible();
    await setAuthorData(page, PAYLOAD_WIN);
    await panel.getByRole('button', { name: '编译', exact: true }).click();
    await expect(panel).toContainText('编译成功');

    await runCommand(page, '提交判题');
    const verdict = page.locator('pwn2block-verdict-panel');
    await expect(verdict).toContainText('通过');
    await expect(verdict).toContainText('flag{e2e-graph}');
    await capture(page, info, '04-won');
  });

  await test.step('刷新后新存档把图装回来并重新编译', async () => {
    const before = await panel.evaluate((element) =>
      (element as unknown as { currentDocument(): { nodes: { id: string; kind: string }[] } })
        .currentDocument()
        .nodes.map((node) => `${node.kind}:${node.id}`),
    );
    await page.reload();
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('编译成功');
    const after = await panel.evaluate((element) =>
      (element as unknown as { currentDocument(): { nodes: { id: string; kind: string }[] } })
        .currentDocument()
        .nodes.map((node) => `${node.kind}:${node.id}`),
    );
    expect(after).toEqual(before);
    await capture(page, info, '05-restored');
  });

  expect(errors).toEqual([]);
});
