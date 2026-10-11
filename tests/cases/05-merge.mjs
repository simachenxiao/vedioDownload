// 用例 05：合并（concat 回退）、本地清单、批量合并、partial 语义
import fs from 'node:fs';
import path from 'node:path';
import { startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '05',
  title: '合并：local.m3u8、concat 回退、批量合并、partial',
  covers: [
    '手动合并生成成品并记录 mergeEngine',
    'local.m3u8 仅包含 done 切片与 TARGETDURATION',
    '重复合并被拒绝（no downloaded segments）',
    '存在失败切片时合并结果为 partial',
    '/api/tasks/bulk/merge 批量合并',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('merge');
    const cdnDir = ctx.temp('merge-cdn');
    const buffers = writeFakePlaylist(cdnDir, ['m0', 'm1', 'm2', 'm3']);
    const cdn = await startCdn(ctx, cdnDir);
    const failDir = ctx.temp('merge-fail');
    writeFakePlaylist(failDir, ['p0', 'p1', 'p2']);
    const failCdn = await startCdn(ctx, failDir, { failFirst: { 'seg1.ts': 99 } });
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = path.join(dataDir, 'data', 'temp');
    const base = { resourceType: 'other', tempRoot, autoMerge: false, removeAds: false };

    // 1) 手动合并
    const task = await api.create({ ...base, m3u8Url: cdn.url('media.m3u8'), outputName: 'merged.mp4', concurrency: 2, retries: 0 });
    const downloaded = await api.waitFor(task.id, ['downloaded', 'failed']);
    await ctx.check('下载完成待合并', downloaded.status === 'downloaded', `${downloaded.status} ${downloaded.error || ''}`);
    await ctx.check('未合并时无成品路径', !downloaded.outputPath && fs.existsSync(downloaded.tempDir));

    await api.post(`/api/tasks/${task.id}/merge`);
    const merged = await api.waitFor(task.id, ['success', 'partial', 'failed']);
    const expectedBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    await ctx.check('合并成功', merged.status === 'success', `${merged.status} ${merged.error || ''}`);
    await ctx.check('mergeEngine 记录为 concat（无 ffmpeg 回退）', merged.mergeEngine === 'concat', merged.mergeEngine);
    await ctx.check('成品存在且大小等于切片总和', !!merged.outputPath && fs.existsSync(merged.outputPath) && fs.statSync(merged.outputPath).size === expectedBytes, `${merged.outputPath} size=${merged.outputSize}`);
    await ctx.check('completedAt 已写入', !!merged.completedAt);

    const localManifest = fs.readFileSync(path.join(merged.tempDir, 'local.m3u8'), 'utf8');
    await ctx.check('local.m3u8 含 4 个切片与 ENDLIST', localManifest.includes('#EXTM3U') && localManifest.includes('#EXT-X-ENDLIST') && localManifest.split('\n').filter(l => l.endsWith('.ts')).length === 4, `切片行=${localManifest.split('\n').filter(l => l.endsWith('.ts')).length}`);
    await ctx.check('local.m3u8 声明 TARGETDURATION', /#EXT-X-TARGETDURATION:\d+/.test(localManifest));

    const again = await api.request(`/api/tasks/${task.id}/merge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await ctx.check('已合并任务重复合并被拒绝', again.res.status === 500 && /not ready/.test(String(again.body.error)), JSON.stringify(again.body));

    // 2) partial：有失败切片时合并已下载部分
    const partialTask = await api.create({ ...base, m3u8Url: failCdn.url('media.m3u8'), outputName: 'partial.mp4', concurrency: 2, retries: 0 });
    const failedTask = await api.waitFor(partialTask.id, ['failed', 'downloaded']);
    await ctx.check('存在失败切片', failedTask.status === 'failed' && failedTask.failedSegments === 1, `${failedTask.status} ${failedTask.failedSegments}`);
    await api.post(`/api/tasks/${partialTask.id}/merge`);
    const partial = await api.waitFor(partialTask.id, ['partial', 'success', 'failed']);
    await ctx.check('失败任务合并结果为 partial', partial.status === 'partial', `${partial.status} ${partial.error || ''}`);
    await ctx.check('partial 成品只含成功切片', !!partial.outputPath && fs.statSync(partial.outputPath).size === buffers[0].length + buffers[2].length, String(partial.outputSize));

    // 3) 批量合并
    const bulkA = await api.create({ ...base, m3u8Url: cdn.url('media.m3u8'), outputName: 'bulk-a.mp4', concurrency: 2, retries: 0 });
    const bulkB = await api.create({ ...base, m3u8Url: cdn.url('media.m3u8'), outputName: 'bulk-b.mp4', concurrency: 2, retries: 0 });
    await api.waitFor(bulkA.id, ['downloaded', 'failed']);
    await api.waitFor(bulkB.id, ['downloaded', 'failed']);
    const bulk = await api.post('/api/tasks/bulk/merge');
    await ctx.check('批量合并启动待合并任务且无失败', bulk.started >= 2 && bulk.failed === 0, JSON.stringify(bulk));
    const bulkDoneA = await api.waitFor(bulkA.id, ['success', 'partial', 'failed']);
    const bulkDoneB = await api.waitFor(bulkB.id, ['success', 'partial', 'failed']);
    await ctx.check('批量合并任务均 success', bulkDoneA.status === 'success' && bulkDoneB.status === 'success', `${bulkDoneA.status}/${bulkDoneB.status}`);

    const stats = await api.stats();
    await ctx.check('统计 completed 包含 partial 与 success', stats.completed === 4, JSON.stringify(stats));
  },
};
