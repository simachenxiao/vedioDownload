// 回归测试公共工具：临时目录、假切片 CDN、启动服务、REST 客户端、断言上下文
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(TESTS_DIR);
export const RUNTIME_ROOT = path.join(ROOT, '.runtime-tests');
export const SERVER_ENTRY = path.join(ROOT, 'ui', 'server.js');
export const MANIFEST = path.join(ROOT, 'manifest');
export { pathToFileURL };

let portCursor = 19700;
export const nextPort = () => portCursor++;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

/** 生成内容确定、互不相同的假切片 */
export const segmentBuffer = (tag, repeat = 80) => Buffer.from(sha256(tag).repeat(repeat));

/** 在 dir 下写入 seg0.ts..segN.ts 与 media.m3u8（非加密、无 master） */
export const writeFakePlaylist = (dir, tags, { name = 'media.m3u8', duration = 2, prefix = 'seg' } = {}) => {
  fs.mkdirSync(dir, { recursive: true });
  const buffers = tags.map(tag => segmentBuffer(tag));
  buffers.forEach((buffer, index) => fs.writeFileSync(path.join(dir, `${prefix}${index}.ts`), buffer));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  buffers.forEach((_, index) => {
    lines.push(`#EXTINF:${duration.toFixed(1)},`, `${prefix}${index}.ts`);
  });
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, name), lines.join('\n'));
  return buffers;
};

/** 本地静态 CDN，可注入请求延迟与失败次数 */
export const startCdn = async (ctx, dir, { delayMs = 0, failFirst = {} } = {}) => {
  const port = nextPort();
  const hits = new Map();
  const server = http.createServer(async (req, res) => {
    const name = decodeURIComponent(path.basename(String(req.url || '/').split('?')[0]));
    const target = path.join(dir, name);
    const seen = (hits.get(name) || 0) + 1;
    hits.set(name, seen);
    if (seen <= (failFirst[name] || 0)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('injected failure');
      return;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (delayMs) await sleep(delayMs);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(fs.readFileSync(target));
  });
  const close = () => new Promise(resolve => server.close(() => resolve()));
  ctx.onCleanup(close);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return {
    port,
    hits,
    close,
    url: name => `http://127.0.0.1:${port}/${name}`,
  };
};

/** REST 客户端；json() 在非 2xx 时抛错，request() 返回原始响应 */
export const makeClient = base => {
  const request = async (p, options = {}) => {
    const res = await fetch(base + p, options);
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString('utf8');
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    return { res, body, buffer, text };
  };
  const json = async (p, options = {}) => {
    const { res, body } = await request(p, options);
    if (!res.ok) throw new Error(`${options.method || 'GET'} ${p} -> HTTP ${res.status} ${JSON.stringify(body)}`);
    return body;
  };
  const send = (method, p, payload) => json(p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const client = {
    base,
    request,
    json,
    get: p => json(p),
    post: (p, payload) => send('POST', p, payload),
    del: p => json(p, { method: 'DELETE' }),
    stats: () => json('/api/stats'),
    tasks: async () => (await json('/api/tasks')).tasks,
    task: async id => (await json(`/api/tasks/${id}`)).task,
    createRaw: payload => send('POST', '/api/tasks', payload),
    create: async payload => {
      const body = await send('POST', '/api/tasks', payload);
      if (!body.task) throw new Error('期望单个任务，实际返回批量结果');
      return body.task;
    },
    waitFor: async (id, statuses, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      let task = await client.task(id);
      while (!statuses.includes(task.status) && Date.now() < deadline) {
        await sleep(120);
        task = await client.task(id);
      }
      return task;
    },
  };
  return client;
};

/** 启动 ui/server.js；默认 FFMPEG_BIN 指向不存在路径，走 concat 回退，保证跨平台一致 */
export const startServer = async (ctx, { dataDir, port = nextPort(), env = {}, timeoutMs = 20000 } = {}) => {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      TRM_PKGVAR: dataDir,
      PORT: String(port),
      FFMPEG_BIN: path.join(dataDir, '__missing_ffmpeg__'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let exited = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  child.on('exit', () => { exited = true; });

  const base = `http://127.0.0.1:${port}`;
  const api = makeClient(base);
  const stop = async () => {
    if (!exited) child.kill();
    for (let i = 0; i < 60 && !exited; i += 1) await sleep(50);
  };
  ctx.onCleanup(stop);
  ctx.outputs.push(() => output.slice(-2000));

  const handle = {
    child,
    port,
    base,
    api,
    stop,
    output: () => output,
    get exited() { return exited; },
    ready: async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (exited) throw new Error(`server 提前退出：\n${output.slice(-1500)}`);
        try {
          const res = await fetch(`${base}/api/health`);
          if (res.ok) return handle;
        } catch {}
        await sleep(100);
      }
      throw new Error(`server 启动超时：\n${output.slice(-1500)}`);
    },
  };
  await handle.ready();
  return handle;
};

/** 查找可用的 ffmpeg（找不到则相关用例跳过） */
export const findFfmpeg = () => {
  const candidates = [
    process.env.TEST_FFMPEG_BIN,
    process.env.FFMPEG_BIN,
    path.join(ROOT, '.runtime-tools', 'imageio_ffmpeg', 'binaries', 'ffmpeg-win-x86_64-v7.1.exe'),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'ffmpeg',
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0) return bin;
    } catch {}
  }
  return '';
};

/** 用真实 ffmpeg 生成可合并的 mpegts 切片与播放列表 */
export const writeRealPlaylist = (ffmpeg, dir, count = 3, seconds = 1) => {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const out = path.join(dir, `seg${i}.ts`);
    const result = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=128x96:rate=10:duration=${seconds}`,
      '-c:v', 'mpeg2video', '-b:v', '300k',
      '-f', 'mpegts', out,
    ], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`生成测试切片失败：seg${i}`);
  }
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2'];
  for (let i = 0; i < count; i += 1) lines.push(`#EXTINF:${seconds.toFixed(1)},`, `seg${i}.ts`);
  lines.push('#EXT-X-ENDLIST', '');
  fs.writeFileSync(path.join(dir, 'media.m3u8'), lines.join('\n'));
  return { count, dir };
};

/** 单个用例的断言与资源清理上下文 */
export class CaseContext {
  constructor(meta, { verbose = false } = {}) {
    this.meta = meta;
    this.verbose = verbose;
    this.checks = [];
    this.cleanups = [];
    this.outputs = [];
    this.skipReason = '';
  }

  logs() {
    return this.outputs.map(fn => fn()).filter(Boolean).join('\n');
  }

  onCleanup(fn) {
    this.cleanups.push(fn);
  }

  skip(reason) {
    this.skipReason = reason;
  }

  async check(name, condition, detail = '') {
    let ok = false;
    let error = '';
    try {
      ok = typeof condition === 'function' ? await condition() : !!condition;
    } catch (e) {
      error = e.message;
    }
    const text = [detail, error].filter(Boolean).join(' ').trim();
    this.checks.push({ name, ok, detail: text });
    if (this.verbose) console.log(`      ${ok ? '✓' : '✗'} ${name}${text ? `  ${text}` : ''}`);
    return ok;
  }

  temp(label) {
    const dir = path.join(RUNTIME_ROOT, `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
    fs.mkdirSync(dir, { recursive: true });
    this.onCleanup(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  async dispose() {
    for (const fn of this.cleanups.reverse()) {
      try {
        await fn();
      } catch {}
    }
    this.cleanups = [];
  }
}
