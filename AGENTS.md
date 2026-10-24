# AGENTS.md

本文件面向在本仓库工作的 AI 编程代理与开发者，说明项目结构、开发/验证命令、打包流程和代码约定。改动前请先通读。

## 项目简介

VDL 是一个**飞牛 NAS（fnOS）第三方应用**：m3u8 视频下载工具。零第三方依赖，后端纯 Node.js（ESM，内置模块），前端原生 HTML/CSS/JS。功能包括：采集站播放器地址解析、m3u8 切片并发下载、失败重试、按样本指纹去广告、ffmpeg 合并 mp4、成品移动与任务统计。

- 应用名：`vdl`
- 依赖运行时：`nodejs_v24`（见 `manifest`）
- 当前版本：写在 `manifest` / `package.json` / `ui/server.js` 的 `VERSION`，三处需保持一致

## 目录结构

```
manifest              飞牛应用元数据（appname/version/desktop_uidir 等）
package.json          仅本机开发用；fnpack 不会打进 fpk
icon.png / icon_256.png / ui/images/   图标（打包后变成顶层 ICON.PNG / ICON_256.PNG）
cmd/                  生命周期脚本：main(start/stop/status) + install/upgrade/uninstall 回调
config/privilege      以 package 用户运行
config/resource       资源声明（空对象）
ui/config             桌面入口（iframe，/app/vdl/，gatewaySocket vdl.sock）
wizard/uninstall      卸载向导（保留/删除数据）
ad/NN/*.ts            去广告样本（git 忽略，且默认不打进 fpk）
ui/server.js          后端全部逻辑（HTTP + Unix socket、REST、SSE、下载/合并/去广告/移动/播放）
ui/index.html         单页界面
ui/main.js            前端逻辑（fetch + SSE + 渲染）
ui/styles.css         样式（tasteskill achromatic-ledger：蓝灰地面 + 唯一色相 #1d5fbf）
ui/fonts/             自托管 Geist（woff2，离线可用，勿依赖 Google Fonts）
tests/                回归测试：run.mjs 执行器 + harness.mjs 工具 + cases/ 用例 + README.md 用例清单
tests/tools/          辅助脚本（如未引用声明扫描 dead-code.mjs）
vdl.fpk               构建产物（git 忽略）
.runtime-*/           本地测试临时目录（git 忽略；用例现场在 .runtime-tests/）
```

## 常用命令

### 回归测试（改动后必跑）

```bash
npm test                    # 全量回归用例（11 个用例 / 130+ 断言，约 30s）
npm run test:list           # 列出用例清单
node tests/run.mjs --only=03,06        # 只跑指定用例
node tests/run.mjs --filter=播放 --verbose   # 按关键字过滤并打印每条断言
```

- 用例清单、手动用例、改动流程见 **`tests/README.md`**。
- **规则：新增/修改功能必须同步更新 `tests/cases/` 与 `tests/README.md` 的清单和变更记录，然后跑全量用例。**
- 用例自带临时数据目录与本地假 CDN，不依赖外网；默认让 `FFMPEG_BIN` 指向不存在路径以稳定走 `concat` 回退（真实 ffmpeg 由用例 11 覆盖，缺失时自动 SKIP）。
- 提交前建议另跑 `node tests/tools/dead-code.mjs` 检查未被引用的顶层声明。

### 本地运行（开发）

```bash
# Linux/macOS
TRM_PKGVAR=/tmp/vdl-data PORT=19635 node ui/server.js

# Windows PowerShell
$env:TRM_PKGVAR="D:/tmp/vdl-data"; $env:PORT="19635"; node ui/server.js
```

访问 `http://localhost:19635/`。

关键环境变量（`ui/server.js` 顶部）：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `TRM_PKGVAR`（或 `TRIM_PKGVAR`） | 应用数据目录父级，数据放 `$TRM_PKGVAR/data` | 无 |
| `PORT` | HTTP 端口 | `9635` |
| `FFMPEG_BIN` | ffmpeg 可执行文件路径 | `/usr/bin/ffmpeg` |
| `VDL_NO_START` | 设为 `1` 时导入 `ui/server.js` 不启动服务（供测试/脚本 import） | 无 |

> ⚠️ 未设置 `TRM_PKGVAR` 时，`DATA_DIR = <仓库父目录>/data`，即 `path.dirname(仓库根)` 下，不是仓库内。开发时务必显式设置，避免污染。

### 语法检查

```bash
node --check ui/server.js
node --check ui/main.js
```

### 打包 fpk

```bash
# 在仓库根目录执行；fnpack 会遵循 .gitignore，ad/、.runtime-*/、vdl.fpk 不会入包
../fnpack-1.2.3-windows-amd64.exe build -d .   # Windows
fnpack build -d .                              # 其他平台
```

产物 `vdl.fpk`（约 70KB，不含广告样本）。

注意：
- fnpack **不会**把 `package.json` 打进 `app.tgz`。Node v24 靠 ESM 语法自动探测仍可运行 `ui/server.js`，不要因此判定打包异常。
- 若要让 fpk 自带去广告样本，需先把 `ad/` 从 `.gitignore` 移除或改用其他打包方式（会显著增大体积）。
- 修改功能后应同步升 `manifest` 的 `version`（fnOS 以版本判断升级）。

## 后端架构（`ui/server.js`）

单文件，无依赖，主要模块：

