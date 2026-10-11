# VDL 回归测试

本目录是 **VDL 的回归测试用例集合**。规则很简单：

> **每次新增/修改功能，都必须同步更新 `tests/cases/` 下的用例，并更新本文件的用例清单与变更记录；
> 提交前跑一遍 `npm test`（全量用例）。**

## 运行方式

```bash
npm test                 # 跑全部用例（约 30 秒）
npm run test:list        # 只列用例清单
node tests/run.mjs --verbose              # 打印每条断言
node tests/run.mjs --only=03,06           # 只跑指定编号
node tests/run.mjs --filter=播放          # 按编号/标题/覆盖点关键字过滤
```

- 用例互不干扰：每个用例使用 `.runtime-tests/` 下的独立临时数据目录与独立端口（19700 起）。
- 用例**不访问外网**：采集站相关逻辑用 `episodes` 参数与本地 CDN 完成，不依赖 `cj.rycjapi.com` 等真实接口。
- 用例默认把 `FFMPEG_BIN` 指向不存在的路径，让合并稳定走 `concat` 回退；
  真实 ffmpeg 路径由用例 11 单独覆盖（检测不到 ffmpeg 时自动 SKIP）。
  本地若想指定 ffmpeg：`TEST_FFMPEG_BIN=/path/to/ffmpeg npm test`。
- 失败时会保留 `.runtime-tests/` 现场（临时目录、tasks.json）方便排查；全部通过时自动清理。
- 用例服务端日志会写进 `$TRM_PKGVAR/info.log`，失败时执行器会打印日志尾部。

## 自动化用例清单

| 编号 | 用例 | 主要覆盖点 | 变更时需要留意 |
| --- | --- | --- | --- |
| 01 | 语法、版本一致性、静态资源与路由前缀 | `node --check`；`manifest`/`package.json`/`VERSION` 三处同步；首页与 CSS/图片；路径穿越拦截；未知 API 404；`/app/vdl` 前缀与 308 | 改版本、改静态资源、加路由前缀相关逻辑 |
| 02 | 基础 API | `/api/health`（版本、dataDir）；`/api/defaults` 字段；空统计；`/api/browse` 列举/排序/错误；建任务参数校验（非法 m3u8、非法 base、m3u8 拉取失败） | 改默认配置、改 browse、改建任务校验 |
| 03 | 切片下载 | 并发下载完成；`downloadedBytes`/`progress`；切片落盘无 `.part`；**断点续传**（已落盘切片不再请求）；失败自动重试次数；重试耗尽标记 `failed` | 改下载 worker、重试、断点续传判断 |
| 04 | 去广告 | 自动扫描命中并移除；`removed_ads/` 落盘；`adScan` 命中统计；**合并时不再二次扫描**；手动 `/remove-ads`；状态不允许时报错 | 改样本匹配、`adScan`、去广告触发时机 |
| 05 | 合并 | 手动合并产出成品；`mergeEngine=concat` 回退；`local.m3u8` 内容与 `TARGETDURATION`；重复合并被拒；有失败切片时 `partial`；批量 `/bulk/merge` | 改合并逻辑、清单生成、批量操作 |
| 06 | 播放 | `GET /video` 200 + `Accept-Ranges` + `Content-Type`；整段内容校验；`HEAD`；Range 206（首段/尾部）；越界 416；**movedPath 优先**；任务不存在 404 | 改播放接口、Range 解析、成品路径选择 |
| 07 | 移动 | 单个移动 + 自动建目录；`outputPath` 清空；重复移动幂等（不卡在 `moving`）；批量移动；非法目标目录；未合并任务报错 | 改 `startMoveTask`/`moveTaskAsync`、批量移动 |
| 08 | 任务控制与删除 | 暂停保留进度且不再推进；继续下载完成；停止 `stopped` 后可继续；`retry`；删除清理临时目录；**已移动成品不删**；批量删除与统计归零 | 改暂停/停止/继续、删除清理 |
| 09 | 地址解析 | `parseEpisodeList` 多来源与命名；LibreTV/KVideo 单集解析；`episodes` 参数；非法地址报错；**部分下载表达式解析**（`1;2;4`、`2-6`、去重排序、非法/超范围报错）；master 选最高码率；`EXT-X-KEY` 解析；**密钥下载 + 本地清单写 KEY**；全集/部分批量建任务、集号保留与批次排队 | 改采集站解析、切片解析、密钥、批次调度、**集数选择表达式** |
| 10 | SSE 与重启恢复 | `/api/events` 首推 `stats`；`task`/`delete` 事件；事件不带切片明细；重启后 `downloading → paused`；保留进度并可继续完成 | 改 `updateTask`/`broadcast`/`loadTasks` |
| 11 | 真实 ffmpeg 合并（可 SKIP） | `mergeEngine=ffmpeg`；成品能被 ffmpeg 解码；时长与切片一致 | 改 ffmpeg 参数/合并流程（无 ffmpeg 环境会自动跳过） |

## 手动用例清单（UI / 打包，无法自动化）

