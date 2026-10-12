# 值守巡检：三类"漂移"

开发告一段落、又还没有新的输入，于是做了一次**不改产品代码**的巡检 ——
只看"有没有东西在这段时间里悄悄偏离"。结果抓到三样。

## 1. 线上部署落后于仓库

```
本地 assets/client-Bcmc0z7g.js
线上 assets/client-DwC7CsPs.js   ← 旧
```

第 48–51 轮改了 `values.ts`（去重）、拆了 `NasModule`、加了媒体库部分失败提示 ——
**都构建过、测试过，但没有推上去**。浏览器里跑的是旧代码。

已重新构建 + 推送，指纹核对一致 ✓

> 这类漂移不会自己暴露：单元测试测的是仓库里的代码，线上跑的是上一次推的产物。
> 值守巡检的价值就在这里。

## 2. `dist-deploy/` 被 git 跟踪（20 MB，含 15 MB 二进制）

```
$ git ls-files deploy/nas-appstore/dist-deploy/ | wc -l
77
$ du -sh deploy/nas-appstore/dist-deploy
20M
```

它是 `build.sh` 的**构建产物**，而且 `.gitignore` 里本来就有 `dist/` ——
目录名故意避开那条规则，结果**误伤了**：每次构建都会把 `git status` 塞满改动，
每个版本的网关二进制都被提交一次。

已加入 `.gitignore` 并 `git rm --cached`（**文件保留在磁盘上**，`push.sh` 正好从那里读）。

历史里的旧 blob 还在（`.git` 157 MB）。真正回收需要重写历史 ——
**共享分支上我不会不问就做**。

## 3. lockfile 少了 `hls.js`

`package.json` 声明 `hls.js ^1.7.3`、`node_modules` 里也是 1.7.3，
但 `pnpm-lock.yaml` **没有这条**：

- 冻结安装（CI、或任何人跑 `pnpm install --frozen-lockfile`）会因锁文件不一致而**失败**；
- 已按实际在用的版本补齐。

## 结论：这三样比"再写点代码"更值得做

它们都不影响我现在能不能写出新功能，但都会在**别人接手的那一刻**变成障碍：
线上不是最新的、`git status` 一片红、装不上依赖。

配套：`bash scripts/verify.sh` 离线 6 项全过（含文档引用检查）。
