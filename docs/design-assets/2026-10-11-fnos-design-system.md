# 飞牛 fnOS 视觉设计系统提取报告

> **用途**：把现有 React 客户端 1:1 换皮成飞牛 fnOS 的外观。本文所有数值均来自真实 NAS 的 Web UI（`http://192.168.3.127:5666/`，fly牛 fnOS `1.2.0701`）的**实测**：DOM `getComputedStyle` + 元素 `getBoundingClientRect`，并对照打包后的 CSS（`index-CJVPgcLg.css`，635 KB）与 JS bundle（`index-DhUqaTaA.js`）交叉验证。
>
> **取证环境**：真实登录会话（headless Chrome 155 / CDP），视口 **1600×1000**（另有 2560×1440）、`devicePixelRatio=1`、`lang=zh-CN`、主题分别为 light / dark。
>
> **可信度标注**：
> - 无标注 = 直接从 DOM/CSS 实测得到。
> - `CSS 推导` = 从样式表规则推导（该状态在本次会话中未触发）。
> - `未测得` = 本次未能验证，**不要凭空编造**。
>
> **凭据**：登录账号/口令未写入本文（按安全要求脱敏）。截图中的账号名与内网 IP 属被授权环境信息。
>
> **重要前提**：该 VM **未创建存储空间**（System Settings → 存储空间：`未创建存储空间 / 去创建`）。因此文件管理、相册、影视等**内容区只能看到空状态**，文件列表行、缩略图网格等未测得。

---

## 0. 关键结论速览

| 项 | 值 |
|---|---|
| 组件库 | Semi Design (`@douyinfe/semi-ui`)，类名前缀 `semi-`，fnOS 在其上加了 Tailwind 工具类与 `trim-ui__* / trim-os__*` 自有类 |
| 主色（light & dark **相同**） | `#0066FF` |
| 主题切换机制 | `body[theme-mode="dark"]`（**不是** `html.dark`）；`html` 始终保持 `class="light"` |
| 字体 | `"PingFang SC", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`（zh-CN） |
| 应用窗口默认尺寸 | **1100 × 640 px**（CSS 变量 `--app-window-default-width/height`） |
| 窗口标题栏高度 | **44 px**，标题 **14px / 20px / 600**，应用图标 **24 × 24** |
| 窗口按钮 | **46 × 44 px** 每个，图标 **16 × 16**，关闭按钮 hover 变 `--semi-color-danger` 底 + 白字 |
| 左侧应用栏（rail） | 容器宽 **66 px**，实际玻璃条 **52 × 高(**视口−30**)**，圆角 **6px**，`blur(20px)` |
| 桌面图标单元格 | **144 × 120 px**，图标 **52 × 52**，标签 **14px/18px/700/白** |
| 圆角阶梯 | 3 / 6 / 8 / 12 / 16 / 32 / 9999 px |
| 窗口阴影 | `--semi-shadow-app`（三段叠加，见 §1.6） |
| 间距阶梯 | 2 / 8 / 12 / 16 / 20 / 24 / 40 px |

---

## 1. 设计令牌（Design Tokens）

### 1.1 主题作用域 —— 哪一份是 light，哪一份是 dark

CSS bundle 里两套色板以**不同选择器**声明，实测确认：

```css
/* LIGHT —— 默认，未设置 theme-mode 时生效 */
body,
body[theme-mode=dark] .semi-always-light,
:host, :host .semi-always-light { /* 浅色令牌 */ }

/* DARK */
body[theme-mode=dark],
body .semi-always-dark,
:host([theme-mode=dark]) { /* 深色令牌 */ }
```

实测确认：
- 浅色：`document.body.getAttribute('theme-mode') === null`，`document.documentElement.className === "light"`
- 深色：`document.body.getAttribute('theme-mode') === "dark"`，`document.documentElement.className` **仍然是 `"light"`**

> ⚠️ **实现要点**：换皮时请把 dark 选择器绑定到 `body[theme-mode="dark"]`（或自己项目里等价的一个容器属性），不要绑到 `html.dark`。`html.light/dark` 这两个类只在 `/biz` 分支里有意义。
>
> ⚠️ 登录页外层带死类名 `semi-always-light`（`class="semi-always-light login-form ..."`），**登录页恒为亮色**，切到 dark 主题时登录页不变。

### 1.2 品牌色阶 `--semi-brand-0..9`（CSS 里是 `r,g,b` 三元组，不是 hex）

**LIGHT**（数值取自 `:root` 级浅色块）：

| token | rgb | hex |
|---|---|---|
| `--semi-brand-0` | 230,244,255 | `#E6F4FF` |
| `--semi-brand-1` | 215,237,255 | `#D7EDFF` |
| `--semi-brand-2` | 171,219,255 | `#ABDBFF` |
| `--semi-brand-3` | 117,191,255 | `#75BFFF` |
| `--semi-brand-4` | 51,133,255 | `#3385FF` |
| `--semi-brand-5` | 0,102,255 | `#0066FF` ← **浅色 primary 取此档** |
| `--semi-brand-6` | 0,94,235 | `#005EEB` |
| `--semi-brand-7` | 0,67,184 | `#0043B8` |
| `--semi-brand-8` | 0,45,112 | `#002D70` |
| `--semi-brand-9` | 0,31,77 | `#001F4D` |

**DARK**（色阶方向反转，0 最深）：

| token | rgb | hex |
|---|---|---|
| `--semi-brand-0` | 0,37,112 | `#002570` |
| `--semi-brand-1` | 0,52,148 | `#003494` |
| `--semi-brand-2` | 0,67,184 | `#0043B8` |
| `--semi-brand-3` | 0,84,219 | `#0054DB` |
| `--semi-brand-4` | 0,102,255 | `#0066FF` ← **深色 primary 取此档** |
| `--semi-brand-5` | 51,136,255 | `#3388FF` |
| `--semi-brand-6` | 102,168,255 | `#66A8FF` |
| `--semi-brand-7` | 153,199,255 | `#99C7FF` |
| `--semi-brand-8` | 204,228,255 | `#CCE4FF` |
| `--semi-brand-9` | 235,244,255 | `#EBF4FF` |

> 因为 `--semi-color-primary` 在 light 取 `brand-5`、在 dark 取 `brand-4`，而两者都是 `0,102,255`，**主色在两种主题下完全一致 = `#0066FF`**。差别只在派生的 hover / active / 12% 透明底上。

### 1.3 可直接粘贴的令牌块

下面是**解析后的字面值**（把 Semi 的 `var()` 链全部展开），可直接贴进现有项目；右列注释是它在 fnOS 里的原名，便于回溯。