| 编号 | 场景 | 步骤 | 预期 |
| --- | --- | --- | --- |
| M1 | 弹窗播放 | 列表中点已合并任务的【播放】 | 弹窗内自动播放，可拖动进度、全屏；关闭后停止播放 |
| M2 | 播放按钮显隐 | 观察 `success/partial/moved` 与未合并任务 | 仅已合并且成品存在的任务显示【播放】 |
| M3 | SSE 实时刷新 | 页面挂着时新建任务 / 删除任务 | 列表与统计数字自动更新，无需手动刷新 |
| M4 | 目录选择器 | 移动/一键移动 → 选择目录 | 可浏览、进入子目录、上一级、选择当前目录、错误提示正常 |
| M5 | 去广告开关 | 不改样本，仅开关「下载完成后去除广告」 | 关闭时不扫描（`adScan` 为 null）；开启时命中数正确显示 |
| M6 | 打包与安装 | `fnpack build -d .` → 检查 `vdl.fpk` | manifest 版本与代码一致；`app.tgz` 未夹带 `ad/`、`.runtime-*/`；fnOS 上桌面入口可打开、`vdl.sock` 正常 |
| M7 | 卸载向导 | 安装后卸载 | 「保留数据/删除数据」行为符合 wizard 描述 |
| M8 | 部分下载 | 资源类型选如意/暴风 → 下载范围选「部分」 | 出现「选择集数」输入框与提示文案；填 `1;2;4`、`2-6` 能按集创建任务；选其他范围时输入框隐藏；填超范围集数时提示「该剧共 N 集」 |

## 每次改动的标准回归流程

1. `npm test` —— 全量用例必须全绿（含新增用例）。
2. 若改了接口/功能：在 `tests/cases/NN-*.mjs` 追加或修改断言，并更新上面两张清单。
3. 三处版本号同步：`manifest`、`package.json`、`ui/server.js` 的 `VERSION`（用例 01 会校验）。
4. `fnpack build -d .`，解包核对 `manifest` 与 `app.tgz`（用例无法覆盖打包，按 M6 手动确认）。
5. 涉及 UI 时按 M1–M5 手动过一遍；发布前按 M6/M7 确认。

## 新增功能时如何加用例

1. 在 `tests/cases/` 新建 `NN-功能名.mjs`（编号顺延，文件名排序即执行顺序），或在最相关的既有用例里补断言。
2. 使用 `tests/harness.mjs` 的工具：`startServer` / `startCdn` / `writeFakePlaylist` / `writeRealPlaylist` / `findFfmpeg` / `makeClient` / `segmentBuffer`。
3. 模板：

```js
import path from 'node:path';
import { startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '12',
  title: '新功能的一句话描述',
  covers: ['覆盖点 1', '覆盖点 2'],   // 会出现在 --list 与过滤器里
  async run(ctx) {
    const dataDir = ctx.temp('feature');          // 自动清理的临时数据目录
    const cdnDir = ctx.temp('feature-cdn');
    writeFakePlaylist(cdnDir, ['f0', 'f1']);      // 生成假切片与 media.m3u8
    const cdn = await startCdn(ctx, cdnDir);      // 本地 CDN，可 delayMs / failFirst
    const server = await startServer(ctx, { dataDir });
    const { api } = server;

    const task = await api.create({              // 常用任务字段
      resourceType: 'other', m3u8Url: cdn.url('media.m3u8'),
      outputName: 'feature.mp4', tempRoot: path.join(dataDir, 'data', 'temp'),
      concurrency: 2, retries: 0, autoMerge: false, removeAds: false,
    });
    const done = await api.waitFor(task.id, ['downloaded', 'failed']);

    await ctx.check('断言名称（中文，说明预期）', done.status === 'downloaded', `实际=${done.status}`);
  },
};
```

4. 断言约定：
   - `ctx.check(名称, 条件或返回布尔的函数, 失败时的实际值)`；名称写清"预期什么"，detail 写实际值。
   - 不要断言随机/时序相关的精确值（例如下载中切片数）；需要稳定性时先 `pause` 或使用 `delayMs` 控制节奏。
   - 需要外部能力（ffmpeg 等）时用 `ctx.skip('原因')` 跳过而不是直接失败。
   - 不要访问外网；想验证采集站逻辑请用 `episodes` 参数或 `VDL_NO_START=1` 导入 `ui/server.js` 的导出函数（见用例 09）。

## 变更记录（新增功能时追加一行）

| 版本 | 用例变更 | 说明 |
| --- | --- | --- |
| 0.2.1 | 新增 06（当时为 e2e 脚本） | 新增「播放」按钮与 `GET /api/tasks/:id/video`（Range 播放） |
| 0.2.2 | 整理为 tests/ 用例集：01–10 | 死代码清理与优化后建立全量回归；修复去广告重复扫描、移动幂等卡 `moving` |
| 0.2.3 | 新增 11；04 增加"合并不二次扫描"断言 | 引入 `needsAdScan`（合并时不再重复扫描已扫描过的任务）；建立本清单与运行器 |
| 0.2.4 | 09 新增部分下载表达式 8 条断言与全集/部分批次用例；01 新增 UI 接线断言；新增手动用例 M8 | 新增「部分」下载范围（`1;2;4`、`2-6`，支持 `; , ， ； 空格` 与 `- ~`，超出总集数报错） |