- **数据/日志**：`DATA_DIR` 下 `tasks.json`（原子写入）、`temp/`、`output/`、`ad/`；日志 `$TRM_PKGVAR/info.log`。
- **服务**：HTTP `0.0.0.0:PORT` + Unix socket `vdl.sock`（Windows 跳过 socket），两套监听同一 `handle`。
- **BASE_PATH**：`/app/vdl`，请求会去掉该前缀再路由。
- **实时推送**：`GET /api/events` 用 SSE 广播 `task` / `stats` / `delete`。

### REST API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` `/api/defaults` `/api/stats` `/api/tasks` | 健康检查/默认配置/统计/任务列表 |
| GET | `/api/tasks/:id` | 单任务（含切片进度） |
| POST | `/api/tasks` | 新建任务（见下方资源类型） |
| POST | `/api/tasks/:id/{retry,pause,resume,stop,merge,remove-ads,move}` | 任务操作 |
| GET/HEAD | `/api/tasks/:id/video` | 播放成品（支持 `Range`，206/416；取 `movedPath`/`outputPath`） |
| DELETE | `/api/tasks/:id` | 删除任务并清理临时目录（已移动的成品不删） |
| POST | `/api/tasks/bulk/{delete,move,merge}` | 批量操作 |
| GET | `/api/browse?path=` | 浏览目录（移动目标选择用） |

### 资源类型（`resourceType`）

| 值 | 含义 | 解析方式 |
| --- | --- | --- |
| `ruyi` | 如意资源 | 播放器 URL 的 `source` → `CMS_APIS.ruyi`（`cj.rycjapi.com`） |
| `bfzy` | 暴风资源 | `source=bfzy` → `CMS_APIS.bfzy`（`bfzyapi.com`） |
| `other` | 直接 m3u8 | 用 `m3u8Url` + 可选 `baseUrl` |

- 新增采集站：在 `CMS_APIS` 加一项、`isCmsType` 同步、前端 `resourceType` 下拉加选项即可，其余逻辑复用 `resolveCmsEpisodes`。
- 单集：LibreTV 播放器 URL 的 `url` 参数直接作为源；全集：按 `id` 调采集站 `ac=videolist&ids=` 拿 `vod_play_url` 解析。
- **部分**：先按全集解析出完整剧集列表，再用 `episodeSelect`（1-based 集号表达式：`1;2;4`、`2-6`、`1,3-5`，支持 `; , ， ； 空格` 与 `- ~`）取子集，`parseEpisodeSelection(expression, total)` 负责校验（超总集数报错），仍走同一 `batchId` 批次排队；`episodeIndex` 保留原集号。
- 采集站任务 `baseUrlOverride` 为空，切片 base 由 m3u8 自身位置推导。

### 任务状态机

`waiting → pending → downloading → downloaded → merging → success | partial | failed`，另有 `paused` / `stopped` / `moved` / `moving`。重启时进行中的任务会被改回 `paused`。批量（全集）用 `batchId` + `batchConcurrency` 排队，`scheduleBatch` 调度。

### 下载与合并

- 列表接口与 SSE 的任务对象带 `segmentStrip`（40 格：`d` 完成、`a` 去广告、`f` 失败、`p` 未完成），由 `apiTask()` 生成，**不写入 tasks.json**。
- 解析 master playlist 自动选最高码率，支持 `EXT-X-KEY`（下载密钥）与 `EXT-X-MAP`。
- 并发 worker 池（`concurrency`），失败重试 `retries`，写 `.part` 后 rename；已存在的非空切片直接标记 `done`（断点续传）。
- 合并：先生成 `local.m3u8`，优先 `ffmpeg -c copy -bsf:a aac_adtstoasc`，失败回退为裸 `concat`（`mergeEngine` 记录 `ffmpeg`/`concat`）。
- 去广告：`ad/` 或 `$DATA_DIR/ad/` 下样本按「大小 + SHA-256 逐片滚动比对」，命中的切片移入 `removed_ads/` 并从清单剔除（`removeAds` 开关）。

## 编码约定

- 全程 ESM（`import`/`export`），`'use strict'`；不使用可选链之外的新语法糖以外的东西，避免引入依赖。
- 路径拼接一律走 `safeJoinUnder`/`sanitizeName`，防止路径穿越与非法文件名。
- 用户可见文案用中文；标识符、注释可用英文，但本仓库注释以中文为主。
- 前端 `API_BASE` 需兼容 `/app/vdl` 前缀；新增接口记得同步 `ui/main.js` 与 SSE 刷新。
- 提交信息用英文、祈使句（如 `Add ...` / `Fix ...`）。
- **可点元素必须可辨识**：静止状态就要有底色或描边（`.btn` / `.row-action` / `.kebab` / `.icon-btn` 用 `--control-bg` + `--control-border`），不能只靠文字；`button:focus-visible` 提供焦点环，悬停/按下有底色变化。新增按钮时复用这些类，不要写裸文字按钮。

## 验证清单（改动后必做）

1. **`npm test` 全量用例全绿**（含本次新增/修改功能的用例）；接口/功能变化要同步改 `tests/cases/` 与 `tests/README.md` 清单。
2. 三处版本号保持一致：`manifest`、`package.json`、`ui/server.js` 的 `VERSION`（用例 01 会校验）。
3. 涉及 UI 的手动用例：弹窗播放、播放按钮显隐、SSE 实时刷新、目录选择器（见 `tests/README.md` 手动用例表）。
4. `fnpack build -d .`，解包 `vdl.fpk` 核对 `manifest` 版本、`app.tgz` 内容与是否夹带 `ad/`、`.runtime-*/`。