```css
/* ============================================================
   fnOS 设计令牌 —— LIGHT（默认）
   用法：:root { ... } ，或 <html data-fn-theme="light">
   ============================================================ */
:root {
  /* ---- 品牌 ---- */
  --fn-brand-0: #E6F4FF;   /* --semi-brand-0 */
  --fn-brand-1: #D7EDFF;
  --fn-brand-2: #ABDBFF;
  --fn-brand-3: #75BFFF;
  --fn-brand-4: #3385FF;
  --fn-brand-5: #0066FF;
  --fn-brand-6: #005EEB;
  --fn-brand-7: #0043B8;
  --fn-brand-8: #002D70;
  --fn-brand-9: #001F4D;

  /* ---- 主色与派生 ---- */
  --fn-primary:              #0066FF;                  /* --semi-color-primary */
  --fn-primary-hover:        #005EEB;                  /* --semi-color-primary-hover */
  --fn-primary-active:       #0043B8;                  /* --semi-color-primary-active */
  --fn-primary-disabled:     rgba(0, 102, 255, 0.16);  /* --semi-color-primary-disabled */
  --fn-primary-tint-12:      rgba(0, 102, 255, 0.12);  /* --semi-color-primary-light-default  选中态底 */
  --fn-primary-tint-20:      rgba(0, 102, 255, 0.20);  /* --semi-color-primary-light-hover */
  --fn-primary-tint-30:      rgba(0, 102, 255, 0.30);  /* --semi-color-primary-light-active */

  /* ---- 背景 / 表面分层 ---- */
  --fn-bg-0:           #F3F3F3;   /* --semi-color-bg-0  页面最底 */
  --fn-bg-1:           #FFFFFF;   /* --semi-color-bg-1  ★卡片/内容面板主表面 */
  --fn-bg-2:           #FFFFFF;   /* --semi-color-bg-2  ★弹窗表面 */
  --fn-bg-3:           #FFFFFF;   /* --semi-color-bg-3  toast/浮层 */
  --fn-bg-4:           #FFFFFF;   /* --semi-color-bg-4 */
  --fn-window-base:    #F3F3F3;   /* --semi-color-app            应用窗口底板 */
  --fn-pane-bg:        #FFFFFF;   /* --semi-color-app-container  应用内容窗格 */
  --fn-nav-bg:         #FAFAFA;   /* --semi-color-nav-bg */
  --fn-menu-bg:        #FFFFFF;   /* --semi-color-bg-dropdown     右键菜单/下拉面板 */
  --fn-glass-card:     rgba(255, 255, 255, 0.90); /* --semi-color-Component-card  桌面悬浮玻璃卡 */
  --fn-glass-bg:       rgba(255, 255, 255, 0.50); /* --semi-color-Component-bg */
  --fn-rail-bg:        rgba(134, 164, 179, 0.05); /* --semi-color-fndesktop-navbarBg  ★左侧应用栏底 */
  --fn-rail-border:    rgba(255, 255, 255, 0.20); /* --semi-color-fndesktop-navbarBorder */
  --fn-avatar-bg:      rgba(90, 91, 92, 0.16);    /* --semi-color-bg-avatar */
  --fn-bg-transparent: rgba(255, 255, 255, 0);    /* --semi-color-bg-transparent */
  --fn-bg-anti:        #0B0B0C;                   /* --semi-color-bg-anti */

  /* ---- 填充（半透明叠加层） ---- */
  --fn-fill-0: rgba(11, 11, 12, 0.04);  /* hover 底色，最轻 */
  --fn-fill-1: rgba(11, 11, 12, 0.06);
  --fn-fill-2: rgba(11, 11, 12, 0.12);
  --fn-fill-3: rgba(11, 11, 12, 0.20);

  /* ---- 文字 ---- */
  --fn-text-0: #0B0B0C;                  /* 主文字 */
  --fn-text-1: rgba(11, 11, 12, 0.75);   /* 次级（侧边栏未选中、图标按钮） */
  --fn-text-2: rgba(11, 11, 12, 0.50);   /* 三级（字段标签、次要说明） */
  --fn-text-3: rgba(11, 11, 12, 0.25);   /* 四级（禁用、占位） */
  --fn-text-anti: #FFFFFF;               /* 反色文字 */

  /* ---- 描边 / 分割线 ---- */
  --fn-border:        rgba(11, 11, 12, 0.16);  /* 输入框/下拉默认描边 */
  --fn-border-hover:  rgba(11, 11, 12, 0.20);
  --fn-border-active: rgba(11, 11, 12, 0.24);
  --fn-border-modal:  rgba(11, 11, 12, 0.06);  /* ★窗口 outline & 弹窗描边 */
  --fn-border-select: rgba(11, 11, 12, 0.06);  /* 右键菜单描边 */
  --fn-focus-border:  #0066FF;                 /* ★应用栏选中左侧竖条、输入聚焦 */
  --fn-divider-0:     rgba(11, 11, 12, 0.20);
  --fn-divider-1:     rgba(11, 11, 12, 0.12);  /* 表格表头下边线 */
  --fn-divider-2:     rgba(11, 11, 12, 0.06);
  --fn-card-border:   rgba(11, 11, 12, 0.08);

  /* ---- 功能色 ---- */
  --fn-link:            #0066FF;
  --fn-link-hover:      #005EEB;
  --fn-link-active:     #0043B8;
  --fn-danger:          #DB382C;   /* light 取 red-5 */
  --fn-danger-hover:    #B7251F;
  --fn-danger-active:   #941515;
  --fn-success:         #009E61;   /* light 取 green-5 */
  --fn-success-hover:   #008453;
  --fn-success-active:  #006944;
  --fn-warning:         #E06C00;   /* light 取 amber-5 */
  --fn-warning-hover:   #BC5100;
  --fn-warning-active:  #993A00;
  --fn-info:            #0066FF;
  --fn-tertiary:        #4B4B4B;
  --fn-secondary:       #008FF0;
  --fn-default:         #FAFAFA;
  --fn-default-hover:   #F3F3F3;

  /* ---- 禁用 ---- */
  --fn-disabled-text:   rgba(11, 11, 12, 0.25);
  --fn-disabled-fill:   rgba(11, 11, 12, 0.04);
  --fn-disabled-bg:     #F3F3F3;
  --fn-disabled-border: rgba(11, 11, 12, 0.16);

  /* ---- 遮罩 ---- */
  --fn-overlay:        rgba(0, 0, 0, 0.70);      /* --semi-color-overlay-bg（全屏弹窗） */
  --fn-overlay-anti:   rgba(255, 255, 255, 0.70);/* --semi-color-overlay-CustomAnti ★应用窗口内弹窗遮罩（浅灰白） */

  /* ---- 滚动条 ---- */
  --fn-scrollbar:        rgba(90, 91, 92, 0.16);
  --fn-scrollbar-hover:  rgba(90, 91, 92, 0.32);

  /* ---- 输入框 ---- */
  --fn-input-bg:          #FFFFFF;  /* --semi-color-input-DefaultBg */
  --fn-input-bg-hover:    #FFFFFF;  /* --semi-color-input-HoverBg */
  --fn-input-bg-active:   #FFFFFF;  /* --semi-color-input-ActiveBg */
  --fn-input-bg-disabled: rgba(90, 91, 92, 0.16);

  /* ---- 进度条底 ---- */
  --fn-progress-track: rgba(11, 11, 12, 0.06);  /* --semi-color-progress-defaultBg */

  /* ---- 圆角 ---- */
  --fn-radius-xs:   3px;    /* --semi-border-radius-extra-small / small */
  --fn-radius-md:   6px;    /* --semi-border-radius-medium  —— 应用栏玻璃条、侧边栏项、输入框、下拉 */
  --fn-radius-name: 8px;    /* 按钮、右键菜单、设置卡片 */
  --fn-radius-lg:   12px;   /* 弹窗、内容窗格、桌面图标单元格 */
  --fn-radius-app:  16px;   /* ★应用窗口、资源组件玻璃卡 */
  --fn-radius-login:32px;   /* 登录卡片（Tailwind rounded-[32px]） */
  --fn-radius-full: 9999px;

  /* ---- 阴影 ---- */
  --fn-shadow-window:   0px 15px 20px 0px rgba(11, 11, 12, 0.05),
                        8px 8px 16px -6px rgba(3, 3, 3, 0.08),
                        1px 12px 42px -4px rgba(10, 10, 10, 0.08);       /* ★--semi-shadow-app */
  --fn-shadow-elevated: 0px 10px 20px 0px rgba(0, 0, 0, 0.08),
                        0px 10px 40px 0px rgba(0, 0, 0, 0.12);           /* ★--semi-shadow-elevated 弹窗 */
  --fn-shadow-dropdown: 0px 12px 42px -4px rgba(20, 23, 26, 0.12),
                        0px 8px 18px -6px rgba(20, 23, 26, 0.20);        /* ★右键菜单/下拉 */
  --fn-shadow-2:        0px 2px 4px 0px rgba(0, 0, 0, 0.14),
                        0px 0px 1px 0px rgba(0, 0, 0, 0.16);
  --fn-shadow-knob:     0px 4px 6px 0px rgba(0, 0, 0, 0.10),
                        0px 0px 1px 0px rgba(0, 0, 0, 0.30);
  --fn-shadow-text:     0px 0px 4px 0px rgba(0, 0, 0, 0.50),
                        0px 1px 6px 0px rgba(0, 0, 0, 0.20);             /* 壁纸上的桌面图标文字 */

  /* ---- 间距阶梯（fnOS 自定义 Tailwind 刻度） ---- */
  --fn-space-super-tight: 2px;
  --fn-space-tight:       8px;
  --fn-space-base-tight:  12px;
  --fn-space-base:        16px;
  --fn-space-base-loose:  20px;
  --fn-space-loose:       24px;
  --fn-space-super-loose: 40px;

  /* ---- 动效 ---- */
  --fn-duration-fastest: 90ms;
  --fn-duration-faster:  120ms;
  --fn-duration-fast:    180ms;
  --fn-duration-normal:  600ms;
  --fn-ease-in:     cubic-bezier(0.4, 0, 1, 1);
  --fn-ease-out:    cubic-bezier(0, 0, 0.2, 1);
  --fn-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

  /* ---- 字体 ---- */
  --fn-font-zh-cn: "PingFang SC", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --fn-font-zh-tw: "SF Pro TC", "SF Pro Display", "PingFang TC", "Helvetica", "Arial", sans-serif;
  --fn-font-en:    "SF Pro Text", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
  --fn-font-ja-jp: "SF Pro JP", "SF Pro Text", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
  --fn-font-ko-kr: "SF Pro KR", "SF Pro Display", "Apple Gothic", "HY Gulim", "Lexi Gulim", "Helvetica", "Arial", sans-serif;
  --fn-font-es-es: "SF Pro Display", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
  --fn-font-fr-fr: "SF Pro Display", "Helvetica Neue", "Helvetica", "Arial", sans-serif;
  --fn-font: var(--fn-font-zh-cn);  /* 按 lang 切换 */
}

/* ============================================================
   fnOS 设计令牌 —— DARK
   触发：<body theme-mode="dark">（fnOS 原样）
   换皮时若不想用 body 属性，可改成 :root[data-fn-theme="dark"]
   ============================================================ */
body[theme-mode="dark"] {
  /* 品牌：色阶方向反转，primary 仍取 #0066FF */
  --fn-brand-0: #002570;
  --fn-brand-1: #003494;
  --fn-brand-2: #0043B8;
  --fn-brand-3: #0054DB;
  --fn-brand-4: #0066FF;
  --fn-brand-5: #3388FF;
  --fn-brand-6: #66A8FF;
  --fn-brand-7: #99C7FF;
  --fn-brand-8: #CCE4FF;
  --fn-brand-9: #EBF4FF;

  --fn-primary:          #0066FF;
  --fn-primary-hover:    #0054DB;
  --fn-primary-active:   #0043B8;
  --fn-primary-disabled: rgba(51, 136, 255, 0.16);
  --fn-primary-tint-12:  rgba(0, 102, 255, 0.10);
  --fn-primary-tint-20:  rgba(0, 102, 255, 0.20);
  --fn-primary-tint-30:  rgba(0, 102, 255, 0.30);

  /* 背景分层：bg-0 最深，bg-4 最亮 */
  --fn-bg-0:        #0C0C0D;
  --fn-bg-1:        #1F2021;
  --fn-bg-2:        #1F2021;
  --fn-bg-3:        #2E2F30;
  --fn-bg-4:        #414245;
  --fn-window-base: #0C0C0D;   /* --semi-color-app */
  --fn-pane-bg:     #1F2021;   /* --semi-color-app-container */
  --fn-nav-bg:      #2E2F30;
  --fn-menu-bg:     #2E2F30;
  --fn-glass-card:  rgba(12, 13, 13, 0.60);
  --fn-glass-bg:    rgba(0, 0, 0, 0.60);
  --fn-rail-bg:     rgba(12, 13, 13, 0.60);
  --fn-rail-border: rgba(255, 255, 255, 0.05);
  --fn-avatar-bg:   rgba(255, 255, 255, 0.06);
  --fn-bg-transparent: rgba(12, 12, 13, 0);
  --fn-bg-anti:     #FFFFFF;

  --fn-fill-0: rgba(255, 255, 255, 0.04);
  --fn-fill-1: rgba(255, 255, 255, 0.06);
  --fn-fill-2: rgba(255, 255, 255, 0.12);
  --fn-fill-3: rgba(255, 255, 255, 0.20);

  --fn-text-0: #FFFFFF;
  --fn-text-1: rgba(242, 243, 244, 0.80);
  --fn-text-2: rgba(242, 243, 244, 0.60);
  --fn-text-3: rgba(242, 243, 244, 0.35);
  --fn-text-anti: #0C0C0D;

  --fn-border:        rgba(255, 255, 255, 0.16);
  --fn-border-hover:  rgba(255, 255, 255, 0.20);
  --fn-border-active: rgba(255, 255, 255, 0.24);
  --fn-border-modal:  rgba(255, 255, 255, 0.12);
  --fn-border-select: rgba(255, 255, 255, 0.12);
  --fn-divider-0:     rgba(255, 255, 255, 0.16);
  --fn-divider-1:     rgba(255, 255, 255, 0.10);
  --fn-divider-2:     rgba(255, 255, 255, 0.08);
  --fn-card-border:   rgba(255, 255, 255, 0.08);

  --fn-link:           #0066FF;
  --fn-link-hover:     #0054DB;
  --fn-link-active:    #0043B8;
  --fn-danger:         #DB382C;   /* dark 取 red-4 */
  --fn-danger-hover:   #BA312C;
  --fn-danger-active:  #971F1F;
  --fn-success:        #009E61;   /* dark 取 green-4 */
  --fn-success-hover:  #098658;
  --fn-success-active: #076B48;
  --fn-warning:        #E06C00;   /* dark 取 amber-4 */
  --fn-warning-hover:  #BF5809;
  --fn-warning-active: #9C3D03;
  --fn-info:           #0066FF;
  --fn-tertiary:       rgba(255, 255, 255, 0.08);
  --fn-secondary:      #31A8F3;
  --fn-default:        #0C0C0D;
  --fn-default-hover:  #1F2021;

  --fn-disabled-text:   rgba(255, 255, 255, 0.35);
  --fn-disabled-fill:   rgba(230, 230, 231, 0.04);
  --fn-disabled-bg:     #2E2F30;
  --fn-disabled-border: rgba(255, 255, 255, 0.16);

  --fn-overlay:      rgba(0, 0, 0, 0.60);
  --fn-overlay-anti: rgba(0, 0, 0, 0.60);

  --fn-scrollbar:       rgba(255, 255, 255, 0.12);
  --fn-scrollbar-hover: rgba(255, 255, 255, 0.20);

  --fn-input-bg:          #1F2021;
  --fn-input-bg-hover:    #1F2021;
  --fn-input-bg-active:   #0C0C0D;
  --fn-input-bg-disabled: #2E2F30;

  --fn-progress-track: rgba(255, 255, 255, 0.12);

  /* 阴影：只换 --semi-color-shadow 那一层（其余两段是固定黑） */
  --fn-shadow-window: 0px 15px 20px 0px rgba(12, 12, 13, 0.80),
                      8px 8px 16px -6px rgba(3, 3, 3, 0.08),
                      1px 12px 42px -4px rgba(10, 10, 10, 0.08);
  /* --fn-shadow-elevated / --fn-shadow-dropdown 在深浅两色下数值完全相同 */
}
```

### 1.4 令牌映射表（fnOS 原名 → 建议项目名）

