import { describe, it } from 'vitest';

/**
 * S06 · 发布边界 — owner F（A/C 配合）
 *
 * 08 §5 原文（逐字照抄，不得删减）：
 *   「S06 · F，A/C 配合 发布边界：检查构建产物和实际静态 HTTP 路径，不能取得 private.json、solution.md、
 *     环境文件或注入的 flag 哨兵值。」
 *
 * 07 §5 依据：08 §5 明确说明 S06 是**补充静态发布检查**（不在 07 §5 的十三条之内），
 * 对应 01 §6 第 1、2 条与 04 §6「`private.json` 只在服务端读取，不放进静态资源目录」、07 §7 的部署约定。
 *
 * D1 状态：**未验收**（骨架）。以下条件全部是 `it.todo`，验收通过前一律不勾选（见本目录 README §0/§3）。
 * 验收关卡：G3 · D5。真实对象：真实构建产物（`dist/`）与真实静态托管的 HTTP 路径（含穿越变体）。
 */
describe.skip('S06 发布边界 · 待真实构建产物与静态路径（G3 · D5）', () => {
  it.todo('构建产物目录里不存在 private.json / solution.md / .env* 等私密文件（A/F）');
  it.todo('逐条探测静态路径：private.json、challenges/<id>/private.json、solution.md、.env、.env.example、packages/**、docs/** 全部 404（C/F）');
  it.todo('公开资源可达：/ 与 /index.html 及打包后的 JS/CSS 正常返回（确认探测不是全 404 的假阳性，C/F）');
  it.todo('目录穿越与编码变体（%2e%2e%2f、..%2f、双斜杠、大写、反斜杠）不能绕过静态根（C）');
  it.todo('构建产物（含 sourcemap 与打包后的 JS）里不出现注入的 flag 哨兵值（C/F）');
  it.todo('静态托管根目录只包含 web 构建产物，服务端不以任何路径暴露仓库根（C/A）');
  it.todo('静态目录不做目录浏览，未知路径不返回仓库文件清单（C）');
  it.todo('错误响应不含内部堆栈、文件路径或私有包字段（04 §6，C）');
});
