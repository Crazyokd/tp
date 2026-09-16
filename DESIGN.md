---
version: 'alpha'
name: TP Console
description: >-
  Dense operations console for the TP test platform (React + hand-written CSS).
  Source of truth: packages/web/src/styles.css.
colors:
  primary: '#0071e3'
  on-primary: '#ffffff'
  accent: '#087f8c'
  ink: '#202631'
  muted: '#69727e'
  canvas: '#eef2f6'
  surface: '#ffffff'
  surface-glass: 'rgb(255 255 255 / 74%)'
  surface-soft: 'rgb(255 255 255 / 56%)'
  line: 'rgb(58 70 80 / 16%)'
  gold: '#b56b13'
  success: '#24795f'
  info: '#3c6ea8'
  danger: '#b8473f'
  decorator: '#7c3aed'
  slate: '#344054'
typography:
  display-h1:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 22px
    fontWeight: 700
    lineHeight: 1.2
  heading-section:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.2
  heading-block:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.4
  control:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 13px
    fontWeight: 700
  eyebrow-label:
    fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    fontSize: 11px
    fontWeight: 800
  micro-label:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: 9px
    fontWeight: 800
  data-mono:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: 11px
    fontWeight: 700
rounded:
  sm: 7px
  md: 8px
  lg: 10px
  pill: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 22px
components:
  app-shell:
    backgroundColor: '{colors.canvas}'
    textColor: '{colors.ink}'
  header:
    backgroundColor: '{colors.surface-glass}'
    textColor: '{colors.ink}'
  nav-tab-active:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    rounded: '{rounded.sm}'
    height: 34px
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.on-primary}'
    rounded: '{rounded.sm}'
    height: 34px
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.slate}'
    rounded: '{rounded.sm}'
    height: 34px
  button-danger:
    backgroundColor: '#fff5f5'
    textColor: '#991b1b'
    rounded: '{rounded.sm}'
  card:
    backgroundColor: '{colors.surface-glass}'
    textColor: '{colors.ink}'
    rounded: '{rounded.md}'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.sm}'
    height: 36px
  badge-running:
    backgroundColor: '#dbeafe'
    textColor: '#1d4ed8'
    rounded: '{rounded.pill}'
    typography: '{typography.eyebrow-label}'
  badge-passed:
    backgroundColor: '#dcfce7'
    textColor: '#166534'
    rounded: '{rounded.pill}'
  badge-failed:
    backgroundColor: '#fee2e2'
    textColor: '#991b1b'
    rounded: '{rounded.pill}'
  badge-queued:
    backgroundColor: '#fef3c7'
    textColor: '#92400e'
    rounded: '{rounded.pill}'
---

## Overview

密集运维台，不是营销站。`packages/web/`：顶栏 + 四个 hash 路由（Runs / Cases / Builder / Workers）。冷色画布上霜玻璃卡片，树画布 + 等宽时间戳。样式只写 `packages/web/src/styles.css`。图册：`packages/web/public/architecture-atlas/index.html`。

状态文案中文（排队中 / 执行中 / 已通过 / 失败 / 已取消）。路由名、节点类型、capability、路径、ID 保持 ASCII。图标 Lucide。

## Colors

Token 对齐 `styles.css` 的 `:root`。功能色就这几条，不要另发明：

| Token            | Hex                   | 用处                                             |
| ---------------- | --------------------- | ------------------------------------------------ |
| Primary          | `#0071e3`             | 当前导航、唯一实心主按钮                         |
| Accent           | `#087f8c`             | 叶子 / Condition                                 |
| Ink / Muted      | `#202631` / `#69727e` | 正文 / 次级                                      |
| Gold             | `#b56b13`             | Parallel、queued、连接警告                       |
| Info             | `#3c6ea8`             | 运行中节点与边                                   |
| Success / Danger | `#24795f` / `#b8473f` | 通过 vs 失败 / 取消                              |
| Decorator        | `#7c3aed`             | Inverter / wrap                                  |
| Canvas           | `#eef2f6`             | 底；玻璃 56–74% 白；发丝线 `rgb(58 70 80 / 16%)` |

## Typography

两套字体，不要第三套。字重只有 400 / 700 / 800。标题 `line-height: 1.2`。

- **Inter**（系统无衬线兜底）：标题 22、分区 15、块/控件 13、眉题 11/800。
- **ui-monospace**：指标、路径、JSON、ID。数据 11，大写 caption 9。句子不要用等宽。

## Layout

顶栏 + 居中列 `max-width: 1540px`，页边 16（窄于 760px 为 8）。无侧栏。

- Header：品牌、居中导航、刷新；窄屏堆叠。
- Runs：通栏卡片；展开 = 树画布 + 260–330px 详情。
- Cases / Workers：`auto-fill`，`minmax(280px, 1fr)`，12px 缝。
- Builder：`240px | 1fr | 330px`；1180px 以下单列。
- 树节点固定 240×144。Run 画布高 560（窄屏 440）。

## Elevation & Shapes

层次靠玻璃 + 发丝线，不要暗色分层。画布两团固定径向（青 / 金）。面板 `blur(14–20px) saturate(1.4–1.5)`，顶 inset 高光，软投影 `0 10px 30px rgb(47 58 68 / 7%)`。展开 Run 再抬一层并带主色边。选中节点金环，运行中信息色环。当前壳没有模态遮罩。

圆角：控件 7、卡片/节点 8、展开 Run 10、状态 pill 全圆。树槽未投放前虚线。

## Components

- 当前导航：实心 primary。闲置 tab = 描边次按钮。
- 主按钮：`#0071e3` / 白 / 高 34。同一工具条只放一颗。
- 次按钮：白底、`#b8c2d1` 边、slate 字。危险：`#fff5f5` / `#991b1b`（停止）。
- 状态 pill：queued=金，running=信息，passed/idle=绿，failed/canceled=玫。无描边。
- 输入：白底 36px，`#c7d0dd` 边；textarea 等宽。
- 树节点：2px 语义边（控制=primary，叶=accent，装饰=紫，Parallel=金）。Run 模式把通过/失败/取消画在这条边上。

## Do / Don't

- 面板半透明，让画布透出来。不要实心白板或暗色主题。
- ID / 路径 / 时间 / JSON 用等宽；句子不用。
- 新语义先映射已有功能色。
- 尊重 `prefers-reduced-motion`；动效短，不要弹簧。
- 用户状态中文，代码 ASCII。不要给「停止 / 已通过」发明英文壳。
- 样式不要指向 `frontend/` 或 Vue。应用在 `packages/web/`。