| fnOS / Semi 变量 | 建议项目变量 | light | dark |
|---|---|---|---|
| `--semi-color-primary` | `--fn-primary` | `#0066FF` | `#0066FF` |
| `--semi-color-primary-hover` | `--fn-primary-hover` | `#005EEB` | `#0054DB` |
| `--semi-color-primary-active` | `--fn-primary-active` | `#0043B8` | `#0043B8` |
| `--semi-color-primary-light-default` | `--fn-primary-tint-12` | `rgba(0,102,255,.12)` | `rgba(0,102,255,.10)` |
| `--semi-color-bg-0` | `--fn-bg-0` | `#F3F3F3` | `#0C0C0D` |
| `--semi-color-bg-1` | `--fn-bg-1` | `#FFFFFF` | `#1F2021` |
| `--semi-color-bg-2` | `--fn-bg-2` | `#FFFFFF` | `#1F2021` |
| `--semi-color-bg-3` | `--fn-bg-3` | `#FFFFFF` | `#2E2F30` |
| `--semi-color-bg-4` | `--fn-bg-4` | `#FFFFFF` | `#414245` |
| `--semi-color-app` | `--fn-window-base` | `#F3F3F3` | `#0C0C0D` |
| `--semi-color-app-container` | `--fn-pane-bg` | `#FFFFFF` | `#1F2021` |
| `--semi-color-bg-dropdown` | `--fn-menu-bg` | `#FFFFFF` | `#2E2F30` |
| `--semi-color-Component-card` | `--fn-glass-card` | `rgba(255,255,255,.90)` | `rgba(12,13,13,.60)` |
| `--semi-color-fndesktop-navbarBg` | `--fn-rail-bg` | `rgba(134,164,179,.05)` | `rgba(12,13,13,.60)` |
| `--semi-color-fndesktop-navbarBorder` | `--fn-rail-border` | `rgba(255,255,255,.20)` | `rgba(255,255,255,.05)` |
| `--semi-color-text-0..3` | `--fn-text-0..3` | 见 §1.3 | 见 §1.3 |
| `--semi-color-fill-0..3` | `--fn-fill-0..3` | 见 §1.3 | 见 §1.3 |
| `--semi-color-border` | `--fn-border` | `rgba(11,11,12,.16)` | `rgba(255,255,255,.16)` |
| `--semi-color-border-modal` | `--fn-border-modal` | `rgba(11,11,12,.06)` | `rgba(255,255,255,.12)` |
| `--semi-color-danger` | `--fn-danger` | `#DB382C` | `#DB382C` |
| `--semi-color-success` | `--fn-success` | `#009E61` | `#009E61` |
| `--semi-color-warning` | `--fn-warning` | `#E06C00` | `#E06C00` |
| `--semi-color-Scrollbar` | `--fn-scrollbar` | `rgba(90,91,92,.16)` | `rgba(255,255,255,.12)` |
| `--semi-shadow-app` | `--fn-shadow-window` | 见 §1.3 | 见 §1.3 |
| `--semi-shadow-elevated` | `--fn-shadow-elevated` | `0 10px 20px rgba(0,0,0,.08), 0 10px 40px rgba(0,0,0,.12)` | **同左** |
| `--semi-shadow-dropdown` | `--fn-shadow-dropdown` | `0 12px 42px -4px rgba(20,23,26,.12), 0 8px 18px -6px rgba(20,23,26,.20)` | **同左** |

### 1.5 字体

**族**（CSS 里 `--font-family-regular-<locale>`，`--font-family-regular` 按语言覆盖）：

```css
/* zh-CN —— 实测生效值 */
font-family: "PingFang SC", "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
```

其他语言族见 §1.3 的 `--fn-font-*`。切换方式：`document.documentElement.setAttribute('lang', locale)`（`?locale=zh_CN` 会转成 `zh-CN`）。

**实测字号 / 字重 / 行高对照表**（全部为 `getComputedStyle` 值）：

| 用途 | 中文示例 | font-size | line-height | weight | color |
|---|---|---|---|---|---|
| **桌面图标标签** | `文件管理` | 14px | 18px | **700** | `#FFFFFF`（固字面白，不随主题） |
| **窗口标题栏标题** | `文件管理` / `应用中心` | 14px | 20px | **600** | `--fn-text-0` |
| 窗口标题（新手引导特殊态） | `欢迎来到 fnOS` | 18px | 24px | 600 | `--fn-text-0` |
| **应用侧边栏项**（未选中） | `用户管理` | 14px | 20px | **500** | `--fn-text-1` |
| **应用侧边栏项**（选中） | `设备信息` | 14px | 20px | 500 | `--fn-primary` `#0066FF` |
| 侧边栏底部分组项 | `设置` | 14px | 22px | 500 | `--fn-text-1` |
| **区块标题（卡片内）** | `系统安装空间`、`硬件信息` | 14px | 22px | **700** | `--fn-text-1` |
| 卡片小标题 | `CPU` | 12px | 20px | **600** | `--fn-text-0` |
| **主数值** | `isle-fnos` | 20px | 28px | 500 | `--fn-text-0` |
| 正文 / 二级值 | `fnOS 1.2.0701`、`192.168.3.127` | 16px | 24px | 400 | `--fn-text-0` |
| **次要/小字** | `设备名称`、`已用`、`未创建存储空间`前的说明 | 12px | 16px（部分 12px） | 400 | `--fn-text-2` |
| 大号正文 | `未创建存储空间` | 16px | 24px | 400 | `--fn-text-0` |
| 文字链接 | `去创建` | 14px | 22px | 400 | `--fn-primary` |
| **窗口按钮** | — | — | — | — | 图标 16×16，color `--fn-text-0` |
| 模态标题 | `手动安装` | 18px | 24px | 600 | `--fn-text-0` |
| 右键菜单项文字 | `从桌面移除` | 14px | 20px | 400 | `--fn-text-0` |
| Tooltip 文字 | `全部应用` | 14px | 20px | 400 | `--fn-bg-0`（反色） |
| 资源组件数值 | `0` / `B/s` | **10px** | 10px | 500 | `--fn-text-0` |
| 资源组件标签 | `CPU` / `RAM` | **10px** | 10px | 500 | `--fn-text-1` |
| 资源组件 R/W 字母 | `R` / `W` | **9px** | 8px | 600 | `--fn-primary` / `--fn-success` |
| 登录页标题（设备名） | `isle-fnos` | 18px | 26px | 400 | `#FFFFFF` |
| 登录页按钮 | `登录` | 18px | 24px | 600 | `rgba(255,255,255,.4)`（禁用态实测） |
| 登录页链接 | `忘记密码？` | 14px | 22px | 400 | `rgba(255,255,255,.8)` |

> **未测得**：文件列表「行」的排版 —— 因为 VM 无存储空间，文件管理只能渲染空状态。若需要，参考 §5.7 的 Semi 表格规则（表头 `8px 16px`、`--fn-text-2`、600 字重、下边线 `--fn-divider-1`）。

### 1.6 圆角 / 阴影 / 间距 / 图标尺寸

**圆角实测样例**：

| 元素 | 圆角 |
|---|---|
| 应用窗口 `trim-ui__app-layout--window` | **16px** |
| 新手引导窗口（显式 `!rounded-[12px]`） | 12px |
| 桌面图标单元格 | 12px |
| 内容窗格 `--semi-color-app-container` 容器 | 12px |
| 桌面资源组件玻璃卡 | 16px |
| 模态 `semi-modal-content` | 12px |
| 按钮（默认/大/小） | 8px（登录页主按钮被覆写成 **10px**） |
| 输入框 / 下拉 `semi-input-wrapper` / `semi-select` | 6px（登录页被覆写成 **10px**） |
| 应用栏玻璃条 `rounded-md` | 6px |
| 侧边栏项 `rounded-md` | 6px |
| 设置卡片 `rounded-[8px]` | 8px |
| 右键菜单 `rounded-lg` | 8px |
| 登录卡片 `rounded-[32px]` | 32px |
| 复选框圆角 | 3px（`--fn-radius-xs`） |
| 开关 `semi-switch` / 进度条 | 12px / 3px |

**阴影**：见 §1.3 的 `--fn-shadow-*`。窗口实测 `box-shadow` 计算值为
`rgba(0,0,0,0) 0 0 0 0, rgba(0,0,0,0) 0 0 0 0, rgba(11,11,12,.05) 0 15px 20px 0, rgba(3,3,3,.08) 8px 8px 16px -6px, rgba(10,10,10,.08) 1px 12px 42px -4px`
（前两段是 Tailwind `ring` 占位）。

**间距阶梯**（fnOS 用自定义 Tailwind 刻度，实测 `.gap-*` / `.p-*` 工具类）：

| 名称 | 值 | 典型用途 |
|---|---|---|
| `super-tight` | 2px | 资源组件两行间距 `gap-y-0.5` |
| `tight` | 8px | 侧边栏项内图标与文字 `gap-tight` |
| `base-tight` | 12px | |
| `base` | 16px | 设置卡片 `p-4` |
| `base-loose` | 20px | 桌面图标网格上边距 `py-base-loose` |
| `loose` | 24px | 标题行高 `h-loose` / `size-loose`（24×24 图标） |
| `super-loose` | 40px | |

**图标尺寸**：

| 位置 | 尺寸 |
|---|---|
| 桌面图标 | **52 × 52** |
| 应用栏 rail 图标图片 | **36 × 36** 盒子 + `padding:15%` → 实际渲染 **25.2 × 25.2**，`border-radius:10%` |
| 窗口标题栏应用图标 | **24 × 24** |
| 窗口按钮图标 | **16 × 16** |
| 侧边栏项图标 | 16 × 16 |
| 资源组件主图标 | 16 × 16（容器 22×22，`p-[3px]`，`rounded-[7px]`） |
| 资源组件 chevron | 16 × 16（点击热区 24 × 24） |
| 模态关闭按钮图标 | 16 × 16（按钮 26.8 × 28） |
| 工具栏/搜索图标 | 16 × 16 |
| 登录页 logo | **80 × 62**（`w-[60px] sm:w-auto`，SVG） |

### 1.7 OS 状态色（右上角资源组件实测）

| 指标 | 标签色 | 数值色 | 说明 |
|---|---|---|---|
| 上传 `R` | `--fn-primary` `#0066FF` | `--fn-text-0` | 9px/600 字母；数值 10px/500 |
| 下载 `W` | **`--fn-success` `#009E61`** | `--fn-text-0` | 9px/600 |
| 网卡速率 | 图标 `--fn-text-0` | `--fn-text-0` | 图标 9×9 |
| `CPU` | `--fn-text-1` | `--fn-text-0` | 标签 10px/500 |
| `RAM` | `--fn-text-1` | `--fn-text-0` | 标签 10px/500 |

实测样例文本（截图 `20261011-fnos-desktop-light-1600x1000.png`）：`R 0 B/s ↑ · W 0 B/s ↓ · 328 B/s ↓ · CPU 0 % · RAM 27 %`。

---

## 2. 桌面外壳结构

所有数值为 1600×1000 视口下的 `getBoundingClientRect`。

### 2.1 整体分层

```
body                        1600×1000
└─ div (relative flex)      1600×1000
   ├─ 壁纸层  absolute inset-0 z-0          1600×1000
   │   └─ <img class="semi-image-img size-full object-cover">
   ├─ 左侧应用栏  fixed inset-y-0 left-0 z-[1]   66 × 1000
   └─ 桌面区  div.desktop
       ├─ 桌面图标网格  pl-[66px]
       ├─ 应用窗口（多个，绝对定位）
       └─ 右上资源组件  absolute right-[14px] top-[17px] z-[1]
```

- 页面兜底背景（壁纸未加载时）：`linear-gradient(110deg, #4A5568 0.26%, #3A424F 97.78%)`（来自 `index.html` 内联 `<style>`）。
- 壁纸：`url("/static/bg/wallpaper-1.webp")`，`background-size: cover`，`background-position: 50% 50%`；DOM 里以 `<img>` + `object-cover` 呈现。主题切换**不改变壁纸**。

### 2.2 左侧应用栏（App Rail）

