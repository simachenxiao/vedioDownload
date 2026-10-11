// 用例 06：播放接口（成品流 / Range / 已移动文件 / 错误分支）
import fs from 'node:fs';
import path from 'node:path';
import { sha256, startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '06',
  title: '播放：视频流、Range、HEAD、已移动文件优先级',
  covers: [
    'GET /video 返回 200 + Accept-Ranges + 正确 Content-Type',
    'Range 首段/尾部/越界（200/206/416）',
    'HEAD 返回 Content-Length',
    '优先播放 movedPath（已移动成品）',
    '成品不存在时 404',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('play');
    const cdnDir = ctx.temp('play-cdn');
    const buffers = writeFakePlaylist(cdnDir, ['v0', 'v1', 'v2']);
    const cdn = await startCdn(ctx, cdnDir);
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const tempRoot = path.join(dataDir, 'data', 'temp');

    const task = await api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('media.m3u8'),
      outputName: 'play.mp4',
      tempRoot,
      concurrency: 2,
      retries: 0,
      autoMerge: false,
      removeAds: false,
    });
    await api.waitFor(task.id, ['downloaded', 'failed']);
    await api.post(`/api/tasks/${task.id}/merge`);
    const merged = await api.waitFor(task.id, ['success', 'partial', 'failed']);
    const expected = Buffer.concat(buffers);
    const videoUrl = `/api/tasks/${task.id}/video`;

    const full = await api.request(videoUrl);
    const fullBody = full.buffer;
    await ctx.check('GET 返回 200', full.res.status === 200, String(full.res.status));
    await ctx.check('声明 Accept-Ranges 与 video/mp4', full.res.headers.get('accept-ranges') === 'bytes' && full.res.headers.get('content-type') === 'video/mp4', `${full.res.headers.get('accept-ranges')} ${full.res.headers.get('content-type')}`);
    await ctx.check('Content-Disposition inline 且带文件名', String(full.res.headers.get('content-disposition')).startsWith('inline;') && String(full.res.headers.get('content-disposition')).includes('play.mp4'));
    await ctx.check('整段内容与切片拼接一致', fullBody.equals(expected), `${fullBody.length}/${expected.length}`);

    const head = await fetch(server.base + videoUrl, { method: 'HEAD' });
    await ctx.check('HEAD 返回 Content-Length 且无 body', head.status === 200 && head.headers.get('content-length') === String(expected.length));

    const range = await api.request(videoUrl, { headers: { Range: 'bytes=8-23' } });
    const rangeBody = range.buffer;
    await ctx.check('Range 8-23 返回 206', range.res.status === 206 && range.res.headers.get('content-range') === `bytes 8-23/${expected.length}`, `${range.res.status} ${range.res.headers.get('content-range')}`);
    await ctx.check('Range 内容正确', rangeBody.equals(expected.subarray(8, 24)), `${rangeBody.length}B`);

    const suffix = await api.request(videoUrl, { headers: { Range: 'bytes=-10' } });
    await ctx.check('尾部 Range 返回 206', suffix.res.status === 206 && suffix.res.headers.get('content-range') === `bytes ${expected.length - 10}-${expected.length - 1}/${expected.length}`);

    const bad = await api.request(videoUrl, { headers: { Range: 'bytes=999999-' } });
    await ctx.check('越界 Range 返回 416 与 bytes */total', bad.res.status === 416 && bad.res.headers.get('content-range') === `bytes */${expected.length}`, `${bad.res.status} ${bad.res.headers.get('content-range')}`);

    // 已移动成品优先于 outputPath
    const moveDir = ctx.temp('play-moved');
    await api.post(`/api/tasks/${merged.id}/move`, { destDir: moveDir });
    const moved = await api.waitFor(merged.id, ['moved', 'failed', 'success']);
    await ctx.check('移动到新目录', moved.status === 'moved', `${moved.status} ${moved.error || ''}`);
    fs.writeFileSync(moved.outputPath || path.join(moved.tempDir, 'play.mp4'), 'stale-dummy');
    const movedFile = await api.request(videoUrl);
    const movedBody = movedFile.buffer;
    await ctx.check('播放的是 movedPath 内容', movedFile.res.status === 200 && sha256(movedBody) === sha256(expected));

    const missing = await api.request('/api/tasks/not-a-task/video');
    await ctx.check('任务不存在返回 404', missing.res.status === 404, JSON.stringify(missing.body));
  },
};
