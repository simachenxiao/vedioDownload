// 用例 11：真实 ffmpeg 合并（找不到 ffmpeg 时自动跳过）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findFfmpeg, startCdn, startServer, writeRealPlaylist } from '../harness.mjs';

export default {
  id: '11',
  title: '真实 ffmpeg 合并（无 ffmpeg 时跳过）',
  covers: [
    'mergeEngine=ffmpeg 且成品可被 ffmpeg 正常解码',
    '-c copy 合并后时长与切片一致',
  ],
  async run(ctx) {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) {
      ctx.skip('未找到 ffmpeg（可用 TEST_FFMPEG_BIN 指定后重跑）');
      return;
    }

    const cdnDir = ctx.temp('ffmpeg-cdn');
    writeRealPlaylist(ffmpeg, cdnDir, 3, 1);
    const cdn = await startCdn(ctx, cdnDir);
    const dataDir = ctx.temp('ffmpeg');
    const server = await startServer(ctx, { dataDir, env: { FFMPEG_BIN: ffmpeg } });
    const { api } = server;

    const task = await api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('media.m3u8'),
      outputName: 'ffmpeg.mp4',
      tempRoot: path.join(dataDir, 'data', 'temp'),
      concurrency: 2,
      retries: 0,
      autoMerge: true,
      removeAds: false,
    });
    const done = await api.waitFor(task.id, ['success', 'partial', 'failed'], 40000);
    await ctx.check('自动合并成功', done.status === 'success', `${done.status} ${done.error || ''}`);
    await ctx.check('mergeEngine 为 ffmpeg', done.mergeEngine === 'ffmpeg', done.mergeEngine);
    await ctx.check('成品存在且非空', !!done.outputPath && fs.statSync(done.outputPath).size > 0, String(done.outputSize));

    const probe = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', done.outputPath, '-f', 'null', '-'], { encoding: 'utf8' });
    await ctx.check('成品可被 ffmpeg 解码', probe.status === 0, (probe.stderr || '').trim().slice(0, 160));

    const duration = spawnSync(ffmpeg, ['-hide_banner', '-i', done.outputPath], { encoding: 'utf8' });
    const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(`${duration.stdout}${duration.stderr}`);
    const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 0;
    await ctx.check('成品时长约等于 3 秒', seconds >= 2.5 && seconds <= 3.5, `${seconds}s`);
  },
};