| 项 | 值 |
|---|---|
| 外层容器 | `position:fixed; inset-block:0; left:0; z-index:1;` 宽 **66px** |
| 容器内边距 | `padding: 16px 0 16px 14px`（`py-4 pl-3.5`） |
| **玻璃条** | **52 × 970**（高 = 视口 − 30），位于 `[14, 16]` |
| 玻璃条背景 | `--fn-rail-bg`：light `rgba(134,164,179,.05)` / dark `rgba(12,13,13,.60)` |
| 玻璃条描边 | `1px solid rgba(255,255,255,.20)`（**两种主题下 CSS 类名写死**，dark 下 `--semi-color-fndesktop-navbarBorder` 为 `.05`，但该元素用的是 Tailwind 字面量 `.20`） |
| 玻璃条圆角 | **6px** |
| 毛玻璃 | `backdrop-filter: blur(20px)` |
| 内层 | `padding: 12px 0`（`py-3`），宽 50px |
| **是否显示文字标签** | **不显示**。图标项仅图标，文字通过 **Tooltip** 呈现（实测：hover 第二项 → tooltip 文本 `全部应用`，尺寸 80×36，`padding:8px 12px`，圆角 `--fn-radius-md`=6px，底 `rgba(107,107,107,1)`=`grey-7`，文字色 `--fn-bg-0`） |

**三段式结构**：

1. **顶部分组** `[15, 29, 50, 88]`，`padding-bottom: 7px`，底部 `1px` 分隔线 `rgba(255,255,255,.20)`；含 2 项：
   - 第 1 项 `[15, 29, 50, 40]`，图标 `桌面`（`/assets/desktop-Cid_qXcw.png`）
   - 第 2 项 `[15, 69, 50, 40]`，图标 `全部应用`（`/assets/launchpad-BWEG1AYV.png`）→ 打开**启动台**
2. **中部滚动列表** `[15, 117, 50, 708]`，`overflow-y:auto`、`padding-top:8px`、`gap:8px`，`scrollbar-hidden`；每项 **50 × 40**，首项位于 `[15, 125]`
3. **底部分组** `[15, 825, 50, 148]`，`padding-top:8px`、`gap:20px`；4 项各 **36 × 20**，位于 y = 833 / 873 / 913 / 953：
   - ① 折线图图标 → 资源管理　② 铃铛（带 `.semi-badge`）→ 通知/日志　③ 人像 → **用户菜单**　④ 齿轮 → 设置

**单项结构与状态**：

```
容器 div            h-10 w-[47px]  border-left:3px solid transparent  hover:bg-white-10
  └ 内层 div        h-9 (36px)     px-[3px] py-2px
      └ 图标盒 div  size-[80px] p-[15%] 但 !h-[36px] !w-[36px]
          └ img     w/h 25.2px  border-radius:10%
```

- **hover**：`background: rgba(255,255,255,.10)`（Tailwind `hover:bg-white-10` → `--semi-color-white-10`），无圆角（沿用容器圆角 0，视觉上是整条 47px 宽的浅色块）。
- **active/选中**（实测「新手引导」项同时被选中）：
  `bg-white-10` + `border-left-color: var(--semi-color-focus-border)` = **`#0066FF` 3px 左侧竖条**。
  类名证据：`... hover:bg-white-10 bg-white-10 !border-focus-border`。
- **图标颜色**：全部是位图/SVG 资源，无 CSS 着色；深浅主题共用同一批图标。

### 2.3 桌面图标网格

| 项 | 值 |
|---|---|
| 容器 | `box-sizing:border-box; display:flex; flex-direction:column; flex-wrap:wrap; place-content:flex-start; align-items:flex-start;` |
| 容器起止 | `left: 66px`（`pl-[66px]`），宽 1534px，`padding: 20px 0`（`py-base-loose`） |
| **单元格** | **144 × 120 px**，`border-radius:12px`，`padding-top:22px`，`gap:10px`（图标与标签之间） |
| 排列 | **按列优先填充**（`flex-col` + `flex-wrap`）：1600×1000 时每列 8 个，第 9 个换到第 2 列。实测第 1 列单元格 x=66，第 2 列 x=210（间隔 144，**无额外列间距**）；行 y = 20 / 140 / 260 / 380 / 500 / 620 / 740 / 860 |
| 图标 | **52 × 52**，`transition: all 150ms`；外层 `inline-flex flex-col items-center gap-[10px]`，`cursor:pointer` |
| **标签** | `font-size:14px; font-weight:700; line-height:18px; color:#FFFFFF;`（**固定白色**，不随主题）`text-align:center;` `max-width:128px;` `line-clamp:2`（`-webkit-line-clamp` 两行截断） |
| 单元格 hover | 单元格本身无背景（`cursor-default`）；hover 时标签/图标无实测变化。**未测得** hover 底色 |
| 选中 | **未测得**（合成事件下未触发） |
| 右键菜单 | 见 §5.9 |

实测 9 个默认桌面图标（顺序即列填充顺序）：`文件管理`、`系统设置`、`应用中心`、`下载`、`Docker`、`备份`、`资源管理`、`日志`、`回收站`。

### 2.4 右上角资源组件（Resource Widget）

| 项 | 值 |
|---|---|
| 外层 | `position:absolute; right:14px; top:17px; z-index:1; overflow:hidden; border-radius:16px;` → **334 × 54**（位于 `[1252, 17]`） |
| **玻璃胶囊** | **266 × 36**（位于 `[1314, 23]`），`border-radius:16px`，`padding:4px 12px`（`px-3 py-1`），`transition: all 200ms` |
| 胶囊底 | `--semi-color-Component-card`：light `rgba(255,255,255,.90)` / dark `rgba(12,13,13,.60)`，`backdrop-filter: blur(50px)` |
| 无边框 | 实测 `border: 0` |
| 内容行 | `position:absolute; left:12px; top:8px;` → **218 × 22**，`display:flex; gap:8px`，`backdrop-filter:blur()` |
| 分组 1（读/写） | 宽 **70px**，两行各 10px 高，`row-gap:2px`。<br>`R` 9px/600 `#0066FF` + 数值 10px/500 `--fn-text-0`（右对齐，宽 35px）+ 单位 `B/s` 10px/500（`min-width:23px`，右对齐）<br>`W` 同上，字母色 `--fn-success` `#009E61` |
| 分组 2（网卡） | 宽 **70px**，两行：SVG 9×9 + 数值 35px + 单位 `min-width:23px` |
| 分组 3（CPU/RAM） | 宽 **62px**，两行：标签 23px 居中（`CPU`/`RAM`，`--fn-text-1`）+ 数值 37px 居中（`--fn-text-0`） |
| 左侧主图标 | 22 × 22 位于 `[1326, 30]`，`border-radius:7px`，`padding:3px`，内含 16×16 SVG；**仅在收起态显示**（与内容行同位叠放，靠状态切换） |
| **折叠 chevron** | **24 × 24** 位于 `[1544, 29]`，`padding:4px`，`gap:10px`，`cursor:pointer`，内含 16×16 箭头 SVG；色 `--fn-text-0` |
| 收起行为 | 实测 DOM 同时存在「图标态」与「展开态」两套节点（`>0>2` 为 22×22 图标、`>1` 为 218×22 数值行）。点击 chevron 收起时展示 22×22 主图标，展开时展示数值。**未测得**折叠动画时长 |

### 2.5 壁纸区

- 全屏 `<img>`，`object-fit: cover`，尺寸 = 视口，`z-index: 0`。
- 内置 4 张静态壁纸（`我的账号 → 主题壁纸`）：第 1 张为当前彩色流动波浪图（`/static/bg/wallpaper-1.webp`）。
- 壁纸类型：`静态`（JPG/PNG/WEBP，≤30MB，可选文件）/ `动态` / `纯色`；排列：`填充屏幕` / `拉伸以充满屏幕` / `自适应屏幕`。
- 桌面图标文字在壁纸上使用 `text-shadow: 0 0 4px rgba(0,0,0,.5), 0 1px 6px rgba(0,0,0,.2)`（`--fn-shadow-text`，**CSS 推导**：标签类未显式设置该值，但 token 存在）。

### 2.6 Dock / 任务栏

**不存在 dock、也没有底部任务栏、没有顶部菜单栏。** 唯一常驻外壳是 §2.2 的左侧 66px 应用栏 + §2.4 的右上资源组件。应用窗口的最小化行为表现为「最小化到桌面外」（关闭后不在任何栏位留图标）—— 实测关闭再打开是重新实例化，**未测得**是否有最小化列表。

### 2.7 启动台（点击 rail「全部应用」）

- 全屏覆盖层，铺满视口，**壁纸被强模糊 + 压暗**（视觉上是深色磨砂底），rail 仍然可见且「全部应用」项呈选中态（左侧蓝色竖条）。
- 顶部居中 **搜索框**：`placeholder="搜索"`，圆角胶囊，宽约 380px（实测 `[646, 71, 380, 44]` 附近，**未逐像素测得**），带 `搜索` 放大镜图标。
- **图标网格**：6 列，图标 **约 56 × 56**，标签在图标下方居中（白色，样式同桌面图标标签）。实测排列：
  - 第 1 行：`文件管理`、`系统设置`、`应用中心`、`下载`、`Docker`、`备份`
  - 第 2 行：`资源管理`、`日志`、`回收站`
- 交互：`Esc` 关闭（实测有效）；再次点击 rail「全部应用」图标亦可关闭。
- 参考截图：`20261011-fnos-launchpad-light-1600x1000.png`。

---

## 3. 应用窗口 Chrome

### 3.1 窗口容器

```
div.trim-ui__app-layout--window.is-resizable
```

| 项 | 值 |
|---|---|
| 默认尺寸 | **1100 × 640 px**（`width: var(--app-window-default-width, 1100px); height: var(--app-window-default-height, 640px)`） |
| 定位 | `position:absolute`，`z-index: 10011`（实测） |
| 圆角 | **16px**（`--semi-border-radius-custom-app`）；新手引导窗口显式覆写为 12px |
| 描边 | **`outline: 1px solid var(--semi-color-border-modal)`**（不是 `border`！light `rgba(11,11,12,.06)` / dark `rgba(255,255,255,.12)`），`outline-offset: 0` |
| 阴影 | `box-shadow: 0 0 #0000, 0 0 #0000, var(--fn-shadow-window)` |
| 溢出 | `overflow: hidden` |
| 拖拽 | 标题栏 `cursor:move`；`.is-dragging` / `.is-resizing` 时 `will-change: top,left,width,height` |
| 缩放手柄 | 8 个 `div.resizable-handler`（`t/rt/r/rb/b/lb/l/lt`），各 **4 × 4 或 4 × 长**，非可缩放窗口带 `disable-resize` |
| 窗口背景层 | 子元素 `div.trim-ui__app-layout--background`，`absolute inset-0; z-index:-1; background: var(--semi-color-app)`（light `#F3F3F3` / dark `#0C0C0D`） |

实测位置示例（1600×1000，窗口居中）：文件管理 `[223, 176.5, 1100, 640]`；系统设置 `[287, 176, 1100, 640]`（居中偏移不同，属窗口管理器的层叠算法，非固定值）。

### 3.2 标题栏

```
div.trim-ui__app-layout--header   (h-[44px] cursor-move bg-app-header)
├─ div.trim-ui__app-layout--header-title   (pl-4 pr-9 text-[14px] font-[400])
│   └─ div.flex.h-loose.w-full.items-center
│       ├─ <img class="pointer-events-none mr-2 block size-loose select-none">  24×24
│       └─ <span class="max-w-full truncate font-[600] leading-5 text-[var(--semi-color-text-0)]">标题</span>
└─ div.flex.items-center    (右侧按钮组)
    ├─ div.app-layout-header-minimize   46×44
    ├─ div.app-layout-header-maximize   46×44
    └─ div.app-layout-header-close      46×44
```

| 项 | 值 |
|---|---|
| 高度 | **44 px** |
| 背景 | `var(--semi-color-app-header)` = `rgba(243,243,243,0)`（light）/ `rgba(12,12,13,0)`（dark）→ **完全透明，露出窗口底板的 `#F3F3F3`** |
| 内边距 | 标题区 `padding-left:16px; padding-right:36px`（`pl-4 pr-9`） |
| 应用图标 | **24 × 24**，`margin-right:8px`（`mr-2`），`pointer-events:none` |
| **标题排版** | `font-size: 14px; font-weight: 600; line-height: 20px; color: var(--fn-text-0);` `max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap` |
| 标题垂直居中 | 图标与标题在 44px 高的 flex 行内居中（实测图标 y=186.5，标题 y=188.5） |
| 窗口按钮容器 | 位于右侧，三个按钮无间隙紧贴（x = 1185 / 1231 / 1277，宽 46） |

