/**
 * 前端入口（05 §1）：注册单页应用组件。
 *
 * `app-shell` 会带上顶栏、题面、视图管理器（内含四个视图）与 payload 窗口占位；
 * 积木画布与编译器是 H 的开发区（`src/blocks/**`、`src/compiler/**`），D1 不 import 它们。
 */
import './components/app-shell';

export { Pwn2BlockApp } from './components/app-shell';
