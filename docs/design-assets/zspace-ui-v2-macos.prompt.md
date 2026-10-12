# Mac 风格 UI v2 生成说明


## 安装向导状态修订完整提示词

Use case: precise-object-edit / ui-mockup.
Image 1 is the edit target: the existing Mac-style Uptime Kuma installation wizard design.
Change ONLY the disabled/enabled states of two controls to make unverified platform capabilities honest. Preserve all window geometry, sidebar, background, modal dimensions, typography, spacing, app icon, existing Chinese labels, blue palette, data directory fields, port field, footer buttons and all other content exactly.
1. In the segmented control labelled "访问入口", make "局域网" the selected option with the existing system-blue selected fill and readable white text. Make "极空间远程访问" the unselected disabled option, pale neutral grey with readable muted grey text. Retain the helper row "官方入口能力待验证" and "保留 Web 桌面入口".
2. In the checkbox row labelled "添加到极空间桌面", make the checkbox unselected and disabled: grey outline rather than a filled blue check. Label stays readable in muted graphite. Change its small helper from "显示应用图标" to exactly "平台支持后显示应用图标". Do not move or resize this row.
3. Keep the "加入 Web 应用桌面" checkbox checked blue and enabled, with its existing helper "统一打开和管理应用".
No other changes. Preserve "现有文件保持只读，应用数据单独保存". Preserve the four-step indicator with step 2 selected and all controls at their current positions. Keep "界面设计预览" outside the window. No new paragraphs or statuses, no crop. This is a design concept and the target portrays initial setup before native-platform capability verification.

日期：2026-10-10。工具：内置 imagegen。用途：界面设计评审，非前端运行截图。

当前输出：[商店首页](zspace-store-concept-v2-macos.png)、[安装向导](zspace-install-wizard-v2-1-macos.png)。v1 保留供比较；v2 为当前视觉方向。[向导初稿](zspace-install-wizard-v2-macos.png) 也保留，最终图修正了未验证平台能力的选中状态。