**三个窗口按钮（实测，从左到右：最小化 / 最大化 / 关闭）**：

| 按钮 | 尺寸 | 图标 | 默认色 | hover |
|---|---|---|---|---|
| 最小化 `.app-layout-header-minimize` | **46 × 44** | 16×16 横线 | `--fn-text-0` | `background: var(--semi-color-fill-0)`（light `rgba(11,11,12,.04)` / dark `rgba(255,255,255,.04)`） |
| 最大化 `.app-layout-header-maximize` | **46 × 44** | 16×16 方框 | `--fn-text-0` | 同上；active 亦为 `fill-0` |
| 关闭 `.app-layout-header-close` | **46 × 44** | 16×16 叉 | `--fn-text-0` | **`background: var(--semi-color-danger)` `#DB382C`，`color: #FFFFFF`** |

类名原文（含 hover 规则）：
```
flex h-full w-base shrink-0 cursor-pointer items-center px-[15px]
  text-[var(--semi-color-text-0)] hover:bg-[var(--semi-color-fill-0)] active:bg-[var(--semi-color-fill-0)]
  ... app-layout-header-close hover:!bg-[var(--semi-color-danger)] hover:!text-white active:!bg-[var(--semi-color-danger)]
```
> 按钮为 `div` 而非 `button`，`padding: 0 15px`，图标 16×16 居中 → 46 = 16 + 15×2。
> 关闭按钮无圆角（整块 46×44 矩形），不需要额外的红色圆形。

### 3.3 焦点 / 非焦点窗口差异

**未测得**：本次会话**未能在真实 UI 中同时打开两个应用窗口**（用合成事件打开第二个窗口时，前一个被复用/替换）。CSS 里没有针对非焦点窗口的透明化或降级规则（无 `.is-blur` / `.inactive` 类）。因此：
- 请按「**焦点窗口描边 = `--fn-border-modal`，非焦点窗口 = `--fn-border-modal` 不变**」实现（保守做法）；
- 若必须区分，建议非焦点窗口把 `outline-color` 降到 `transparent`、阴影缩小一档 —— 但这是设计决策，**不是从 fnOS 实测得到的**。

### 3.4 内部布局（窗口体）

```
div.trim-ui__app-layout--body-active   height: calc(100% - 44px)
└─ 应用自有容器（如 base-Tabs-root base-Tabs-vertical flex size-full flex-row）
   ├─ 左侧边栏   base-TabsList-root   width: 220px，padding: 0 8px 8px
   └─ 内容窗格   bg-[var(--semi-color-app-container)]  圆角 12px，overflow:hidden
```

| 项 | 值 |
|---|---|
| 窗口体高度 | `calc(100% - 44px)`（1100×640 窗口 → 596px） |
| **左侧边栏宽度** | **220 px** |
| 侧边栏背景 | 透明（露出窗口底板 `--fn-window-base` = `#F3F3F3` / `#0C0C0D`） |
| 侧边栏内边距 | `padding: 0 8px 8px` |
| **内容窗格背景** | `var(--semi-color-app-container)`：light `#FFFFFF` / dark `#1F2021`；**圆角 12px**；`overflow:hidden` |
| 内容窗格位置 | 系统设置实测 `[507, 220, 872, 588]`（窗口 `[287,176,1100,640]`） |

**侧边栏项（实测）**：

| 状态 | 尺寸 | 圆角 | 内边距 | 字号 | 字重 | 颜色 | 背景 |
|---|---|---|---|---|---|---|---|
| 未选中 | 204 × 36 | 6px | 8px | 14px / 20px | 500 | `--fn-text-1` | 透明 |
| **选中** | 204 × 36 | 6px | 8px | 14px / 20px | 500 | **`--fn-primary` `#0066FF`** | **`--fn-primary-tint-12` `rgba(0,102,255,.12)`** |
| hover | — | — | — | — | — | — | `--fn-fill-*`（CSS 推导，类名含 `hover:bg-[var(--semi-c...`） |
| 分组标题行（如文件管理的 `我的文件`/`团队文件`） | 204 × 37 | 6px | `0 0 0 8px` | 16px / 24px | 400 | `--fn-text-0` | **`var(--semi-color-app)` = `#F3F3F3`**（浅灰胶囊，`mb-px`） |
| 侧边栏底部项（`设置`） | 204 × 35 | — | `0 8px` | 14px / 22px | 500 | `--fn-text-1` | 透明 |

---

## 4. 逐屏参考

### 4.1 登录页（`/login`）

截图：`20261011-fnos-login-light-1600x1000.png`（1600×1000）、`login-light-2560x1440`（未入库，可按需再取）

**布局区域**
- 全屏壁纸（`/static/bg/wallpaper-1.webp`，`background-size:cover`，`background-position:50% 50%`）。
- 外层容器类名固定含 **`semi-always-light`** → **登录页恒为亮色主题**。
- 居中毛玻璃卡片：**440 × 492**（1600×1000 时位于 `[580, 254]`）。

**登录卡片实测**

| 项 | 值 |
|---|---|
| 尺寸 | 440 × 492（`w-[85%] max-w-[350px]`；`sm:w-[440px] sm:max-w-none`） |
| 内边距 | **60px 40px**（`sm:px-10 sm:py-[60px]`；小屏 `px-8 py-12`） |
| 圆角 | **32px** |
| 背景 | `rgba(255,255,255,.10)`（`bg-white-10`） |
| 毛玻璃 | `backdrop-filter: blur(20px)`（`backdrop-blur-[20px]`） |
| 文字色 | `#FFFFFF` |
| 类名还含 `gradient-border` | 实测该工具类在 CSS bundle 中**未生成规则**（`grep .gradient-border` 无结果），即**当前无渐变描边效果** |
| logo | **80 × 62**，白色飞牛牛头 SVG（`<img class="w-[60px] sm:w-auto">`） |
| 设备名标题 | `isle-fnos`，18px / 26px / 400，`#FFFFFF`，`margin: 20px 0 22px`，`min-height:26px` |
| 表单宽 | 360px，`semi-form semi-form-vertical` |
| **用户名输入** | 外框 **360 × 48**，`border-radius:10px`（覆写），`background:#FFFFFF`，`border:1px solid transparent`；内部 `<input name="username" placeholder="用户名">` 高 40px、`padding:0 16px`、`font-size:16px`、`line-height:40px`、文字色 `#202327` |
| **密码输入** | 外框 **360 × 48**，同上；`<input name="password" placeholder="密码">` 宽 316px（右侧 44px 是「显示/隐藏」眼睛按钮） |
| 字段间距 | 用户名 `padding: 0 0 10px`，密码 `padding: 10px 0 0` |
| **保持登录 复选行** | `[620, 527, 360, 22]`，`margin-top:10px`，`justify-content:space-between`；左侧复选框 16×20（`.semi-checkbox-inner`）+ 文字 `保持登录`（14px/20px/400/`#FFFFFF`）；右侧 `忘记密码？` 14px/22px/400/`rgba(255,255,255,.8)`，`cursor:pointer` |
| **登录按钮** | **360 × 54**，`margin-top:40px`，`border-radius:10px`，`background:#0066FF`，`font-size:18px`，`line-height:24px`，`font-weight:600`，`padding:14px 20px`。<br>未填表单时为 `.semi-button-disabled`：文字 `rgba(255,255,255,.4)`、底仍为 `#0066FF`（实测） |
| 文案 | `用户名` / `密码` / `保持登录` / `忘记密码？` / `登录` |

> **实现要点**：登录页的主按钮圆角是 **10px**，与系统其它按钮的 8px 不同；这是登录页 Tailwind 覆写的结果。

### 4.2 桌面（已登录默认态）

截图：`20261011-fnos-desktop-light-1600x1000.png`、`20261011-fnos-desktop-dark-1600x1000.png`、`20261011-fnos-desktop-light-2560x1440.png`、`20261011-fnos-desktop-welcome-light-1600x1000.png`

**布局区域 / 控件 / 文案**
- 壁纸（见 §2.5）。
- 左侧 66px 应用栏（§2.2），**仅图标、无文字**。
- 桌面图标网格 9 项（§2.3）：`文件管理`、`系统设置`、`应用中心`、`下载`、`Docker`、`备份`、`资源管理`、`日志`、`回收站`。
- 右上资源组件（§2.4）：`R` / `W` 速率、网卡速率、`CPU` `0 %`、`RAM` `27 %`、chevron。
- **首次进入自动弹出「欢迎来到 fnOS」引导窗口**（`20261011-fnos-desktop-welcome-light-1600x1000.png`）：
  - 窗口 342 × 502（`trim-os__beginner-guide--root`），位于 `[1246, 483]`，圆角 12px，`!border`（`outline` 1px `--fn-border-modal`），`shadow-[var(--semi-shadow-app)]`。
  - 标题栏 `!h-[60px]`（比常规 44px 高），标题 `欢迎来到 fnOS`，18px/24px/600。
  - 卡片列表（`rounded-xl bg-[var(--semi-color-bg-1)] p-3`，300 × 64）：
    `创建存储空间 / 用于存储文件和安装应用`、`安装飞牛相册 / 体验行业领先的AI相册`、`安装飞牛影视 / 打造私人影院和完美海报墙`（后两项带勾选复选框）、`请选择 ▾` + **`一键安装` 主按钮**、`FN Connect 远程访问 / 永久免费 随时随地访问飞牛 NAS`、`设置安全邮箱 / 忘记密码时可接收重置密码链接`。
  - 顶栏两个窗口按钮：最小化（36×36 `semi-button-tertiary semi-button-borderless mr-2`）+ 关闭（36×36 `mr-5`）。**该窗口只有最小化与关闭，无最大化。**
  - 未关闭时点击桌面图标仍可打开应用窗口（引导窗与普通窗口并存）。

**主题差异（dark）**：仅应用栏玻璃条与资源组件玻璃卡变深，壁纸、桌面图标、图标标签一律不变。

### 4.3 文件管理（文件管理 App）

截图：`20261011-fnos-filemgr-empty-light-1600x1000.png`、`20261011-fnos-filemgr-empty-dark-1600x1000.png`、`20261011-fnos-filemgr-settings-light-1600x1000.png`

**⚠️ 该 VM 未创建存储空间**，所以内容区固定显示空状态：
`使用文件管理应用前，请先创建存储空间` + 主按钮 `存储空间管理`。

**布局区域 / 控件 / 文案**

