// 用例 10：SSE 实时推送与重启恢复
import fs from 'node:fs';
import path from 'node:path';
import { sleep, startCdn, startServer, writeFakePlaylist } from '../harness.mjs';

export default {
  id: '10',
  title: 'SSE 事件推送与重启恢复',
  covers: [
    'GET /api/events 返回 text/event-stream 并首推 stats',
    '新建/更新任务推送 task 事件，删除推送 delete 事件',
    '重启后 downloading 任务被标记 paused',
    '重启后任务可继续下载至完成（状态持久化）',
  ],
  async run(ctx) {
    const dataDir = ctx.temp('events');
    const cdnDir = ctx.temp('events-cdn');
    writeFakePlaylist(cdnDir, ['e0', 'e1', 'e2', 'e3']);
    const cdn = await startCdn(ctx, cdnDir);
    const server = await startServer(ctx, { dataDir });
    const { api } = server;

    // ---- SSE ----
    const controller = new AbortController();
    ctx.onCleanup(() => controller.abort());
    const stream = await fetch(`${server.base}/api/events`, { signal: controller.signal });
    await ctx.check('SSE 响应头正确', stream.status === 200 && (stream.headers.get('content-type') || '').startsWith('text/event-stream'), stream.headers.get('content-type'));

    const events = [];
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const pump = (async () => {
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf('\n\n');
          while (index >= 0) {
            const raw = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = /^event: (.+)$/m.exec(raw)?.[1];
            const data = /^data: (.+)$/m.exec(raw)?.[1];
            if (event) events.push({ event, data });
            index = buffer.indexOf('\n\n');
          }
        }
      } catch {}
    })();
    ctx.onCleanup(() => pump);

    const waitEvent = async (name, timeoutMs = 8000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = events.find(item => item.event === name);
        if (found) return found;
        await sleep(100);
      }
      return null;
    };

    await ctx.check('连接后立即收到 stats 事件', !!(await waitEvent('stats')));

    const task = await api.create({
      resourceType: 'other',
      m3u8Url: cdn.url('media.m3u8'),
      outputName: 'events.mp4',
      tempRoot: path.join(dataDir, 'data', 'temp'),
      concurrency: 2,
      retries: 0,
      autoMerge: false,
      removeAds: false,
    });
    const taskEvent = await waitEvent('task');
    await ctx.check('新建任务推送 task 事件且 id 匹配', taskEvent && JSON.parse(taskEvent.data).id === task.id, taskEvent ? taskEvent.data.slice(0, 80) : '未收到');
    await ctx.check('task 事件不携带切片明细', taskEvent && JSON.parse(taskEvent.data).segments === undefined);

    await api.waitFor(task.id, ['downloaded', 'failed']);
    await api.del(`/api/tasks/${task.id}`);
    const deleteEvent = await waitEvent('delete');
    await ctx.check('删除任务推送 delete 事件', deleteEvent && JSON.parse(deleteEvent.data).id === task.id, deleteEvent ? deleteEvent.data : '未收到');
    controller.abort();

    // ---- 重启恢复 ----
    const slowDir = ctx.temp('recover-cdn');
    writeFakePlaylist(slowDir, Array.from({ length: 8 }, (_, i) => `rec${i}`));
    const slowCdn = await startCdn(ctx, slowDir, { delayMs: 250 });
    const running = await api.create({
      resourceType: 'other',
      m3u8Url: slowCdn.url('media.m3u8'),
      outputName: 'recover.mp4',
      tempRoot: path.join(dataDir, 'data', 'temp'),
      concurrency: 1,
      retries: 0,
      autoMerge: false,
      removeAds: false,
    });
    const deadline = Date.now() + 8000;
    let before = await api.task(running.id);
    while (before.status !== 'downloading' && Date.now() < deadline) {
      await sleep(100);
      before = await api.task(running.id);
    }
    await ctx.check('重启前任务处于 downloading', before.status === 'downloading', before.status);
    const partialDone = before.doneSegments;

    await server.stop();
    const restarted = await startServer(ctx, { dataDir });
    const recovered = (await restarted.api.tasks()).find(t => t.id === running.id);
    await ctx.check('重启后任务仍存在', !!recovered);
    await ctx.check('重启后 downloading 被标记为 paused', recovered?.status === 'paused', recovered?.status);
    await ctx.check('重启后保留已下载切片数', (recovered?.doneSegments || 0) >= partialDone, `${partialDone} -> ${recovered?.doneSegments}`);

    await restarted.api.post(`/api/tasks/${running.id}/resume`);
    const finished = await restarted.api.waitFor(running.id, ['downloaded', 'failed']);
    await ctx.check('重启后继续下载至完成', finished.status === 'downloaded' && finished.doneSegments === 8, `${finished.status} ${finished.doneSegments}/8`);
    await ctx.check('tasks.json 持久化文件存在', fs.existsSync(path.join(dataDir, 'data', 'tasks.json')));
  },
};