视觉参考：[Apple 侧栏](https://developer.apple.com/design/human-interface-guidelines/sidebars)、[Apple 工具栏](https://developer.apple.com/design/human-interface-guidelines/toolbars)。安装步骤的结构参考 [飞牛官方安装说明](https://help.fnnas.com/articles/v1/media/media_install)，没有复制其图片或品牌标识。

窗口外框用于展示 Mac 场景；Web 页面内部不重复绘制系统红黄绿窗口按钮。图中图标和推荐图是生成式概念资产，正式实施须替换为核实来源的实际素材。图中按钮与字段仅表示预期交互，官方入口尚未通过实际注册与外网验证。

## 商店首页完整提示词

Use case: ui-mockup / style-transfer.
Asset type: high fidelity product interface design, first screen in a coordinated two-screen set.
Image 1 role: edit target and functional reference. Redesign its visual composition substantially, while preserving the product purpose: a third-party application store for ZSPACE NAS, Simplified Chinese, categorized applications, search, installed apps, tasks and an application desktop. This is an improved concept, not a live screenshot.
Primary request: make the existing NAS app-store design feel as refined and coherent as a beautiful native Mac application. Carefully composed hierarchy, quieter controls, precise spacing and genuinely polished materials. Draw inspiration from macOS App Store, Finder and refined productivity apps. Use Mac design language interpreted for a Web app; do not suggest implementation of an Apple native API.
Composition: one straight-on application window, landscape 16:10, comfortably fills 94% of canvas, thin neutral pale-grey margin, subtle realistic window shadow and 18px outer corners. No laptop, no perspective. Mac traffic-light controls at top-left of window chrome; no Windows controls. Unified 54px title toolbar. Very restrained translucency only in the cool grey left sidebar and titlebar; solid white main content. Crisp PingFang/SF-like sans-serif, precise readable Chinese labels. Human scale: ordinary UI text equivalent 13-15px, page heading 26px, modest icons. No enormous headline or oversized form fields.
Visual system: cool white #FAFBFC, soft grey #F0F2F5, graphite text #202328, a single system-blue accent around #0A64D8 for selection and actions. Soft blue selection background, simple rounded 8px controls, 12px featured tiles, consistent thin separators. Brand application icons may keep their own colors. Avoid shiny gradients over controls, exaggerated glass, neon, pseudo-3D dashboards or thick outlines.
Layout:
Left sidebar around 215px wide. At the top small restrained identity text "极空间商店" and descriptor "第三方应用". Sections have discrete grey labels. Section "探索" includes rows "发现应用" selected in pale blue, "全部应用". Section "我的空间" includes "应用桌面", "已安装", "任务中心". "设置" at bottom. One consistent small thin-line icon family. Sidebar rows have compact 34px height and generous breathing room between groups. Bottom small NAS device tile "我的 NAS" and grey line "本地设备", without a fake connected green status.
Toolbar in main area: compact back arrow, title "应用商店", search field "搜索应用" aligned toward right, one small view control. Keep everything on one row.
Main content inset 32px, title "发现应用". Quiet one-line subtitle "找到适合你的 NAS 应用". A compact category segmented strip below with labels "全部", "影音", "下载", "文件", "阅读", "工具". "全部" selected.
Section "精选推荐": two beautifully art-directed horizontal featured panels, moderate height around 150px, unequal width 58% and 42%. First panel muted dusk-blue abstract video-frame artwork and crisp Jellyfin logo, name "Jellyfin", short text "你的家庭影音库", small blue text action "查看详情". Second panel a pale cool-blue understated music artwork with restrained rhythm lines and Navidrome logo, name "Navidrome", short text "随时聆听你的音乐", small action "查看详情". These are modest product-discovery panels, not a marketing hero. Artwork must be tasteful, original, not ripped movie posters.
Section below title "常用应用" with six elegant compact app cards in a 3-column by 2-row layout, mostly white, subtle boundaries, equal clean spacing, around 130px tall per card. Each card has a roughly 46px recognizable app icon top-left, name and one precise line of grey text. Small rounded pale-blue "安装" button right aligned, not a big full-width colored button. Cards: "Uptime Kuma" with "服务监控"; "FreshRSS" with "RSS 阅读"; "Audiobookshelf" with "有声书与播客"; "Jellyfin" with "媒体服务"; "Navidrome" with "私人音乐库"; "Syncthing" with "文件同步" and button "查看" instead of install. Do not show made-up versions, downloads, ratings, statistics or completed NAS operations.
The app store overview has NO persistent installation pane, NO modal, NO dark dimming. Browse first; installation will be the separate second design screen.
A tiny caption outside the window at bottom says "界面设计预览".
Prioritize elegant Macintosh proportions, high contrast readable typography, exquisite alignment, deliberate restrained visual hierarchy, familiar professional product interaction. Render short labels exactly. Keep product identity, application names and functions clear. Do not include additional brand names, slogans or feature claims.

## 安装向导初稿完整提示词

Use case: ui-mockup.
Asset type: the installation wizard screen of a coordinated Mac-inspired Web application store design.
Image 1 role: visual system reference, NOT a screen to copy unchanged. Preserve its exact window chrome, sidebar grouping, cool white/grey materials, system-blue accent, typography, icon appearance and overall proportions. The product is the same third-party ZSPACE NAS store "极空间商店", Simplified Chinese.
Primary request: design a beautifully refined, usable Mac-like installation and initial setup sheet for Uptime Kuma, within the same store window. This is a visual concept, not a live screenshot or proof that NAS operations succeeded.
Composition: landscape 16:10, same straight-on full application window and thin pale neutral margin. Mac traffic lights at top-left, fine window shadow and modest rounded window corners. The same store overview is visible behind but softly de-emphasized in neutral grey, without a dramatic dark overlay; background text is not the focus. A perfectly composed centered installation sheet, approximately 700px wide and 670px high relative to a 1280px application window. Sheet is solid near-white, softly elevated, very thin border, 16px corners. No ornamental glass, no neon, no mobile device, no perspective.
Design: exceptional fine typography and spacing like macOS System Settings and polished Mac utilities. Keep font sizes human-scale, carefully aligned form rows, subtle fine-line icons, blue controls #0A64D8. Use generous but efficient vertical spacing. No thick borders, no giant full-width buttons, no decorative metrics.
Sheet header: small recognizable Uptime Kuma app icon 42px, title "安装 Uptime Kuma" and concise subtitle "设置存储位置与访问入口". Tiny close icon at upper-right.
Step indicator across sheet: four restrained labelled steps "检查环境", "存储与访问", "应用设置", "确认安装". Second step is selected in blue. Small numbered circles and fine connectors. Do not add green claims such as checks passed or connected; this is a form design preview.
Form content:
- Label "应用名称" above an elegant single-line field filled with "Uptime Kuma".
- Label "数据目录" above a single row containing an empty chooser displaying "选择应用专用目录" and a compact "选择" button at right. Small helper text "配置和数据保存在此目录". Do not show user names or invented filesystem paths.
- Label "服务端口" above a compact field reading "自动分配". Small subdued helper "安装前检查端口占用".
- Label "访问入口" with a tidy native-style segmented control containing "局域网" and "极空间远程访问"; latter selected in blue.
- Directly below, a neutral small info row with text "官方入口能力待验证". No large orange alarming status. Clear muted text below "保留 Web 桌面入口".
- Two carefully aligned checkbox rows, both selected blue as configuration intentions: "添加到极空间桌面", with helper "显示应用图标"; "加入 Web 应用桌面", with helper "统一打开和管理应用". These are desired settings, do not label them as completed operations.
- Near bottom of form, a very quiet pale grey informational strip with an outline shield icon and exact text "现有文件保持只读，应用数据单独保存".
Footer separated by one hairline: left small secondary "取消", at right grey secondary "上一步" and small blue primary "下一步". Buttons aligned on one baseline, readable labels, primary width approximately 90px, not oversized.
Outside window at bottom only the discreet caption "界面设计预览".
Keep the screenshot tastefully airy yet practical. Main aim is Mac application craftsmanship: precise grid, typography and grouping; honest setup state; easy folder selection and preservation of user data. Render every short Chinese label accurately, with no invented feature claims, credentials, addresses, ratings, extra paragraphs or decorative brand slogans.