| 区域 | 内容与样式 |
|---|---|
| 窗口 | 1100 × 640（§3.1） |
| 标题栏 | 图标 = 蓝色文件夹，标题 `文件管理`；右侧 − / □ / ✕ |
| **左侧边栏（220px）** | 分组胶囊（浅灰 `#F3F3F3`，可展开 `▸`）：`我的文件`（展开态，子项高亮 `bg-white-10`）、`团队文件`、`外接存储`、`远程挂载`<br>普通项：`应用文件`、`他人共享`、`我的共享`、`外链管理`、`最近访问`、`我的收藏`、`回收站`、`管理员视角`<br>底部固定：`设置` |
| **工具栏** | 位于内容窗格顶部、高 28px 的一行（`flex gap-3`）：<br>· 后退 / 前进：两个 **28 × 28** 圆角方按钮（图标 16×16，默认禁用态浅灰）<br>· 刷新：28 × 28 圆形按钮<br>· **面包屑/路径框** `我的文件`：flex-1，高 28px，浅底圆角（`bg-fill-*`），左侧内边距使文字起始 x≈702<br>· **搜索框**：**固定 200 × 28**，位于 `[1095, 240.5]`，圆角胶囊，含放大镜图标 + `placeholder="搜索"` |
| **内容区** | 白底 `--fn-pane-bg`，圆角 12px |
| **空状态** | `div.trim-ui__empty--root.semi-empty.semi-empty-vertical`，实测 **252 × 232**，居中于内容区（`[753, 432.5]`）<br>· 插画：灰色立体「存储设备」插画，约 **110 × 90**<br>· 文案：`使用文件管理应用前，请先创建存储空间`，居中，`--fn-text-2`<br>· 主按钮：`存储空间管理`，`semi-button-primary`，高 36px，圆角 8px，`padding:0 16px`，`font-size:14px/20px/600`，底色 `#0066FF` 白字<br>· `.semi-empty-image` 后 `.semi-empty-content { margin-top: 24px }` |
| 侧边栏「设置」页 | 打开后窗口标题变为 **`文件管理设置`**，侧边栏换为：`文件共享协议`、`同名文件`、`外接存储权限`、`外链管理`、`远程挂载设置`、`应用访问权限`；内容区为顶部 Tab：`SMB`（选中）/ `WebDAV` / `FTP` / `NFS` / `删除文件偏好`<br>Tab 选中态：蓝色下划线（`--fn-primary`），文字 `--fn-text-0`；未选中 `--fn-text-2`<br>卡片区：`可见文件夹范围 ⓘ` → 5 张浅蓝卡片（`bg-primary-light-default` 圆角 8px）：`我的文件、他人共享 / 全部允许`、`团队文件 / 全部允许`、`外接存储 / 无`、`远程挂载 / 无`、`应用文件 / 无`<br>`连接方式` → `Mac`（`1. 访达 ❯❯ 2. 前往 ❯❯ 3. 连接服务器`，地址 `smb://192.168.3.127` + 复制图标）、`Windows`（`1. 文件 ❯❯ 2. 地址栏输入`，地址 `\\192.168.3.127` + 复制图标）<br>`其他连接方式` → `IP地址 192.168.3.127`、`端口 445`、`主机名 isle-fnos` |

> **未测得**：文件/文件夹列表行、图标视图、缩略图、右键「新建/重命名/删除」等菜单 —— 全部因无存储空间而不可达。

### 4.4 应用中心（应用中心 App）

截图：`20261011-fnos-appcenter-light-1600x1000.png`、`20261011-fnos-appcenter-dark-1600x1000.png`、`20261011-fnos-appcenter-manualinstall-light-1600x1000.png`

**布局区域 / 控件 / 文案**

| 区域 | 内容与样式 |
|---|---|
| 窗口 | 1100 × 640 |
| 标题栏 | 图标 = 蓝色 `STORE` 云商标志，标题 `应用中心` |
| **左侧边栏** | 顶部**搜索框**（`placeholder="搜索"`，通栏）；<br>`全部`（选中，`grid` 四宫格图标）、`最新发布`（时钟）、`已安装`（盒子）<br>分组标题 `分类`（12px 小字，`--fn-text-2`）<br>`影音娱乐`、`摄影录像`、`AI`、`下载`、`备份同步`、`开发工具`、`实用效率`、`生活`<br>底部固定：`设置`、**`手动安装`** |
| 内容区 | 顶部 **轮播横幅**（左右箭头按钮 + 圆点）；示例横幅文案 `飞牛素材库 Seek / 海量格式预览 团队协作 智能检索 审阅评论 安全分享交付`、右侧 `飞牛 × 百度网盘 / 极速下载 双端备份 / 100 MB/s`、`飞牛影视`、`AI 相册` |
| **分区标题** | `飞牛官方` + 计数徽标 `16`（小号圆角标签） |
| **应用卡片网格** | 每行 3 张，卡片：左侧 **40 × 40 圆角 App 图标** + 应用名（`影视` / `相册` / `素材库 Seek` / `音乐` / `飞牛 OpenClaw` / `文件快照`）+ 二级信息行（分类标签，如 `影音娱乐`、`生活｜摄影录像`）+ 右侧 **`安装` 按钮**（`semi-button`，浅蓝底 `bg-primary-light-default`，文字 `--fn-primary`，高 36px，圆角 8px） |
| 侧边栏 `设置` | **未测得**（未打开该页） |
| 侧边栏 `手动安装` | 弹出模态，见 §5.5 |

### 4.5 系统设置（系统设置 App）

截图：`20261011-fnos-settings-light-1600x1000.png`、`20261011-fnos-settings-dark-1600x1000.png`

**左侧边栏**（分组之间有空隙，分组内紧凑）：
`设备信息`（选中）/ `用户管理` ｜ `存储空间管理` / `硬盘信息` / `网络设置` / `远程访问` / `SSH` / `安全性` / `文件共享协议` ｜ `许可证` / `通知设置` / `硬件和电源` / `更新和还原` ｜ 底部 `应用`

**内容区（设备信息页）—— 卡片网格 `grid-cols-2 gap-2`，卡片高 140px**

| 卡片 | 内容 |
|---|---|
| `设备名称`（浅蓝底 `rgba(0,102,255,.12)`，圆角 8px，`p-4`） | 值 `isle-fnos`（20px/28px/500）+ 右侧设备缩略图；下方 `设备 ID` 12px 灰色 + `12d50cb433004fc2a6cce3b0a9f660d07abd895b`（等宽感小字） |
| `系统版本`（白底/`bg-card-HoverBg`） | 值 `fnOS 1.2.0701`（16px/24px）+ 右侧链接 `检查更新`（蓝色）；下方 `系统时间 2026-10-11 19:10:50`、`本次运行时间 0 天 1 时 9 分 28 秒` |
| `飞牛账号` | `****************`（UI 自身脱敏） |
| `FN Connect` | `未开启远程访问` |
| `系统安装空间` | 环形进度 **16.02%**（`semi-progress-circle-text` 16px）+ 图例 `已用 9.51 GB`、`总容量 59.39 GB`（标签 12px/12px/400 `--fn-text-2`）+ `硬盘类型 HDD` |
| **`存储空间`** | **`未创建存储空间`**（16px/24px/400 `--fn-text-0`）+ 文字链接 **`去创建`**（14px/22px/400 `--fn-primary`） |
| `硬件信息` | `CPU`（12px/20px/600）→ `Intel(R) Core(TM) Ultra 5 125H　2 核　2 线程`；`运行内存` → `1 条共 4 GB RAM` |
| `网络` | Tab `网口1`（选中，浅蓝底圆角）；行 `网口1` / `IPv4` / `IPv4地址 192.168.3.127` / `IPv6`，右侧一条蓝色的网络拓扑链路图（计算机 → 交换机 → 路由器 → 地球，节点圆点 `--fn-primary`） |

**卡片样式实测**：`padding:16px; border-radius:8px; box-sizing:border-box; height:140px; display:flex; flex-direction:column; justify-content:space-between;` 背景二选一：`bg-primary-light-default`（首列强调卡）或 `bg-card-HoverBg`。

### 4.6 我的账号 / 主题壁纸（用户菜单 → 个人设置）

截图：`20261011-fnos-account-theme-light-1600x1000.png`、`20261011-fnos-account-theme-dark-1600x1000.png`

- 窗口标题 `我的账号`；侧边栏：`账号`、`主题壁纸`（选中）、`登录设备管理`。
- **`账号`页**：顶部 872×190 的渐变横幅 + 圆形头像（蓝绿渐变，内含用户名首字母）+ 用户名 `isle` + `输入用户描述... ✎`；下方三行卡片：`密码 / 更新时间：2026年10月11日 08:00` + 按钮 `修改密码`；`双重验证 / 启用后登录账号需要增加第二步 OTP 验证，保障账号登录安全` + 按钮 `立即启用`；`安全邮箱 / 可通过安全邮箱操作密码重置和接收紧急验证码` + 按钮 `立即设置`。
- **`主题壁纸`页**：
  - `主题` 三个选项卡片：`跟随系统`、**`亮模式`**、`暗模式`（每张 172×110 预览图 + 单选圆点）。
    - 预览图：`跟随系统` = 左浅右深斜切；`亮模式` = 浅灰面板；`暗模式` = 深灰面板。
    - 选中：蓝色实心圆点 + 预览图描边；`亮模式` 预览图有蓝色 2px 描边。
  - `壁纸`：左侧当前壁纸缩略图；右侧 `类型` → `静态`（选中）/ `动态` / `纯色`；`排列` → `填充屏幕`（选中）/ `拉伸以充满屏幕` / `自适应屏幕`。
  - 文案 `静态JPG / PNG / WEBP格式，30M 以内`；4 张内置壁纸缩略图（选中项描蓝边 + 左上角蓝点）；按钮 `添加图片`。

### 4.7 用户菜单（rail 底部人像）

截图：`20261011-fnos-usermenu-light-1600x1000.png`

- 弹出面板实测 **240 × 235**，位于 `[75, 750]`（紧贴 rail 右侧、底部对齐）。
- 内容：圆形头像（字母 `i`，浅蓝底）+ `isle`（主文字）+ `管理员`（小字 `--fn-text-2`）；分隔线；`个人设置`（人像图标）；`退出登录`（登出图标）。
- 面板样式：`semi-popover`，圆角 12px（类名 `!rounded-xl`），`bg --fn-menu-bg`，阴影 `--fn-shadow-dropdown`。菜单项：`padding: 8px 16px`，hover `--fn-fill-0`。

### 4.8 其他可达界面

- **rail 底部 ① 折线图**：资源管理监控面板 —— **未测得**（本次未打开）。
- **rail 底部 ② 铃铛**：通知/日志面板（带 `.semi-badge`）—— **未测得**。
- **rail 底部 ④ 齿轮**：设置快捷入口 —— **未测得**（`系统设置` 已通过桌面图标覆盖）。
- **桌面图标 `下载` / `Docker` / `备份` / `资源管理` / `日志` / `回收站`**：**未测得**（打开会进入各 App；本次聚焦文件管理/应用中心/系统设置/我的账号四屏）。

---

## 5. 组件样式规则

> 数值来源：CSS bundle 中 `.semi-*` 规则 + 真实 DOM 实测。二者冲突时以**实测**为准（个别组件被 fnOS 覆写）。

### 5.1 按钮 `semi-button`

**基类**（`.semi-button`，实测于 CSS）：

```css
.semi-button{
  height:36px; padding:0 16px; border-radius:8px;
  font-family:var(--fn-font); font-size:14px; line-height:20px; font-weight:600;
  display:inline-flex; align-items:center; justify-content:center;
  border:0 solid transparent; cursor:pointer; user-select:none;
  white-space:nowrap; vertical-align:middle;
}
```

| 尺寸 | 高度 | 内边距 | 说明 |
|---|---|---|---|
| `semi-button-size-small` | **28px** | `0 12px` | 纯图标时 `28×28`，`padding:4px` |
| 默认 | **36px** | `0 16px` | |
| `semi-button-size-large` | **54px** | `14px 20px` | 登录页按钮覆写为 `height:54px / border-radius:10px / font-size:18px` |

| 类型 | 常态 | hover | active | disabled |
|---|---|---|---|---|
| **primary**（主按钮） | `background: var(--fn-primary) #0066FF; color:#FFF` | `--fn-primary-hover` `#005EEB`(light) / `#0054DB`(dark) | `--fn-primary-active` `#0043B8` | 通用规则：`.semi-button-disabled{ color: var(--fn-disabled-text); background-color: transparent; cursor: not-allowed }`；<br>但**登录页实测**（`.semi-button-disabled.semi-button-primary-disabled`）底仍为 `#0066FF`，仅文字变 `rgba(255,255,255,.4)` —— 即「半透明文字 + 保留主色底」 |
| **secondary** | `background: var(--fn-secondary) #008FF0`，白字 | `--semi-color-secondary-hover` `#0054E0`（light-blue-6） | `-active` | — |
| **tertiary** | `background: var(--semi-color-tertiary)`（light `#4B4B4B` / dark `rgba(255,255,255,.08)`），白字 | `--semi-color-tertiary-hover` | `-active` | — |
| **danger** | `background: var(--fn-danger) #DB382C`，白字 | `--fn-danger-hover` `#B7251F` | `--fn-danger-active` `#941515` | — |
| **borderless**（无底） | `color: var(--fn-text-1)`；危险/警告变体分别为 `--fn-danger` / `--fn-warning` | 背景 `--fn-fill-0` | — | 文字 `--fn-disabled-text`，底透明 |
| **outline**（描边） | `border:1px solid var(--fn-border)`；文字 `--fn-text-0` | — | — | 实测 `color: rgba(11,11,12,.25)`，`border:1px solid rgba(11,11,12,.16)`，`border-radius:8px`，`height:36px`，`padding:0 16px` |

