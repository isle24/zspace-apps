# 应用商店窗口：官方商店 + 空间商店

目标要求「应用商店 = 极空间官方商店 + 另加空间商店」。两边现在都在同一个窗口里，
顶部切换说明来源，避免把两边的"可安装"混为一谈。

## 极空间官方商店（本轮新增）

实测端点（真机 2026-10-12）：

| 调用 | 结果 |
| --- | --- |
| `POST /AppStore/v1/list` | **74 项**原生应用：`app_name` / `status`(running\|stop) / `pkg_size` / `save_to` / `removable` / `toggleable` / `is_buildin` / `is_docker` / `is_virtual` |
| `POST /zdocker/AppStore/v1/list` | **16 项**容器类应用（`is_docker=1`） |

界面：两个分区（设备应用 / 容器应用），每个应用一张卡——状态点 + 名称 + 状态徽标 +
安装位置 + 体积，`is_buildin`/`is_virtual`/`removable=0`/`toggleable=0` 会显示成
「内置 / 虚拟机 / 不可卸载 / 不可启停」。实测渲染：`FTPBackUp 运行中 安装于 /data_n001`、
`HDMI 运行中 不可启停`、`NVIDIAvr 运行中 不可启停`。

**只读**：安装、卸载、启停不做。这些动作官方客户端才带着完整的依赖与回滚信息，
我们不猜——界面里也写明了这一点。

## 空间商店（Codex 的实现，未改动）

窗口里的「空间商店」标签就是 `modules/Store.tsx`（本文件没有碰它），
外面套了一层 `StoreWindow` 只负责切换来源。当前实测状态：

```
商店尚未启用 · NAS 管理员登录 · 独立商店 · 执行模式：未启用 · 引擎未就绪
执行引擎未配置；请登记本机Docker或可用sshbind别名
```

目录里能看到 Uptime Kuma 2.5.6「可安装」、Navidrome 0.64.2「可安装」，
Jellyfin / Immich / Syncthing 标「配方待验证」——都是商店自己如实报的状态。
**执行引擎的配置是 Codex 那边的收尾工作**，界面照实显示，不伪造可用。

## 测试

`modules/OfficialStore.test.tsx` + 既有商店测试，全套 **50 文件 / 1124 用例全绿**。
