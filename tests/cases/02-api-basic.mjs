// 用例 02：基础 API（health / defaults / stats / tasks / browse / 建任务校验）
import fs from 'node:fs';
import path from 'node:path';
import { MANIFEST, ROOT, startServer } from '../harness.mjs';

export default {
  id: '02',
  title: '基础 API：health / defaults / stats / tasks / browse',
  covers: [
    '/api/health 返回版本与数据目录',
    '/api/defaults 字段完整',
    '空数据时 /api/stats 与 /api/tasks',
    '/api/browse 目录列举、排序、错误分支',
    '新建任务参数校验（非法 m3u8 / 非法 base）',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('api');
    const server = await startServer(ctx, { dataDir });
    const { api } = server;
    const version = /^version\s*=\s*(\S+)/m.exec(fs.readFileSync(MANIFEST, 'utf8'))?.[1];

    const health = await api.get('/api/health');
    await ctx.check('health.ok 为 true', health.ok === true);
    await ctx.check('health.version 与 manifest 一致', health.version === version, `health=${health.version} manifest=${version}`);
    await ctx.check('health.dataDir 指向 PKGVAR/data', health.dataDir === path.join(dataDir, 'data'), health.dataDir);

    const defaults = await api.get('/api/defaults');
    await ctx.check(
      'defaults 含临时/输出/广告目录与并发、重试',
      ['tempRoot', 'outputRoot', 'adRoot', 'concurrency', 'retries'].every(key => defaults[key] !== undefined),
      JSON.stringify(defaults),
    );
    await ctx.check('defaults.tempRoot 位于数据目录下', String(defaults.tempRoot).startsWith(path.join(dataDir, 'data')));

    const stats = await api.stats();
    await ctx.check('空数据统计全为 0', Object.values(stats).every(v => v === 0), JSON.stringify(stats));
    await ctx.check('任务列表为空数组', (await api.tasks()).length === 0);

    // browse：默认根目录 / 指定目录 / 排序 / 错误分支
    const browseRoot = ctx.temp('browse');
    for (const name of ['c-share', 'a-movie', 'b-tv']) fs.mkdirSync(path.join(browseRoot, name));
    fs.writeFileSync(path.join(browseRoot, 'file.txt'), 'x');

    const listed = await api.get(`/api/browse?path=${encodeURIComponent(browseRoot)}`);
    await ctx.check('browse 枚举子目录（忽略文件）', listed.directories.length === 3, JSON.stringify(listed.directories.map(d => d.name)));
    await ctx.check('browse 目录按名称排序', listed.directories.map(d => d.name).join(',') === 'a-movie,b-tv,c-share');
    await ctx.check('browse 返回父目录', listed.parentPath === path.dirname(browseRoot), listed.parentPath);

    const missing = await api.request(`/api/browse?path=${encodeURIComponent(path.join(browseRoot, 'nope'))}`);
    await ctx.check('browse 不存在的目录报错', missing.res.status === 500 && String(missing.body.error).includes('exist'), JSON.stringify(missing.body));

    const notDir = await api.request(`/api/browse?path=${encodeURIComponent(path.join(browseRoot, 'file.txt'))}`);
    await ctx.check('browse 非目录路径报错', notDir.res.status === 500 && String(notDir.body.error).includes('not a directory'));

    // 建任务参数校验
    const badUrl = await api.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'other', m3u8Url: 'ftp://example.com/a.m3u8' }),
    });
    await ctx.check('非 http(s) 的 m3u8 被拒绝', badUrl.res.status === 500 && /http/.test(String(badUrl.body.error)), JSON.stringify(badUrl.body));

    const badBase = await api.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType: 'other', m3u8Url: 'http://example.com/a.m3u8', baseUrl: 'not-a-url' }),
    });
    await ctx.check('非法 base 地址被拒绝', badBase.res.status === 500 && /base/.test(String(badBase.body.error)), JSON.stringify(badBase.body));

    const parseFail = await api.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        resourceType: 'other',
        m3u8Url: `${server.base}/api/nope`,
        outputName: 'parse-fail.mp4',
        tempRoot: path.join(dataDir, 'data', 'temp'),
        autoMerge: false,
        removeAds: false,
      }),
    });
    await ctx.check('m3u8 拉取失败时建任务报错', parseFail.res.status === 500 && /HTTP 404/.test(String(parseFail.body.error)), JSON.stringify(parseFail.body));

    const failedTasks = await api.tasks();
    await ctx.check(
      '失败任务仍入库并标记 failed',
      failedTasks.length === 1 && failedTasks[0].status === 'failed' && failedTasks[0].totalSegments === 0,
      JSON.stringify(failedTasks.map(t => `${t.status}/${t.totalSegments}`)),
    );
  },
};