**实测样例**（应用中心「手动安装」弹窗里的两个 outline 按钮）：`390 × 36`，`border-radius:8px`，`font:600 14px/20px`，`padding:0 16px`。

### 5.2 文本输入 / 搜索框 `semi-input`

```css
.semi-input-wrapper{
  display:inline-block; position:relative; box-sizing:border-box; width:100%;
  background-color:var(--fn-input-bg);           /* light #FFFFFF / dark #1F2021 */
  border:1px solid var(--fn-border);             /* rgba(11,11,12,.16) / rgba(255,255,255,.16) */
  border-radius:6px;                             /* 登录页覆写 10px */
  color:var(--fn-text-0); cursor:text;
  font-size:14px; line-height:20px;
}
.semi-input-wrapper:hover{
  background-color:var(--fn-input-bg-hover);
  border-color:var(--fn-border-hover);           /* rgba(11,11,12,.20) */
}
.semi-input-large{ height:40px; font-size:16px; line-height:40px; }
```

- 占位符色：`--fn-text-3`（CSS 推导；实测登录页输入框占位文字为灰色）。
- 聚焦：`border-color: var(--fn-focus-border) #0066FF`（`--semi-color-focus-border`）。
- 禁用底：`--fn-input-bg-disabled`（light `rgba(90,91,92,.16)` / dark `#2E2F30`）。
- **搜索框**（文件管理/应用中心）：`semi-input-wrapper` + 前置放大镜图标，尺寸 **200 × 28**（文件管理工具栏）或通栏（应用中心侧边栏）；圆角沿用 6px（文件管理工具栏实测为胶囊形，**未逐像素测得该处圆角值**）。
- 文件管理工具栏还有一个**路径/面包屑框**：flex-1、高 28px、浅底圆角、显示当前路径 `我的文件`。

### 5.3 下拉 / 选择器 `semi-select`

```css
.semi-select{
  box-sizing:border-box; border-radius:6px; height:36px;
  border:1px solid var(--fn-border); background-color:var(--fn-input-bg);
  font-weight:400; display:inline-flex; vertical-align:middle;
  position:relative; cursor:pointer; max-height:300px; overflow-y:auto;
}
.semi-select-large{ height:40px; line-height:40px; }
```
- 实测（手动安装弹窗）：`390 × 40`，`border-radius:6px`，`border:1px solid rgba(11,11,12,.16)`，底 `#FFFFFF`，`font-size:14px`。
- 箭头 `.semi-select-arrow`：`width:32px`，色 `--fn-text-2`（`rgba(11,11,12,.5)`）。

### 5.4 弹出层 / 下拉菜单 / 右键菜单

**Popover / Dropdown 面板**（实测用户菜单 240×235）：`border-radius:12px`（类名 `!rounded-xl`），背景 `--fn-menu-bg`，阴影 `--fn-shadow-dropdown`。

**右键菜单**（实测桌面图标右键）：容器 **128 × 50**，`min-width:110px`（`min-w-[6.875rem]`），`padding:4px 0`（`py-1`），**圆角 8px**（`rounded-lg`），`border:1px solid var(--fn-border-select)`（light `rgba(11,11,12,.06)` / dark `rgba(255,255,255,.12)`），背景 `--fn-menu-bg`（light `#FFFFFF` / dark `#2E2F30`），阴影 `--fn-shadow-dropdown`。

**菜单项**：
```css
.semi-dropdown-item{ padding:8px 16px; color:var(--fn-text-0); max-width:280px; display:flex; align-items:center; }
.semi-dropdown-item:hover{ background-color:var(--fn-fill-0); }
```
实测单项：**126 × 36**，`padding:8px 16px`，图标 16×16 + 文字 14px/20px/400；容器上方/下方各 2px（`my-super-tight`）。示例项：`从桌面移除`（带图标）。

### 5.5 模态 / 对话框 `semi-modal`

截图：`20261011-fnos-appcenter-manualinstall-light-1600x1000.png`（`手动安装`）

**实测结构**：

| 部件 | 实测值 |
|---|---|
| `.semi-modal-mask` | `position:fixed; inset:0; background-color: var(--fn-overlay-anti);`<br>**light `rgba(255,255,255,.70)`** / dark `rgba(0,0,0,.60)`<br>⚠️ **在应用窗口内部弹出时，遮罩只覆盖窗口体**（实测 `[251, 257, 1100, 596]`），不是全屏；全屏弹窗才用 `--fn-overlay rgba(0,0,0,.7)` |
| `.semi-modal-wrap` | `position:fixed; inset:0; z-index:1000; overflow:auto`（应用内变体为 `position:absolute; overflow:hidden`） |
| `.semi-modal` | 尺寸由 `semi-modal-small/medium/large` 决定；实测 small = **440 × 322**，居中 |
| `.semi-modal-content` | `background: var(--fn-bg-2)`（light `#FFFFFF` / dark `#1F2021`）<br>`border:1px solid var(--fn-border-modal)`（light `rgba(11,11,12,.06)` / dark `rgba(255,255,255,.12)`）<br>**`border-radius:12px`**<br>`padding: 0 24px`<br>`box-shadow: var(--fn-shadow-elevated)` = `0 10px 20px rgba(0,0,0,.08), 0 10px 40px rgba(0,0,0,.12)`<br>`overflow:hidden` |
| `.semi-modal-header` | `margin: 24px 0; font-size:14px; font-weight:600;` 背景透明、无下边线 |
| `.semi-modal-title`（h5） | **18px / 24px / 600**，色 `--fn-text-0` |
| 关闭按钮 | `semi-button semi-button-tertiary semi-button-size-small semi-button-borderless semi-modal-close`，实测 **26.8 × 28**，`padding:4px`，**圆角 6px**，图标 16×16，色 `--fn-text-1` |
| `.semi-modal-body` | 实测 `390 × 244`（内容宽 = 440 − 24×2 再扣滚动条余量） |
| 动效 | 遮罩显隐 `90ms cubic-bezier(.215,.61,.355,1)`（`semi-modal-mask-animate-show/hide`） |

**弹窗内容示例（手动安装）**：`手动安装` 标题 → `请选择存储空间` 标签 → `选择存储位置` 下拉（390×40）→ `上传 fpk 文件` 标签 → `从电脑上传`（390×36 outline）→ `从 NAS 添加`（390×36 outline）。

### 5.6 Tabs

```css
.semi-tabs-tab{
  font-size:14px; line-height:20px; font-weight:400;
  color:var(--fn-text-2); cursor:pointer; position:relative;
  padding:16px 4px 14px; border-bottom:2px solid transparent;
}
.semi-tabs-tab-active{ color:var(--fn-text-0); border-bottom-color: var(--fn-primary); }
.semi-tabs-bar{ white-space:nowrap; position:relative; }
```
- 实测（文件管理设置页顶部 Tab）：`SMB`（选中，蓝色 2px 下划线）/ `WebDAV` / `FTP` / `NFS` / `删除文件偏好`。
- **垂直 Tab**（应用侧边栏用的就是它）：`base-Tabs-root base-Tabs-vertical`，Tab 高 **36px**，圆角 **6px**，`padding:8px`，`font-weight:500`，选中态 `background: var(--fn-primary-tint-12)` + 文字 `--fn-primary`。

### 5.7 表格 / 列表 `semi-table`

```css
.semi-table{ width:100%; text-align:left; border-collapse:separate; border-spacing:0; font-size:inherit; }
.semi-table-thead > .semi-table-row > .semi-table-row-head{
  background-color:var(--fn-bg-1); color:var(--fn-text-2); font-weight:600; text-align:left;
  border-bottom:1px solid var(--fn-divider-1); padding:8px 16px; vertical-align:middle;
  transition:background-color .1s linear;
}
.semi-table-thead > .semi-table-row > .semi-table-row-head:hover{ background-color: var(--semi-color-table-HoverBg); }
```
- **未测得**：真实文件列表 `tbody` 行高 / 斑马纹 / 选中行（VM 无存储空间）。
- 通用列表项 hover 底色统一用 `--fn-fill-0`。

### 5.8 复选框 / 单选 / 开关

```css
.semi-checkbox{ display:flex; align-items:flex-start; column-gap:8px;
  font-size:14px; line-height:20px; cursor:pointer; }
.semi-checkbox-inner{ position:relative; display:flex; align-items:center; width:16px; height:20px; }
.semi-checkbox-inner-checked{ color: var(--fn-primary-disabled); }   /* 勾选态勾/底由该变量渲染 */

.semi-switch{ width:40px; height:24px; border-radius:12px;
  background-color: var(--fn-fill-2); border:1px solid transparent;
  transition: background-color .2s var(--fn-ease-in) 0ms; }
.semi-switch-checked{ background-color: var(--fn-primary); }
.semi-switch-knob{ width:24px; }   /* 选中位移动画 translate(18px) */
```
- **单选框（radio）** 实测于「主题壁纸」：16px 圆点，未选中 = 1px 灰环；选中 = 蓝色实心圆点 `#0066FF`（`--fn-primary`）。
- 复选卡片（新手引导里的应用勾选）：`semi-checkbox-cardType_enable`，`flex-row-reverse`（勾选在右），高度 40px。

### 5.9 Tooltip

```css
.semi-tooltip-wrapper{
  position:relative; background-color: rgba(var(--semi-grey-7),1);  /* #6B6B6B light */
  color: var(--fn-bg-0);                  /* 反色文字：#F3F3F3 (light) / #0C0C0D (dark) */
  border-radius: var(--fn-radius-md);     /* 6px */
  padding: 8px 12px; max-width:240px;     /* fnOS 覆写为 max-width:unset */
  font-size:14px; line-height:20px; opacity:0;
}
.semi-tooltip-wrapper-show{ opacity:1; }  /* 类名实测：semi-tooltip-wrapper semi-tooltip-wrapper-show */
```
实测（rail 图标 hover）：外框 **80 × 36**，内层 `.semi-tooltip-content` **56 × 20** → 正好 `padding:8px 12px`、`8+20+8=36`、`12+56+12=80`。文案 `全部应用`。截图 `20261011-fnos-rail-tooltip-light-1600x1000.png`。

### 5.10 Toast

```css
.semi-toast-content{
  pointer-events:all; font-size:14px; line-height:20px; font-weight:600;
  background-color: var(--fn-bg-3); border-radius: var(--fn-radius-md);  /* 6px */
  padding: 12px 8px; margin: 12px; display:inline-flex; align-items:flex-start;
  box-shadow: 0 10px 20px #00000014, 0 10px 40px #0000001f;
  color: var(--fn-text-0);
}
/* 语义变体：加 1px 描边 + 浅底 */
.semi-toast-content-warning{ background: var(--semi-color-warning-light-default); border:1px solid var(--fn-warning); }
.semi-toast-content-success{ background: var(--semi-color-success-light-default); border:1px solid var(--fn-success); }
.semi-toast-content-info   { background: var(--semi-color-info-light-default);    border:1px solid var(--fn-info); }
.semi-toast-content-error  { background: var(--semi-color-danger-light-default);  border:1px solid var(--fn-danger); }
```
> **未测得**：真实 toast 截图（本次会话未触发）。上表为 CSS 实测规则。

### 5.11 空状态 `semi-empty`

