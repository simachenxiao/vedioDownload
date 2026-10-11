// 用例 08：任务控制（暂停/继续/停止/重试）与删除
import fs from 'node:fs';
import path from 'node:path';
import { sleep, startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '08',
  title: '任务控制：暂停/继续/停止/重试与删除清理',
  covers: [
    '暂停把 downloading 任务停住并保留进度',
    '继续后任务恢复并最终完成',
    '停止任务后状态为 stopped',
    '已移动成品在删除任务时不被删除',
    '批量删除清空任务并移除临时目录',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('control');
    const cdnDir = ctx.temp('control-cdn');
    writeFakePlaylist(cdnDir, ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    const cdn = await startCdn(ctx, cdnDir, { delayMs: 250 });
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = path.join(dataDir, 'data', 'temp');
    const base = { resourceType: 'other', m3u8Url: cdn.url('media.m3u8'), tempRoot, concurrency: 1, retries: 0, autoMerge: false, removeAds: false };

    // 暂停 -> 继续
    const pauseTask = await api.create({ ...base, outputName: 'pause.mp4' });
    await sleep(400);
    const paused = (await api.post(`/api/tasks/${pauseTask.id}/pause`)).task;
    await ctx.check('暂停后状态为 paused', paused.status === 'paused', paused.status);
    await ctx.check('暂停保留已下载进度（未全部完成）', paused.doneSegments > 0 && paused.doneSegments < 10, `done=${paused.doneSegments}`);
    const stillPaused = await api.task(pauseTask.id);
    await ctx.check('暂停后不再推进（进度最多再完成 1 片）', stillPaused.status === 'paused' && stillPaused.doneSegments - paused.doneSegments <= 1 && stillPaused.doneSegments < 10, `${paused.doneSegments} -> ${stillPaused.doneSegments}`);

    await api.post(`/api/tasks/${pauseTask.id}/resume`);
    const resumed = await api.waitFor(pauseTask.id, ['downloaded', 'failed']);
    await ctx.check('继续后下载至完成', resumed.status === 'downloaded' && resumed.doneSegments === 10, `${resumed.status} ${resumed.doneSegments}/10`);

    // 停止
    const stopTask = await api.create({ ...base, outputName: 'stop.mp4' });
    await sleep(350);
    const stopped = (await api.post(`/api/tasks/${stopTask.id}/stop`)).task;
    await ctx.check('停止后状态为 stopped', stopped.status === 'stopped', stopped.status);
    await ctx.check('停止任务可再次继续', (await api.post(`/api/tasks/${stopTask.id}/resume`)).task.status !== 'stopped');
    await api.waitFor(stopTask.id, ['downloaded', 'failed']);

    // 失败重试接口
    const retryTask = await api.create({ ...base, outputName: 'retry.mp4' });
    const retried = await api.waitFor(retryTask.id, ['downloaded', 'failed']);
    await ctx.check('重试接口可在完成后重跑', (await api.post(`/api/tasks/${retryTask.id}/retry`)).ok === true && retried.status === 'downloaded');

    // 删除：合并 -> 移动 -> 删除任务，成品保留
    await api.post(`/api/tasks/${pauseTask.id}/merge`);
    const merged = await api.waitFor(pauseTask.id, ['success', 'partial', 'failed']);
    const destDir = ctx.temp('control-dest');
    await api.post(`/api/tasks/${merged.id}/move`, { destDir });
    const moved = await api.waitFor(merged.id, ['moved', 'failed', 'success']);
    await api.del(`/api/tasks/${moved.id}`);
    await ctx.check('删除任务后临时目录被清理', !fs.existsSync(moved.tempDir), moved.tempDir);
    await ctx.check('已移动的成品不被删除', fs.existsSync(moved.movedPath));
    await ctx.check('任务已从列表移除', !(await api.tasks()).some(t => t.id === moved.id));

    const remaining = await api.tasks();
    const bulk = await api.post('/api/tasks/bulk/delete');
    await ctx.check('批量删除清空任务', bulk.deleted === remaining.length && (await api.tasks()).length === 0, JSON.stringify(bulk));
    const stats = await api.stats();
    await ctx.check('删除后统计归零', Object.values(stats).every(v => v === 0), JSON.stringify(stats));
  },
};
