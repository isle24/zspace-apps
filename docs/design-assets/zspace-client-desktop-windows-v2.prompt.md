# 系统桌面 v2 设计提示词

日期：2026-10-10。工具：内置 imagegen。用途：NAS 系统桌面设计，非运行截图。

输出：[设计图](zspace-client-desktop-windows-v2.png)。参考用户提供的绿联系统桌面交互结构；壁纸和应用图标重新设计，未复制真实账号或设备地址。

完整提示词：

Use case: ui-mockup.
Image 1 is the exact visual-system and desktop wallpaper reference for "空间桌面", a ZSPACE NAS system desktop. Create a second screen showing genuine WINDOWED APPLICATIONS over this same desktop. Keep the same original navy/sapphire wallpaper, top status bar, desktop icon craft, readable white labels, Mac host-window traffic lights and bottom Dock. No global left sidebar or dashboard frame.
Composition: landscape 16:10 full application canvas. Wallpaper remains visible around multiple independent overlapping app windows. Desktop icon grid is partially visible behind the windows on the left. The top bar still shows "空间桌面", "我的 NAS", "待连接", "CPU —", "RAM —", and tasks/notifications/search/account icons. All business data is illustrative.
Open TWO separate application windows with obvious offset bounds, independent title bars, shadows, close/minimize/maximize controls, and layered z-order:
1) Background window "应用商店" at upper-right, about 700px wide and 440px tall relative to 1600px desktop. Top-left original blue store icon and title. A compact search field "搜索应用". White content with small tabs "全部", "影音", "阅读", "工具". Two visible refined sample rows or cards "Jellyfin / 家庭影音" and "Navidrome / 私人音乐", and modest "查看" buttons. The window is partly covered by the foreground file window, so show its title and some right-hand content clearly. This is an app window, not a sidebar attached to the whole screen.
2) Foreground window "文件管理" approximately 860px wide and 570px tall, positioned central-left lower than the store window. Slim light Mac-style title bar, title "文件管理", small app icon, clear independent window controls. In-window toolbar with breadcrumb "我的文件 > 工作资料", search "搜索当前目录", view toggle. Small inside folder-navigation sidebar with labels "我的文件", "文档", "图片", "视频", "音乐"; this sidebar belongs ONLY inside the file app window.
File content white and crisp, title "工作资料", small "示例内容". Beautiful Finder-like table headers "名称", "类型", with five original example entries "设计素材" / "文件夹", "项目文档" / "文件夹", "产品方案.pdf" / "PDF 文档", "会议记录.docx" / "Word 文档", "旅行照片" / "文件夹". Select "产品方案.pdf" in pale blue. Right-side compact preview block inside this window shows original sample document heading "产品方案" and neutral grey text lines. Small "打开预览" action, no private timestamps/sizes. Fine lines and excellent alignment.
Window titlebar controls must clearly belong to each floating application; maximizing and closing a module window are conceptual local UI actions, not server delete/stop actions. No task percentage, video playing status or real NAS resources.
Bottom Dock stays visible and unobscured, with favorites file/photo/video/music/store/settings icons and small subtle running-window markers under file and store. Markers indicate open UI windows, NOT NAS container running states. No giant new cards on wallpaper.
Keep the reference wallpaper and desktop intact, gentle soft shadows differentiate windows, coherent light window interiors contrast beautifully with dark system wallpaper. Each app opens independently inside the NAS desktop; this is NOT a full-page route switch and NOT a web dashboard.
At bottom-left exact small caption "设计预览 · 示例内容". No recycle bin, format, clear, remove, overwrite controls. No actual account names, device addresses or credentials. Render all Chinese labels accurately and keep everything visible, within bounds and readable.

