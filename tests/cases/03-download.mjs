// 用例 03：切片下载 / 断点续传 / 失败重试
import fs from 'node:fs';
import path from 'node:path';
import { segmentBuffer, sleep, startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

const tempRootOf = dataDir => path.join(dataDir, 'data', 'temp');

export default {
  id: '03',
  title: '切片下载、断点续传、失败重试与失败统计',
  covers: [
    '并发下载全部切片并标记 downloaded',
    'downloadedBytes / doneSegments / progress 统计',
    '暂停后已落盘切片跳过重新下载（断点续传）',
    '失败切片自动重试成功',
    '重试耗尽后标记 failed 并记录错误',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('download');
    const cdnDir = ctx.temp('download-cdn');
    const buffers = writeFakePlaylist(cdnDir, ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    const cdn = await startCdn(ctx, cdnDir);
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = tempRootOf(dataDir);
    const base = { resourceType: 'other', tempRoot, autoMerge: false, removeAds: false };

    // 1) 正常下载
    const task = await api.create({ ...base, m3u8Url: cdn.url('media.m3u8'), outputName: 'dl.mp4', concurrency: 3, retries: 0 });
    const done = await api.waitFor(task.id, ['downloaded', 'failed']);
    const expectedBytes = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    await ctx.check('全部切片下载完成', done.status === 'downloaded' && done.doneSegments === 8 && done.failedSegments === 0, `${done.status} ${done.doneSegments}/${done.totalSegments}`);
    await ctx.check('progress 为 100', done.progress === 100, String(done.progress));
    await ctx.check('downloadedBytes 等于切片总大小', done.downloadedBytes === expectedBytes, `${done.downloadedBytes}/${expectedBytes}`);
    const segmentFiles = fs.readdirSync(path.join(done.tempDir, 'segments')).filter(f => f.endsWith('.ts'));
    await ctx.check('切片全部落盘且无 .part 残留', segmentFiles.length === 8 && !fs.readdirSync(path.join(done.tempDir, 'segments')).some(f => f.endsWith('.part')), segmentFiles.join(','));

    // 2) 断点续传：暂停后手工补一个未完成切片，继续时不应再请求该切片
    const slowDir = ctx.temp('download-slow');
    writeFakePlaylist(slowDir, ['s0', 's1', 's2', 's3', 's4', 's5']);
    const slowCdn = await startCdn(ctx, slowDir, { delayMs: 400 });
    const resumeTask = await api.create({ ...base, m3u8Url: slowCdn.url('media.m3u8'), outputName: 'resume.mp4', concurrency: 1, retries: 0 });
    await sleep(500);
    const paused = (await api.post(`/api/tasks/${resumeTask.id}/pause`)).task;
    const pokePath = path.join(resumeTask.tempDir, 'segments', '000005.ts');
    fs.writeFileSync(pokePath, segmentBuffer('s5'));
    await api.post(`/api/tasks/${resumeTask.id}/resume`);
    const resumed = await api.waitFor(resumeTask.id, ['downloaded', 'failed']);
    await ctx.check('暂停任务状态为 paused', paused.status === 'paused', paused.status);
    await ctx.check('继续后补齐剩余切片', resumed.status === 'downloaded' && resumed.doneSegments === 6, `${resumed.status} ${resumed.doneSegments}/6`);
    await ctx.check('已落盘切片不再重复请求（断点续传）', (slowCdn.hits.get('seg5.ts') || 0) === 0, `seg5 请求次数=${slowCdn.hits.get('seg5.ts') || 0}`);

    // 3) 失败重试：seg1 首次失败
    const retryDir = ctx.temp('download-retry');
    writeFakePlaylist(retryDir, ['r0', 'r1', 'r2']);
    const retryCdn = await startCdn(ctx, retryDir, { failFirst: { 'seg1.ts': 2 } });
    const retryTask = await api.create({ ...base, m3u8Url: retryCdn.url('media.m3u8'), outputName: 'retry.mp4', concurrency: 2, retries: 3 });
    const retried = await api.waitFor(retryTask.id, ['downloaded', 'failed']);
    await ctx.check('失败切片重试后成功', retried.status === 'downloaded', `${retried.status} ${retried.error || ''}`);
    await ctx.check('重试后 seg1 被请求 3 次', (retryCdn.hits.get('seg1.ts') || 0) === 3, String(retryCdn.hits.get('seg1.ts')));

    // 4) 重试耗尽
    const failDir = ctx.temp('download-fail');
    writeFakePlaylist(failDir, ['x0', 'x1', 'x2']);
    const failCdn = await startCdn(ctx, failDir, { failFirst: { 'seg1.ts': 99 } });
    const failTask = await api.create({ ...base, m3u8Url: failCdn.url('media.m3u8'), outputName: 'fail.mp4', concurrency: 2, retries: 1 });
    const failed = await api.waitFor(failTask.id, ['failed', 'downloaded']);
    await ctx.check('重试耗尽后任务 failed', failed.status === 'failed' && failed.failedSegments === 1, `${failed.status} failedSegments=${failed.failedSegments}`);
    await ctx.check('失败任务记录错误信息', /failed|segment/i.test(String(failed.error)), failed.error);
    await ctx.check('其余切片仍完成', failed.doneSegments === 2, String(failed.doneSegments));
  },
};
