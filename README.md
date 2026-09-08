# 小小创客 · Kid Scratch App

给孩子用的 Scratch 桌面版：**本地运行、离线可用、自动保存**，套了一层更童趣的界面和一个可以自己往里放东西的素材库。

内核是官方 [`scratch-gui`](https://github.com/scratchfoundation/scratch-editor) 5.3.0 的预编译产物，所以积木、造型编辑器、声音编辑器和 `.sb3` 格式都跟官方 Scratch 3 完全一致。

---

## 安装（普通使用）

到 [Releases](https://github.com/cod7ce/kid-scratch-app/releases/latest) 下载 `KidScratch-<版本>-mac-arm64.dmg`（Apple Silicon），拖进「应用程序」。

App 没有 Apple Developer ID 签名，第一次打开会被 Gatekeeper 拦下，任选一种放行：

- 右键点 App 图标 → 「打开」 → 再点「打开」
- 或在终端执行：`xattr -dr com.apple.quarantine /Applications/小小创客.app`

放行一次之后，**以后的自动更新不会再弹这个提示**。

## 开发运行

```bash
npm install     # 只需第一次
npm start       # 打开 App
```

首次启动会在 `~/Documents/小小创客/` 下建好目录：

```
小小创客/
├── 我的作品/          每个作品一个文件夹
│   └── p20260908-.../
│       ├── project.sb3     作品本体（标准 Scratch 格式）
│       ├── meta.json       名字、创建/修改时间
│       ├── thumb.png       作品墙上的缩略图
│       └── 历史版本/        每 5 分钟一个存档，最多留 20 个
├── 我的素材/          放自己画的图 / 录的声音
│   ├── 角色/  背景/  声音/
└── 回收站/            删掉的作品先进这里，能找回来
```

## 功能

**作品墙（首页）**
- 大卡片 + 缩略图，点一下就进编辑器
- 新建 / 改名 / 复制 / 导出 `.sb3` / 删除（进回收站，不会真丢）
- 导入外部 `.sb3` / `.sb2` 文件

**编辑器**
- 完整的中文 Scratch 3 编辑器（界面语言在顶部菜单里还能改）
- 顶部自定义工具条：回作品墙、改名、保存状态、我的素材、历史版本、立即保存、全屏
- 童趣皮肤：糖果色菜单栏、更大的绿旗/停止按钮、圆角卡片和舞台

**自动保存**
- 停手 2.5 秒自动存；一直在画则每 45 秒兜底存一次
- 关窗前主进程会先要求编辑器落盘再退出
- `Cmd/Ctrl + S` 手动保存；顶部徽章实时显示「正在创作… / 保存中… / 已自动保存 · 3 分钟前」
- 写文件用「临时文件 + rename」，中途断电不会写坏原文件
- 每 5 分钟自动留一个历史版本，点「🕘 历史版本」可随时回退

**素材库**
- 内置 14 个角色、7 个背景、8 个音效（本仓库自制的 SVG / 合成音频，**完全离线**）
- 官方 Scratch 素材库照常可用：本地服务器做缓存代理，用过一次就永久离线可用
- 把图片放进 `我的素材/角色`（或 `背景`）、声音放进 `我的素材/声音`，点「🧺 我的素材」就能直接选用；也可以在弹窗里点「＋ 加素材」从文件选择器添加
- 支持 `svg / png / jpg / gif / bmp` 和 `wav / mp3 / ogg / m4a`；过大的位图会自动缩到舞台尺寸以内

## 完全离线使用

内置素材本来就在本地。如果想让**官方**素材库也离线可用，先跑一次：

```bash
npm run fetch-assets            # 全部下载，约 300~500MB
npm run fetch-assets -- 背景     # 也可以只下某一类：角色 / 造型 / 背景 / 声音
```

素材会存到 App 的缓存目录（macOS: `~/Library/Application Support/小小创客/scratch-asset-cache`），断点续传，重复运行会跳过已下载的。

## 自检

```bash
npm run selftest
```

会真的启动一次 App，逐项验证：编辑器挂载、中文界面、WebGL 渲染、素材代理、添加角色/背景/声音、自动保存链路、`.sb3` 落盘与读回、缩略图生成、版本号比较。当前 20/20 通过。

打包后的 App 也能这么测：

```bash
KID_SELFTEST=1 /Applications/小小创客.app/Contents/MacOS/小小创客
```

加上 `KID_SHOT_DIR=/tmp/shots` 还会顺便截三张图（编辑器 / 素材库 / 作品墙）。

## 自动更新

App 每 6 小时（以及启动后 20 秒）静默检查一次 GitHub Releases，发现新版本就在作品墙右下角弹一张卡片，点「更新」即可：下载 → 解压 → 原地替换 App → 自动重启。也可以从菜单「小小创客 → 检查更新…」或作品墙页脚的「检查更新」手动触发。

实现在 `electron/updater.js`，**没有用 `electron-updater`**：它在 macOS 上依赖 Squirrel.Mac，而 Squirrel.Mac 要求 App 有有效的 Developer ID 签名；本项目只有 Apple Development 证书，所以改成直接读 GitHub Releases API + 自己做替换。替换脚本会先把旧 App 改名备份，`ditto` 成功才删备份，失败则回滚，不会把 App 弄坏。

调试用：`KID_UPDATE_FORCE=1 /Applications/小小创客.app/Contents/MacOS/小小创客` 会跳过等待，启动即检查，有新版就直接装。

> 如果以后买了 Apple Developer 账号（Developer ID + 公证），可以换回 `electron-updater`，会更省流量（支持差分更新）。

**已实测**：装好的旧版 App 能自动发现新版 → 下载约 139MB → 解压 → 原地替换 → 自动重启，升级完成后 20 项自检全部通过。

## 打包 & 发布

```bash
npm run dist        # 本地打包，产物在 release/：.dmg / .zip / latest-mac.yml
npm run icon        # 重新生成 build/icon.png 和 icon.icns
```

发新版本只要打个 tag，GitHub Actions 会自动构建并上传到 Release：

```bash
npm version patch          # 或 minor / major，改 package.json 并打好 tag
git push --follow-tags     # 推 tag 触发 CI，构建完自动发布
```

要在本地发布（`npm run release`），**必须先把 tag 推上去**——配置里 `releaseType: "release"` 表示直接发正式版，
而 GitHub 要求正式 Release 的 tag 必须已存在（草稿模式才会顺手建 tag）：

```bash
npm version patch && git push --follow-tags
npm run release
```

工作流在 `.github/workflows/release.yml`（macOS arm64；要出 Intel 版把 `mac.target` 的 arch 加上 `x64`，要出 Windows 版加一个 `windows-latest` 的 job 跑 `--win`）。

`.zip` 是自动更新用的，`.dmg` 是给人下载的，两个都会传。

## 体积

打包后 App 约 305MB、安装包约 140MB。其中 Electron 运行时占大头，`scratch-gui` 的预编译产物约 52MB。
构建时用 `files` 白名单只挑 `node_modules/scratch-gui/dist/**`（否则 electron-builder 会把 scratch-gui 的 700 多个构建期依赖也打进去，app.asar 会从 51MB 涨到 481MB），并剔除了 10 种用不到的语言的教程截图。

## 技术要点

- **Electron 主进程** (`electron/main.js`)：窗口、菜单、文件读写 IPC、关窗前强制落盘
- **本地 HTTP 服务器** (`electron/server.js`)：随机端口只监听 `127.0.0.1`，托管界面 + `scratch-gui` 产物 + 素材；用 http 而不是 `file://` 是因为 scratch-gui 依赖 fetch、Worker 和跨目录资源
  - `/scratch-assets/internalapi/asset/<md5ext>/get/` 是官方素材的缓存代理：先查本地，未命中才联网并落盘
  - `/static/` 额外挂了一份 `dist/static`，因为 scratch-blocks 内部写死了相对路径 `./static/blocks-media/...`
- **渲染进程** (`renderer/js/editor.js`)：用 UMD 方式加载 `scratch-gui.js`（它把 react / react-dom 作为外部依赖，读的是小写全局 `window.react`）
  - `projectId: 0` 让 GUI 加载内置的默认作品（离线）
  - `assetHost` / `projectHost` 必须走 props——`ProjectFetcherHOC` 挂载时会用 props 覆盖 storage 上的设置
  - `onVmInit` 拿到 VM 实例，`PROJECT_CHANGED` 事件驱动自动保存
- **安全**：`contextIsolation` 开、`nodeIntegration` 关，渲染进程只能通过 preload 暴露的白名单 API 访问文件；外链一律交给系统浏览器

## 许可证与声明

本项目以 **AGPL-3.0-only** 发布（见 `LICENSE`）——因为内嵌了同样是 AGPL-3.0 的 `scratch-gui` 预编译产物，衍生作品必须沿用。完整的第三方声明见 `NOTICE`。

Scratch 是 MIT 媒体实验室 Scratch 团队的项目和商标。本 App 只是给自家孩子做的一层本地外壳，**不隶属于、也未获 Scratch 团队背书**。作品文件是标准 `.sb3`，随时可以拿到官方 scratch.mit.edu 上继续用。
