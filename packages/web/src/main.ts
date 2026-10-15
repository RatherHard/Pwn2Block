/**
 * 前端入口（05 §1）：注册单页应用组件。
 *
 * `app-shell` 会带上顶栏、题面、视图管理器（内含各视图）、payload 窗口（积木画布 + 程序区 + 输出区）
 * 与判题结果面板；首屏数据来自真实后端 `GET /api/challenges`。
 */
import './components/app-shell';

export { Pwn2BlockApp } from './components/app-shell';