```css
.semi-empty{ /* 结构：.semi-empty-image + .semi-empty-content */ }
.semi-empty-vertical{ align-items:center; flex-direction:column; }
.semi-empty-image{ display:flex; justify-content:center; pointer-events:none; user-select:none; }
.semi-empty-content{ margin-top:24px; }
.semi-empty-title{ /* 文案：--fn-text-2 或 --fn-text-0，视场景 */ }
```
实测（文件管理）：`.trim-ui__empty--root.semi-empty.semi-empty-vertical` 整体 **252 × 232**，插画为灰色立体存储设备图形，文案 `使用文件管理应用前，请先创建存储空间`，下方一个 primary 按钮 `存储空间管理`。

> 换皮建议：准备 3～4 张同风格的**灰色 3D 等距插画**（存储/文件/网络/无数据），尺寸约 110 × 90，文案统一「使用…前，请先…」+ 一个主按钮的句式。

### 5.12 滚动条

```css
::-webkit-scrollbar{ width:8px; height:8px; }
::-webkit-scrollbar-track{ background:transparent; }
::-webkit-scrollbar-corner{ background-color:transparent; }
::-webkit-scrollbar-thumb{ border-radius:6px; background:transparent; transition:all 1s; }
*:hover::-webkit-scrollbar-thumb{ background: var(--fn-scrollbar); }        /* light rgba(90,91,92,.16) */
::-webkit-scrollbar-thumb:hover{ background: var(--fn-scrollbar-hover); }   /* light rgba(90,91,92,.32) */
```
- **默认透明，hover 容器时才显现**（`.semi-light-scrollbar` 同理）。
- 隐藏滚动条的工具类：`.scrollbar-hidden`（应用栏中部列表用它，`scrollbar-hidden absolute inset-0 ... overflow-y-auto`）。
- 部分区域（如应用中心侧边栏）额外用 `ms-container` + `ms-track` 自绘滚动条（实测侧边栏右侧有 `ms-track ms-y`）。

### 5.13 进度 / 环形进度

```css
.semi-progress-track{ background-color:#ccd6e04d; border-radius: var(--fn-radius-xs); }  /* 3px */
.semi-progress-track-inner{ background-color: var(--fn-primary); border-radius: var(--fn-radius-xs);
  transition: width .3s cubic-bezier(.62,.05,.36,.95); }
```
- 实测（系统设置「系统安装空间」）：环形进度，中心文字 `16.02%` 16px/24px/400。
- 线性进度底可用 `--fn-progress-track`（light `rgba(11,11,12,.06)` / dark `rgba(255,255,255,.12)`）。

---

## 6. 动效与交互

### 6.1 令牌

| token | 值 |
|---|---|
| `--semi-transition_duration-none` | `0ms` |
| `--semi-transition_duration-fastest` | `90ms` |
| `--semi-transition_duration-faster` | `120ms` |
| `--semi-transition_duration-fast` | `180ms` |
| `--semi-transition_duration-normal` | `600ms` |
| `--semi-transition_duration-slow` / `slower` / `slowest` | `1s` / `1.2s` / `1.8s` |
| `--semi-transition_function-easeIn` | `cubic-bezier(.4, 0, 1, 1)` |
| `--semi-transition_function-easeOut` | `cubic-bezier(0, 0, .2, 1)` |
| `--semi-transition_function-easeInOut` | `cubic-bezier(.4, 0, .2, 1)` |
| `--semi-transition_function-linear` | `linear` |

### 6.2 实测到的过渡

| 元素 | 过渡 |
|---|---|
| **桌面图标** 图标盒 | `transition: all 150ms`（类 `transition-all duration-150`） |
| **资源组件玻璃胶囊** | `transition: all 200ms`（`transition-all duration-200`） |
| Semi 按钮 | `background-color` / `border`，`0ms` 时长（即无过渡，瞬时换色）；`transform: scale(...)` 由 `--semi-transform_scale-*` 控制 |
| 输入框 | `background-color` / `border`，`0ms` |
| 下拉项 hover | `background-color`，`easeOut`，`0ms` |
| **开关** | `background-color .2s easeIn 0ms`；滑块位移 `translate(18px)` |
| 表格表头 hover | `background-color .1s linear` |
| 进度条 | `width .3s cubic-bezier(.62,.05,.36,.95)` |
| **模态遮罩显隐** | `90ms cubic-bezier(.215,.61,.355,1)`（`semi-modal-mask-animate-show/hide`） |
| 窗口拖拽/缩放 | `.is-dragging` / `.is-resizing` → `will-change: top,left,width,height`（无 transition，直接跟手） |
| 滚动条滑块 | `transition: all 1s`（淡入） |

### 6.3 hover / active 状态汇总

| 元素 | hover | active |
|---|---|---|
| rail 项 | `background: rgba(255,255,255,.10)` | 选中：`bg-white-10` + 左侧 3px `#0066FF` |
| 窗口按钮（最小化/最大化） | `background: var(--fn-fill-0)` | `background: var(--fn-fill-0)` |
| **窗口关闭按钮** | `background: var(--fn-danger) #DB382C; color:#FFF` | `background: var(--fn-danger)` |
| 侧边栏项 | `--fn-fill-*` 系（CSS 推导） | 选中 `rgba(0,102,255,.12)` + 文字 `#0066FF` |
| 应用卡片右上的「安装」按钮 | `--fn-primary-tint-20`（CSS 推导） | `--fn-primary-tint-30` |
| 下拉/右键菜单项 | `background: var(--fn-fill-0)` | — |
| 输入框 | `border-color: var(--fn-border-hover)` | 聚焦 `border-color: #0066FF` |
| 表格表头（可排序） | `background: var(--semi-color-table-HoverBg)` | — |
| 按钮 primary | `#005EEB` | `#0043B8` |
| 按钮 danger | `#B7251F` | `#941515` |

### 6.4 窗口打开 / 关闭 / 最小化行为

- **打开**：点击桌面图标 → 创建 `.trim-ui__app-layout--window` 绝对定位元素，`z-index` ≈ 10011；位置由窗口管理器计算（居中并带偏移，实测文件管理 `[223,176.5]`、系统设置 `[287,176]`）。
- **拖动**：标题栏 `cursor:move`；拖动时加 `.is-dragging`。
- **缩放**：8 个 `.resizable-handler`（t/rt/r/rb/b/lb/l/lt，各 4px 宽）；不可缩放窗口带 `.disable-resize`（新手引导窗口即是）。
- **最小化**：点击 `.app-layout-header-minimize`。**未测得**最小化后的落点（本次未捕获到最小化后的 DOM 状态；也没有对应任务栏/dock）。
- **关闭**：点击 `.app-layout-header-close` 直接移除窗口，无退出动画（**未测得**关闭动画时长）。
- **Windows 打开顺序**：多个窗口同时存在（新手引导窗 + 应用窗口），DOM 顺序即层叠顺序，后开者在后。
- **rail 图标选中态**：当前激活的应用在 rail 上对应项获得 `bg-white-10` + 3px 蓝色左竖条（实测：新手引导激活时 rail 第 3 项高亮；文件管理激活时 rail 对应项高亮）。

---

## 7. 未测得 / 已知空白（务必不要编造）

1. **文件/文件夹列表行**的排版、行高、斑马纹、选中/hover 底色 —— VM 无存储空间，内容区只有空状态。
2. **图标视图 / 缩略图网格**（文件管理的列表↔图标切换按钮未出现）。
3. **焦点 vs 非焦点窗口**的视觉差异 —— 未能在真实 UI 中同时保留两个应用窗口。
4. **窗口打开 / 关闭 / 最小化动画** 的时长与缓动曲线。
5. **Toast** 的真实截图（仅从 CSS 得到规则）。
6. **应用中心侧边栏 `设置` 页**、**rail 底部 ①资源管理 / ②通知 / ④齿轮** 三个入口的界面。
7. **登录页以外的 `?locale=` 多语言字体**实测值（仅从 CSS 取得字体族）。
8. **登录页 `gradient-border`** 类：类名存在但 CSS bundle 中**没有对应规则**，当前无渐变描边。
9. **启动台搜索框**的精确尺寸与圆角（截图上为胶囊形，未逐像素测量）。
10. **桌面图标 hover / 选中**的底色（合成鼠标事件未触发该状态）。
11. **暗色主题下的滚动条与模态实测截图**（深色令牌已从 CSS 解析，但未逐屏截图）。
12. **文件管理工具栏搜索框的圆角**（截图为胶囊形，未取到计算值）。

---

## 8. 截图清单

全部位于 `output/verification/`：

| 文件 | 内容 |
|---|---|
| `20261011-fnos-login-light-1600x1000.png` | 登录页（亮色，恒亮） |
| `20261011-fnos-desktop-light-1600x1000.png` | 桌面（亮色，引导窗已隐藏） |
| `20261011-fnos-desktop-welcome-light-1600x1000.png` | 桌面 + 「欢迎来到 fnOS」引导窗口（首次进入默认态） |
| `20261011-fnos-desktop-dark-1600x1000.png` | 桌面（暗色） |
| `20261011-fnos-desktop-light-2560x1440.png` | 桌面（亮色，2560×1440） |
| `20261011-fnos-launchpad-light-1600x1000.png` | 启动台「全部应用」 |
| `20261011-fnos-rail-tooltip-light-1600x1000.png` | rail 图标 Tooltip（`全部应用`） |
| `20261011-fnos-contextmenu-desktopicon-light-1600x1000.png` | 桌面图标右键菜单（`从桌面移除`） |
| `20261011-fnos-usermenu-light-1600x1000.png` | rail 底部用户菜单（`个人设置`/`退出登录`） |
| `20261011-fnos-filemgr-empty-light-1600x1000.png` | 文件管理（亮色，空状态） |
| `20261011-fnos-filemgr-empty-dark-1600x1000.png` | 文件管理（暗色，空状态） |
| `20261011-fnos-filemgr-settings-light-1600x1000.png` | 文件管理设置（`文件共享协议` / SMB） |
| `20261011-fnos-appcenter-light-1600x1000.png` | 应用中心（亮色） |
| `20261011-fnos-appcenter-dark-1600x1000.png` | 应用中心（暗色） |
| `20261011-fnos-appcenter-manualinstall-light-1600x1000.png` | 应用中心「手动安装」模态 |
| `20261011-fnos-settings-light-1600x1000.png` | 系统设置（`设备信息`） |
| `20261011-fnos-settings-dark-1600x1000.png` | 系统设置（暗色） |
| `20261011-fnos-account-theme-light-1600x1000.png` | 我的账号 → 主题壁纸（亮模式选中） |
| `20261011-fnos-account-theme-dark-1600x1000.png` | 我的账号 → 主题壁纸（暗模式选中） |

---

## 9. 换皮落地清单（给实现工程师）

1. 把 §1.3 的 `:root` / `body[theme-mode="dark"]` 两块贴进全局样式表；把项目里所有硬编码颜色替换为 `--fn-*`。
2. `font-family` 换成 `--fn-font`（zh-CN 为 `PingFang SC` 打头）。
3. 全局 `border-radius` 阶梯改成 3 / 6 / 8 / 12 / 16 / 32px；按钮 8px、输入框 6px、窗口 16px、弹窗 12px。
4. 窗口 Chrome 用 §3 的数值重做：1100×640、标题栏 44px、标题 14/20/600 + 24px 图标、右上三个 46×44 按钮（关闭 hover 变红）。
5. 桌面外壳用 §2 的数值重做：66px rail（52px 玻璃条 + 6px 圆角 + `blur(20px)`）+ 144×120 图标格 + 右上资源胶囊。
6. 组件层把 Semi 换成 §5 的尺寸：按钮高 36px/`padding 0 16px`/`600` 字重，输入框 6px 圆角，弹窗 12px 圆角 + `--fn-shadow-elevated`。
7. 深浅切换绑定到容器属性（`body[theme-mode]` 或等价物），**不要**依赖 `html.dark`；登录页强制亮色。
8. 空状态准备灰色 3D 等距插画 + 「使用…前，请先…」句式 + 一个主按钮。
