// 用例 07：移动成品（单个 / 幂等 / 批量 / 错误分支）
import fs from 'node:fs';
import path from 'node:path';
import { startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '07',
  title: '移动：单个移动、幂等、批量移动与错误分支',
  covers: [
    'POST /move 移动成品并清空 outputPath',
    '目标目录不存在时自动创建',
    '移动到当前所在目录幂等（不产生“移动中”卡死）',
    '批量 /api/tasks/bulk/move',
    '非法目标目录 / 无成品时返回错误',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('move');
    const cdnDir = ctx.temp('move-cdn');
    writeFakePlaylist(cdnDir, ['mv0', 'mv1', 'mv2']);
    const cdn = await startCdn(ctx, cdnDir);
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = path.join(dataDir, 'data', 'temp');
    const base = { resourceType: 'other', m3u8Url: cdn.url('media.m3u8'), tempRoot, concurrency: 2, retries: 0, autoMerge: false, removeAds: false };
    const destA = path.join(ctx.temp('move-dest-a'), 'nested', 'deeper');

    const task = await api.create({ ...base, outputName: 'one.mp4' });
    await api.waitFor(task.id, ['downloaded', 'failed']);
    await api.post(`/api/tasks/${task.id}/merge`);
    const merged = await api.waitFor(task.id, ['success', 'partial', 'failed']);
    const size = merged.outputSize;

    const noFile = await api.request('/api/tasks/00000000-0000-0000-0000-000000000000/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destDir: destA }) });
    await ctx.check('任务不存在时移动报 404', noFile.res.status === 404, JSON.stringify(noFile.body));

    const invalid = await api.request(`/api/tasks/${task.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destDir: '/' }) });
    await ctx.check('目标为根目录时被拒绝', invalid.res.status === 500 && /invalid target/.test(String(invalid.body.error)), JSON.stringify(invalid.body));

    await api.post(`/api/tasks/${merged.id}/move`, { destDir: destA });
    const moved = await api.waitFor(merged.id, ['moved', 'failed', 'success']);
    await ctx.check('移动成功且状态为 moved', moved.status === 'moved', `${moved.status} ${moved.error || ''}`);
    await ctx.check('目标目录被自动创建且文件完整', moved.movedPath === path.join(destA, 'one.mp4') && fs.statSync(moved.movedPath).size === size, `${moved.movedPath}`);
    await ctx.check('outputPath 已清空', moved.outputPath === '');

    const idempotent = await api.post(`/api/tasks/${moved.id}/move`, { destDir: destA });
    await ctx.check('重复移动到同目录保持 moved', idempotent.task.status === 'moved', idempotent.task.status);
    await ctx.check('重复移动不改动文件', fs.existsSync(moved.movedPath) && fs.statSync(moved.movedPath).size === size);

    // 批量移动：一个已合并任务 + 一个可移动任务
    const bulkOne = await api.create({ ...base, outputName: 'bulk-one.mp4' });
    const bulkTwo = await api.create({ ...base, outputName: 'bulk-two.mp4' });
    await api.waitFor(bulkOne.id, ['downloaded', 'failed']);
    await api.waitFor(bulkTwo.id, ['downloaded', 'failed']);
    await api.post('/api/tasks/bulk/merge');
    await api.waitFor(bulkOne.id, ['success', 'partial', 'failed']);
    await api.waitFor(bulkTwo.id, ['success', 'partial', 'failed']);
    const destB = ctx.temp('move-dest-b');
    const bulk = await api.post('/api/tasks/bulk/move', { destDir: destB });
    await ctx.check('批量移动启动 2 个（跳过一个已 moved）', bulk.started === 2 && bulk.skipped >= 1, JSON.stringify(bulk));

    const bulkDone = await api.waitFor(bulkOne.id, ['moved', 'failed', 'success']);
    const bulkDoneTwo = await api.waitFor(bulkTwo.id, ['moved', 'failed', 'success']);
    await ctx.check('批量移动全部完成', bulkDone.status === 'moved' && bulkDoneTwo.status === 'moved', `${bulkDone.status}/${bulkDoneTwo.status}`);
    await ctx.check('批量移动文件就位', ['bulk-one.mp4', 'bulk-two.mp4'].every(name => fs.existsSync(path.join(destB, name))), fs.readdirSync(destB).join(','));

    const noOutput = await api.create({ ...base, outputName: 'not-merged.mp4' });
    await api.waitFor(noOutput.id, ['downloaded', 'failed']);
    const noVideo = await api.request(`/api/tasks/${noOutput.id}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ destDir: destB }) });
    await ctx.check('未合并任务移动被拒绝', noVideo.res.status === 500 && /does not exist/.test(String(noVideo.body.error)), JSON.stringify(noVideo.body));
  },
};
