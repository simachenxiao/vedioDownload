// 用例 09：采集站地址解析与 m3u8 解析（离线，不依赖外网）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, ROOT, startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

/** 以 VDL_NO_START=1 导入 server.js，仅使用其导出的解析函数 */
const importServer = async dataDir => {
  const previous = { TRM_PKGVAR: process.env.TRM_PKGVAR, VDL_NO_START: process.env.VDL_NO_START };
  process.env.TRM_PKGVAR = dataDir;
  process.env.VDL_NO_START = '1';
  try {
    return await import(`${pathToFileURL(path.join(ROOT, 'ui', 'server.js')).href}?case=${Date.now()}`);
  } finally {
    if (previous.VDL_NO_START === undefined) delete process.env.VDL_NO_START;
    else process.env.VDL_NO_START = previous.VDL_NO_START;
    if (previous.TRM_PKGVAR === undefined) delete process.env.TRM_PKGVAR;
    else process.env.TRM_PKGVAR = previous.TRM_PKGVAR;
  }
};

export default {
  id: '09',
  title: '地址解析：播放器链接、剧集列表、master/加密 m3u8',
  covers: [
    'parseEpisodeList 多来源选择与剧集命名',
    'LibreTV / KVideo 播放器地址解析（单集）',
    'episodes 参数（JSON 剧集数组）与非法地址报错',
    '部分下载集数表达式（1;2;4、2-6、去重排序、非法与超范围报错）',
    'parseM3u8 选择最高码率 master、解析 EXT-X-KEY',
    '加密流下载密钥 + 本地清单写入 KEY',
    '全集/部分模式批量建任务、集号保留与批次排队',
  ],
  async run(ctx) {
    const mod = await importServer(ctx.temp('cms-import'));
    const { parseEpisodeList, parseEpisodeSelection, resolveCmsEpisodes, parseM3u8 } = mod;

    const episodeList = parseEpisodeList('第01集$http://cdn.test/1.m3u8#第02集$http://cdn.test/2.m3u8', 'kuaikan');
    await ctx.check('剧集列表解析出 2 集并保留名称', episodeList.length === 2 && episodeList[0].name === '第01集' && episodeList[1].url === 'http://cdn.test/2.m3u8', JSON.stringify(episodeList));

    const multiSource = parseEpisodeList('低码$http://a.test/low.m3u8$$$高码$http://b.test/high.m3u8', 'kuaikan$$$bfzym3u8', 'bfzym3u8');
    await ctx.check('多来源时按 preferredSource 选择', multiSource[0].url === 'http://b.test/high.m3u8', JSON.stringify(multiSource));

    const autoNamed = parseEpisodeList('http://cdn.test/only.m3u8');
    await ctx.check('无剧集名时生成 第01集', autoNamed[0].name === '第01集' && autoNamed[0].url === 'http://cdn.test/only.m3u8', JSON.stringify(autoNamed));

    const librePlayer = `https://player.test/player.html?id=161017&source=bfzy&title=测试剧&index=2&url=${encodeURIComponent('http://cdn.test/ep3.m3u8')}`;
    const single = await resolveCmsEpisodes(librePlayer, 'auto', 'single', 'bfzy');
    await ctx.check('LibreTV 播放器地址解析单集', single.episodes.length === 1 && single.episodes[0].url === 'http://cdn.test/ep3.m3u8' && single.episodes[0].name === '第03集', JSON.stringify(single));

    const kvedioPlayer = `https://player.test/player?id=99&source=ruyi&url=${encodeURIComponent('http://cdn.test/kv.m3u8')}`;
    const kvedio = await resolveCmsEpisodes(kvedioPlayer, 'auto', 'single', 'ruyi');
    await ctx.check('KVideo 播放器地址解析单集', kvedio.episodes.length === 1 && kvedio.episodes[0].url === 'http://cdn.test/kv.m3u8', JSON.stringify(kvedio));

    const episodesParam = encodeURIComponent(JSON.stringify(['http://cdn.test/e1.m3u8', 'http://cdn.test/e2.m3u8']));
    const fromParam = await resolveCmsEpisodes(`https://player.test/player.html?episodes=${episodesParam}&title=参数剧`, 'auto', 'all', 'ruyi');
    await ctx.check('episodes 参数直接给出剧集列表', fromParam.episodes.length === 2 && fromParam.title === '参数剧', JSON.stringify(fromParam));

    let invalidError = '';
    try {
      await resolveCmsEpisodes('not-a-url');
    } catch (e) {
      invalidError = e.message;
    }
    await ctx.check('非法视频地址抛出可读错误', /http/.test(invalidError), invalidError);

    // 3) 部分下载表达式解析
    const selectionCases = [
      ['1;2;4', [1, 2, 4]],
      ['2-6', [2, 3, 4, 5, 6]],
      ['1,3-5；9', [1, 3, 4, 5, 9]],
      ['2~4 6', [2, 3, 4, 6]],
      ['1 - 2', [1, 2]],
      ['3;3;1', [1, 3]],
      ['10', [10]],
    ];
    const parsedSelections = selectionCases.map(([expression]) => {
      try {
        return parseEpisodeSelection(expression, 10).join(',');
      } catch (e) {
        return `ERR:${e.message}`;
      }
    });
    await ctx.check(
      '部分下载表达式：分隔符/范围/去重排序',
      parsedSelections.every((value, index) => value === selectionCases[index][1].join(',')),
      JSON.stringify(parsedSelections),
    );

    const selectionErrors = ['', '0', 'abc', '5-2', '1-', '2-99'].map(expression => {
      try {
        parseEpisodeSelection(expression, 10);
        return 'NO_ERROR';
      } catch (e) {
        return e.message;
      }
    });
    await ctx.check('非法集数表达式全部报错', selectionErrors.every(message => message !== 'NO_ERROR'), JSON.stringify(selectionErrors));
    await ctx.check('超出总集数时提示总集数', /共 10 集/.test(selectionErrors[5]), selectionErrors[5]);
    await ctx.check('范围起止颠倒时提示', /起始不能大于结束/.test(selectionErrors[3]), selectionErrors[3]);

    // master 与加密播放列表
    const cdnDir = ctx.temp('cms-cdn');
    writeFakePlaylist(cdnDir, ['low-a', 'low-b'], { name: 'low.m3u8', prefix: 'low' });
    writeFakePlaylist(cdnDir, ['high-a', 'high-b', 'high-c'], { name: 'high.m3u8', prefix: 'high' });
    writeFakePlaylist(cdnDir, ['enc-a', 'enc-b'], { prefix: 'seg' });
    fs.writeFileSync(path.join(cdnDir, 'master.m3u8'), [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360', 'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080', 'high.m3u8',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cdnDir, 'key.bin'), Buffer.alloc(16, 7));
    fs.writeFileSync(path.join(cdnDir, 'enc.m3u8'), [
      '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2',
      '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF',
      '#EXTINF:2.0,', 'seg0.ts',
      '#EXTINF:2.0,', 'seg1.ts',
      '#EXT-X-ENDLIST', '',
    ].join('\n'));
    const cdn = await startCdn(ctx, cdnDir);

    const master = await parseM3u8(cdn.url('master.m3u8'));
    await ctx.check('master 选择最高码率变体', master.segments.length === 3 && master.segments[0].uri.endsWith('high0.ts'), `${master.segments.length} 片，首片=${master.segments[0]?.uri}`);

    const encrypted = await parseM3u8(cdn.url('enc.m3u8'));
    await ctx.check('解析 EXT-X-KEY 并给切片绑定 keyId', encrypted.keys.length === 1 && encrypted.keys[0].method === 'AES-128' && encrypted.segments.every(s => s.keyId === encrypted.keys[0].id), JSON.stringify(encrypted.keys));

    // 加密任务：密钥落盘 + 本地清单写入 KEY
    const dataDir = ctx.temp('cms-server');
    const server = await startServer(ctx, { dataDir });
    const task = await server.api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('enc.m3u8'),
      outputName: 'enc.mp4',
      tempRoot: path.join(dataDir, 'data', 'temp'),
      concurrency: 2,
      retries: 0,
      autoMerge: false,
      removeAds: false,
    });
    const downloaded = await server.api.waitFor(task.id, ['downloaded', 'failed']);
    await ctx.check('加密流下载完成', downloaded.status === 'downloaded', `${downloaded.status} ${downloaded.error || ''}`);
    const keyFile = path.join(downloaded.tempDir, 'keys', 'key_0000.bin');
    await ctx.check('密钥文件已下载', fs.existsSync(keyFile) && fs.statSync(keyFile).size === 16, fs.existsSync(keyFile) ? String(fs.statSync(keyFile).size) : '缺失');
    await server.api.post(`/api/tasks/${task.id}/merge`);
    await server.api.waitFor(task.id, ['success', 'partial', 'failed']);
    const manifest = fs.readFileSync(path.join(downloaded.tempDir, 'local.m3u8'), 'utf8').replace(/\\/g, '/');
    await ctx.check('本地清单写入 EXT-X-KEY 与 IV', /#EXT-X-KEY:METHOD=AES-128,URI=".*key_0000\.bin",IV=0x0123456789ABCDEF0123456789ABCDEF/.test(manifest), manifest.split('\n').slice(0, 4).join(' | '));

    // 全集 / 部分模式：批次排队 + 命名（4 集，URL 可重复）
    const batchCdnDir = ctx.temp('cms-batch-cdn');
    writeFakePlaylist(batchCdnDir, ['batch-a', 'batch-b'], { name: 'ep1.m3u8', prefix: 'b1' });
    writeFakePlaylist(batchCdnDir, ['batch-c', 'batch-d'], { name: 'ep2.m3u8', prefix: 'b2' });
    const batchCdn = await startCdn(ctx, batchCdnDir, { delayMs: 250 });
    const batchData = ctx.temp('cms-batch');
    const batchServer = await startServer(ctx, { dataDir: batchData });
    const episodesParamFor = urls => encodeURIComponent(JSON.stringify(urls));
    const fourEpisodes = episodesParamFor([batchCdn.url('ep1.m3u8'), batchCdn.url('ep2.m3u8'), batchCdn.url('ep1.m3u8'), batchCdn.url('ep2.m3u8')]);
    const batchBase = {
      resourceType: 'ruyi',
      sourcePage: 'auto',
      autoMerge: false,
      removeAds: false,
      tempRoot: path.join(batchData, 'data', 'temp'),
      concurrency: 2,
      retries: 0,
    };

    const batchBody = await batchServer.api.createRaw({
      ...batchBase,
      videoAddress: `https://player.test/player.html?title=批量剧&episodes=${fourEpisodes}`,
      ruyiMode: 'all',
      taskConcurrency: 1,
    });
    await ctx.check('全集模式按剧集数创建任务', batchBody.tasks?.length === 4, JSON.stringify((batchBody.tasks || []).map(t => t.outputName)));
    await ctx.check('批次任务命名包含剧名与集号', (batchBody.tasks || []).every(t => t.batchTitle === '批量剧' && t.episodeName && t.batchId), JSON.stringify((batchBody.tasks || []).map(t => `${t.batchTitle}/${t.episodeName}`)));
    await ctx.check('全集模式保留原集号顺序', (batchBody.tasks || []).map(t => t.episodeIndex).join(',') === '0,1,2,3', JSON.stringify((batchBody.tasks || []).map(t => t.episodeIndex)));

    const snapshot = await batchServer.api.tasks();
    const sorted = [...snapshot].sort((a, b) => a.episodeIndex - b.episodeIndex);
    await ctx.check('批次并发 1 时后一集处于等待', sorted[1]?.status === 'waiting' && ['pending', 'downloading'].includes(sorted[0]?.status), sorted.map(t => `${t.episodeIndex}:${t.status}`).join(','));

    const batchDone = await Promise.all((batchBody.tasks || []).map(t => batchServer.api.waitFor(t.id, ['downloaded', 'failed'])));
    await ctx.check('批次任务全部完成', batchDone.every(t => t.status === 'downloaded'), batchDone.map(t => t.status).join(','));
    await ctx.check('批次 batchId 一致且并发数传递', new Set(batchDone.map(t => t.batchId)).size === 1 && batchDone.every(t => t.batchConcurrency === 1), batchDone.map(t => `${t.batchId}/${t.batchConcurrency}`).join(','));

    // 部分模式：只创建选中的集，且保留原集号
    const partialBody = await batchServer.api.createRaw({
      ...batchBase,
      videoAddress: `https://player.test/player.html?title=部分剧&episodes=${fourEpisodes}`,
      ruyiMode: 'partial',
      episodeSelect: '2;4',
      taskConcurrency: 2,
    });
    await ctx.check('部分模式只创建选中的集', partialBody.tasks?.length === 2 && partialBody.tasks.map(t => t.episodeName).join(',') === '第02集,第04集', JSON.stringify((partialBody.tasks || []).map(t => t.episodeName)));
    await ctx.check('部分模式保留原始集号', (partialBody.tasks || []).map(t => t.episodeIndex).join(',') === '1,3', JSON.stringify((partialBody.tasks || []).map(t => t.episodeIndex)));
    await ctx.check('部分模式仍是同一批次', new Set((partialBody.tasks || []).map(t => t.batchId)).size === 1 && !!partialBody.tasks?.[0]?.batchId);
    const partialDone = await Promise.all((partialBody.tasks || []).map(t => batchServer.api.waitFor(t.id, ['downloaded', 'failed'])));
    await ctx.check('部分模式任务下载完成', partialDone.every(t => t.status === 'downloaded'), partialDone.map(t => t.status).join(','));

    // 部分模式支持范围表达式
    const rangeBody = await batchServer.api.createRaw({
      ...batchBase,
      videoAddress: `https://player.test/player.html?title=范围剧&episodes=${episodesParamFor([cdn.url('low.m3u8'), cdn.url('high.m3u8')])}`,
      ruyiMode: 'partial',
      episodeSelect: '1-2',
      taskConcurrency: 2,
    });
    await ctx.check('部分模式支持范围表达式', rangeBody.tasks?.length === 2 && rangeBody.tasks.map(t => t.episodeName).join(',') === '第01集,第02集', JSON.stringify((rangeBody.tasks || []).map(t => t.episodeName)));
    const rangeDone = await Promise.all((rangeBody.tasks || []).map(t => batchServer.api.waitFor(t.id, ['downloaded', 'failed'])));
    await ctx.check('范围表达式任务下载完成', rangeDone.every(t => t.status === 'downloaded'), rangeDone.map(t => t.status).join(','));

    // 超出总集数：报错且不创建任何任务
    const beforeCount = (await batchServer.api.tasks()).length;
    const overflow = await batchServer.api.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...batchBase,
        videoAddress: `https://player.test/player.html?title=超限剧&episodes=${fourEpisodes}`,
        ruyiMode: 'partial',
        episodeSelect: '9',
        taskConcurrency: 2,
      }),
    });
    await ctx.check('超出总集数时报错并提示总数', overflow.res.status === 500 && /共 4 集/.test(String(overflow.body.error)), JSON.stringify(overflow.body));
    await ctx.check('报错时不创建任何任务', (await batchServer.api.tasks()).length === beforeCount, `${beforeCount} -> ${(await batchServer.api.tasks()).length}`);

    const emptySelect = await batchServer.api.request('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...batchBase,
        videoAddress: `https://player.test/player.html?title=空选剧&episodes=${fourEpisodes}`,
        ruyiMode: 'partial',
        episodeSelect: '   ',
        taskConcurrency: 2,
      }),
    });
    await ctx.check('部分模式未填集数时报错', emptySelect.res.status === 500 && /填写要下载的集数/.test(String(emptySelect.body.error)), JSON.stringify(emptySelect.body));
  },
};
