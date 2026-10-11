// 用例 04：去广告（自动 + 手动）、样本比对、命中统计
import fs from 'node:fs';
import path from 'node:path';
import { startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

/** 构造「广告样本」目录：ad/<pattern>/{000001.ts,000002.ts} */
const writeAdSamples = (dataDir, pattern, buffers) => {
  const dir = path.join(dataDir, 'data', 'ad', pattern);
  fs.mkdirSync(dir, { recursive: true });
  buffers.forEach((buffer, index) => {
    fs.writeFileSync(path.join(dir, `${String(index + 1).padStart(6, '0')}.ts`), buffer);
  });
  return dir;
};

export default {
  id: '04',
  title: '去广告：自动/手动扫描、命中剔除与统计',
  covers: [
    '按大小+哈希匹配广告样本并移除切片',
    '命中切片移动到 removed_ads/ 并从清单剔除',
    'adRemovedSegments 与 adScan 命中统计',
    '自动合并时只扫描一次（避免命中数被覆盖）',
    '手动 /remove-ads 接口',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('ads');
    const cdnDir = ctx.temp('ads-cdn');
    const buffers = writeFakePlaylist(cdnDir, ['a0', 'ad1', 'ad2', 'a3']);
    const cdn = await startCdn(ctx, cdnDir);
    writeAdSamples(dataDir, 'testad', [buffers[1], buffers[2]]);
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = path.join(dataDir, 'data', 'temp');

    // 1) 自动去广告（不自动合并）
    const task = await api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('media.m3u8'),
      outputName: 'ads.mp4',
      tempRoot,
      concurrency: 2,
      retries: 0,
      autoMerge: false,
      removeAds: true,
    });
    const scanned = await api.waitFor(task.id, ['downloaded', 'failed']);
    await ctx.check('任务完成', scanned.status === 'downloaded', `${scanned.status} ${scanned.error || ''}`);
    await ctx.check('命中并移除 2 个广告切片', scanned.adRemovedSegments === 2, String(scanned.adRemovedSegments));
    await ctx.check('adScan 记录样本数与命中段数', (scanned.adScan?.patterns || 0) >= 1 && scanned.adScan?.matches === 1 && scanned.adScan?.removedSegments === 2, JSON.stringify({ patterns: scanned.adScan?.patterns, matches: scanned.adScan?.matches, removed: scanned.adScan?.removedSegments }));
    await ctx.check('切片统计包含 ad_removed（4 片）', scanned.doneSegments === 4, String(scanned.doneSegments));
    const removedDir = path.join(scanned.tempDir, 'removed_ads', 'testad');
    await ctx.check('广告切片被移动到 removed_ads/', fs.existsSync(removedDir) && fs.readdirSync(removedDir).length === 2, fs.existsSync(removedDir) ? fs.readdirSync(removedDir).join(',') : '目录不存在');

    // 2) 老实现会在 merge 时二次扫描并把 matches 覆盖为 0
    await api.post(`/api/tasks/${task.id}/merge`);
    const merged = await api.waitFor(task.id, ['success', 'partial', 'failed']);
    await ctx.check('合并后仍为 success', merged.status === 'success', `${merged.status} ${merged.error || ''}`);
    await ctx.check('adScan.matches 未被二次扫描覆盖', merged.adScan?.matches === 1, JSON.stringify({ matches: merged.adScan?.matches, patterns: merged.adScan?.patterns }));

    // 3) 手动去广告
    const manual = await api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('media.m3u8'),
      outputName: 'manual.mp4',
      tempRoot,
      concurrency: 2,
      retries: 0,
      autoMerge: false,
      removeAds: false,
    });
    const beforeScan = await api.waitFor(manual.id, ['downloaded', 'failed']);
    await ctx.check('关闭去广告时不扫描', beforeScan.adRemovedSegments === 0 && beforeScan.adScan === null, JSON.stringify({ removed: beforeScan.adRemovedSegments, scan: beforeScan.adScan }));
    const result = await api.post(`/api/tasks/${manual.id}/remove-ads`);
    await ctx.check('手动去广告返回命中结果', result.result?.matches === 1 && result.result?.removedSegments === 2, JSON.stringify(result.result));
    await ctx.check('手动去广告后任务状态更新', result.task.adRemovedSegments === 2, String(result.task.adRemovedSegments));

    // 4) 无可扫描切片时应报错
    const busy = await api.request(`/api/tasks/${task.id}/remove-ads`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await ctx.check('已合并任务再手动去广告被拒绝', busy.res.status === 500 && /not ready|busy/.test(String(busy.body.error)), JSON.stringify(busy.body));
  },
};
