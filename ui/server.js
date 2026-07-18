'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const VERSION = '0.1.0';
const PKGVAR = process.env.TRM_PKGVAR || process.env.TRIM_PKGVAR || null;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = __dirname;
const TARGET_DIR = path.dirname(__dirname);
const APP_DIR = path.dirname(TARGET_DIR);
const DATA_DIR = PKGVAR ? path.join(PKGVAR, 'data') : path.join(APP_DIR, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const LOG_FILE = PKGVAR ? path.join(PKGVAR, 'info.log') : path.join(DATA_DIR, 'server.log');
const SOCK_PATH = path.join(TARGET_DIR, 'vdl.sock');
const PORT = parseInt(process.env.PORT || '0', 10) || 9635;
const BASE_PATH = '/app/vdl';
const FFMPEG_BIN = process.env.FFMPEG_BIN || '/usr/bin/ffmpeg';
const RUYI_API = 'https://cj.rycjapi.com/api.php/provide/vod';

const DEFAULT_CONFIG = {
  tempRoot: path.join(DATA_DIR, 'temp'),
  outputRoot: path.join(DATA_DIR, 'output'),
  concurrency: 32,
  ruyiConcurrency: 6,
  retries: 3,
  requestRetries: 3,
  requestTimeoutMs: 60000,
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_CONFIG.tempRoot, { recursive: true });
fs.mkdirSync(DEFAULT_CONFIG.outputRoot, { recursive: true });

let tasks = new Map();
let active = new Set();
let controls = new Map();
const sseClients = new Set();

const pad = n => String(n).padStart(2, '0');
const nowText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const log = (...args) => {
  const line = args.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)).join(' ');
  fs.appendFileSync(LOG_FILE, `${nowText()} ${line}\n`);
  console.log('[vdl]', line);
};
const atomicWrite = (file, data) => {
  const tmp = `${file}.tmp.${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};
const sendJSON = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  let bytes = 0;
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      req.destroy(new Error('request body too large'));
      return;
    }
    body += chunk;
  });
  req.on('end', () => {
    if (!body) return resolve({});
    try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid json')); }
  });
  req.on('error', reject);
});
const isValidUrl = value => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};
const sanitizeName = value => String(value || 'video')
  .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120) || 'video';
const withMp4Ext = value => {
  const safe = sanitizeName(value);
  return path.extname(safe) ? safe : `${safe}.mp4`;
};
const safeJoinUnder = (root, ...parts) => {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error('path escapes allowed directory');
  }
  return full;
};
const taskDir = task => path.resolve(task.tempDir);
const segmentsFile = task => path.join(taskDir(task), 'segments.json');
const localSegmentPath = (task, index) => safeJoinUnder(taskDir(task), 'segments', `${String(index).padStart(6, '0')}.ts`);
const keyPath = (task, index) => safeJoinUnder(taskDir(task), 'keys', `key_${String(index).padStart(4, '0')}.bin`);
const manifestPath = task => path.join(taskDir(task), 'local.m3u8');
const outputPath = task => path.join(taskDir(task), task.outputName);
const publicTask = task => {
  const { segments, keys, ...rest } = task;
  return rest;
};
const saveTasks = () => atomicWrite(TASKS_FILE, JSON.stringify([...tasks.values()].map(publicTask), null, 2));
const broadcast = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
};
const updateTask = task => {
  if (!tasks.has(task.id)) return;
  task.updatedAt = Date.now();
  saveTasks();
  broadcast('task', publicTask(task));
  broadcast('stats', buildStats());
};
const bytesText = bytes => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const loadTasks = () => {
  try {
    if (!fs.existsSync(TASKS_FILE)) return;
    const arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    for (const task of arr) {
      if (['downloading', 'merging', 'pending', 'waiting', 'moving'].includes(task.status)) {
        task.status = 'paused';
      }
      tasks.set(task.id, task);
    }
  } catch (e) {
    log('load tasks failed:', e.message);
  }
};
loadTasks();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fetchErrorMessage = err => {
  const parts = [err?.message || String(err)];
  if (err?.cause?.code) parts.push(err.cause.code);
  if (err?.cause?.message) parts.push(err.cause.message);
  return [...new Set(parts.filter(Boolean))].join(': ');
};

const fetchText = async (url, retries = DEFAULT_CONFIG.requestRetries) => {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_CONFIG.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'VDL/0.1.0',
        'Accept': '*/*',
      },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), finalUrl: res.url || url };
  } catch (e) {
    lastError = e;
    if (attempt >= retries) break;
    await sleep(600 * (attempt + 1));
  } finally {
    clearTimeout(timer);
  }
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${fetchErrorMessage(lastError)}`);
};

const fetchJson = async url => {
  const { text } = await fetchText(url);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('response is not valid json');
  }
};

const parseAttributes = value => {
  const out = {};
  const re = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/ig;
  let m;
  while ((m = re.exec(value))) {
    out[m[1].toUpperCase()] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return out;
};

const absoluteUrl = (base, uri) => new URL(uri, base).toString();
const defaultBase = url => {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/[^/]*$/, '/');
  u.search = '';
  u.hash = '';
  return u.toString();
};

const parseM3u8 = async (m3u8Url, baseUrlInput) => {
  const first = await fetchText(m3u8Url);
  let text = first.text;
  let baseUrl = baseUrlInput || defaultBase(first.finalUrl || m3u8Url);
  let lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

  const variant = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
      const attrs = parseAttributes(lines[i].split(':').slice(1).join(':'));
      variant.push({ uri: lines[i + 1], bandwidth: parseInt(attrs.BANDWIDTH || '0', 10) || 0 });
    }
  }
  if (variant.length) {
    variant.sort((a, b) => b.bandwidth - a.bandwidth);
    const childUrl = absoluteUrl(baseUrl, variant[0].uri);
    const child = await fetchText(childUrl);
    text = child.text;
    baseUrl = baseUrlInput || defaultBase(child.finalUrl || childUrl);
    lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  }

  const segments = [];
  const keys = new Map();
  let currentKey = null;
  let initMap = null;
  let duration = 0;
  let sequence = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) continue;
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.substring('#EXTINF:'.length).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      if (attrs.METHOD && attrs.METHOD !== 'NONE' && attrs.URI) {
        const uri = absoluteUrl(baseUrl, attrs.URI);
        const keyId = crypto.createHash('sha1').update(uri).digest('hex').slice(0, 12);
        currentKey = {
          id: keyId,
          method: attrs.METHOD,
          uri,
          iv: attrs.IV || '',
        };
        keys.set(keyId, currentKey);
      } else {
        currentKey = null;
      }
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs.URI) initMap = { uri: absoluteUrl(baseUrl, attrs.URI), byterange: attrs.BYTERANGE || '' };
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push({
      index: segments.length,
      sequence: sequence + segments.length,
      uri: absoluteUrl(baseUrl, line),
      duration,
      keyId: currentKey?.id || '',
      initMap,
      status: 'pending',
      retries: 0,
      size: 0,
      error: '',
    });
    duration = 0;
  }
  if (!segments.length) throw new Error('m3u8 has no media segments');
  return { baseUrl, segments, keys: [...keys.values()], source: text };
};

const parseBaseForTask = task => {
  if (task.baseUrlOverride) return task.baseUrlOverride;
  return task.resourceType === 'ruyi' ? null : task.baseUrl;
};

const ensureTaskParsed = async task => {
  hydrateSegments(task);
  if (task.segments.length) return;
  const parsed = await parseM3u8(task.m3u8Url, parseBaseForTask(task));
  task.baseUrl = parsed.baseUrl;
  task.segments = parsed.segments;
  task.keys = parsed.keys;
  task.totalSegments = parsed.segments.length;
  fs.mkdirSync(path.join(task.tempDir, 'segments'), { recursive: true });
  fs.mkdirSync(path.join(task.tempDir, 'keys'), { recursive: true });
  persistSegments(task);
  fs.writeFileSync(path.join(task.tempDir, 'source.m3u8'), parsed.source);
  recalcProgress(task);
};

const taskActiveStatuses = ['pending', 'downloading', 'merging'];
const batchRunningCount = batchId => [...tasks.values()]
  .filter(t => t.batchId === batchId && taskActiveStatuses.includes(t.status)).length;

const scheduleBatch = batchId => {
  if (!batchId) return;
  const batchTasks = [...tasks.values()]
    .filter(t => t.batchId === batchId)
    .sort((a, b) => (a.episodeIndex || 0) - (b.episodeIndex || 0));
  const limit = Math.max(1, Math.min(parseInt(batchTasks[0]?.batchConcurrency || 1, 10) || 1, 20));
  let running = batchRunningCount(batchId);
  for (const task of batchTasks) {
    if (running >= limit) break;
    if (task.status !== 'waiting') continue;
    task.status = 'pending';
    task.error = '';
    updateTask(task);
    runDownload(task);
    running += 1;
  }
};

const extractM3u8Links = value => {
  const text = String(value || '');
  const links = [];
  const re = /https?:\/\/[^"'<>\\\s]+?\.m3u8/ig;
  let m;
  while ((m = re.exec(text))) {
    try {
      links.push(decodeURIComponent(m[0]));
    } catch {
      links.push(m[0]);
    }
  }
  return [...new Set(links)];
};

const parsePlayerInput = value => {
  const raw = String(value || '').trim();
  if (!isValidUrl(raw)) throw new Error('video address must be http(s)');
  const u = new URL(raw);
  let videoUrl = u.searchParams.get('url') || raw;
  try { videoUrl = decodeURIComponent(videoUrl); } catch {}
  const pathName = u.pathname.toLowerCase();
  return {
    rawUrl: raw,
    videoUrl,
    hasUrlParam: u.searchParams.has('url'),
    id: u.searchParams.get('id') || '',
    source: u.searchParams.get('source') || '',
    title: u.searchParams.get('title') || '',
    index: parseInt(u.searchParams.get('index') || '0', 10) || 0,
    episodesParam: u.searchParams.get('episodes') || '',
    origin: `${u.protocol}//${u.host}`,
    pageKind: pathName.includes('player.html') ? 'libretv' : (pathName.includes('player') ? 'kvedio' : 'direct'),
  };
};

const parseEpisodeList = (playUrl, playFrom = '', preferredSource = '') => {
  const sources = String(playUrl || '').split('$$$');
  const froms = String(playFrom || '').split('$$$');
  let selected = sources[0] || '';
  const preferred = froms.findIndex(name => String(name || '').toLowerCase() === String(preferredSource || '').toLowerCase());
  const direct = sources.find(source => extractM3u8Links(source).length > 0);
  const knownDirect = froms.findIndex(name => ['rym3u8', 'm3u8'].includes(String(name || '').toLowerCase()));
  if (preferred >= 0 && sources[preferred] && extractM3u8Links(sources[preferred]).length > 0) selected = sources[preferred];
  else if (knownDirect >= 0 && sources[knownDirect]) selected = sources[knownDirect];
  else if (direct) selected = direct;
  const candidates = selected.split('#').map((entry, index) => {
    const parts = entry.split('$');
    const url = parts.length > 1 ? parts.slice(1).join('$') : parts[0];
    return {
      name: sanitizeName(parts.length > 1 ? parts[0] : `第${String(index + 1).padStart(2, '0')}集`),
      url: String(url || '').trim(),
    };
  }).filter(ep => isValidUrl(ep.url));
  if (candidates.length) return candidates;
  return extractM3u8Links(playUrl).map((url, index) => ({
    name: `第${String(index + 1).padStart(2, '0')}集`,
    url,
  }));
};

const detectSourcePage = (sourcePage, input) => {
  const value = String(sourcePage || 'auto').toLowerCase();
  if (['libretv', 'kvedio'].includes(value)) return value;
  if (input.hasUrlParam) return 'libretv';
  if (input.id) return 'kvedio';
  return input.pageKind;
};

const resolveRuyiEpisodes = async (videoAddress, sourcePage = 'auto') => {
  const input = parsePlayerInput(videoAddress);
  const pageType = detectSourcePage(sourcePage, input);
  if (input.episodesParam) {
    try {
      const arr = JSON.parse(decodeURIComponent(input.episodesParam));
      if (Array.isArray(arr) && arr.length) {
        return {
          title: input.title || 'ruyi',
          episodes: arr.filter(isValidUrl).map((url, index) => ({
            name: `第${String(index + 1).padStart(2, '0')}集`,
            url,
          })),
        };
      }
    } catch {}
  }

  if (pageType === 'libretv' && input.hasUrlParam && isValidUrl(input.videoUrl)) {
    return {
      title: input.title || 'ruyi',
      episodes: [{
        name: `第${String(input.index + 1).padStart(2, '0')}集`,
        url: input.videoUrl,
      }],
    };
  }

  if (input.id && (!input.source || input.source === 'ruyi')) {
    const detail = await fetchJson(`${RUYI_API}?ac=videolist&ids=${encodeURIComponent(input.id)}`);
    const item = Array.isArray(detail.list) ? detail.list[0] : null;
    if (item?.vod_play_url) {
      const episodes = parseEpisodeList(item.vod_play_url, item.vod_play_from, input.source);
      if (episodes.length) return { title: item.vod_name || input.title || 'ruyi', episodes };
    }
  }

  if (isValidUrl(input.videoUrl)) {
    return {
      title: input.title || 'ruyi',
      episodes: [{
        name: `第${String(input.index + 1).padStart(2, '0')}集`,
        url: input.videoUrl,
      }],
    };
  }

  const page = await fetchText(input.rawUrl);
  const links = extractM3u8Links(page.text);
  return {
    title: input.title || 'ruyi',
    episodes: links.map((url, index) => ({
      name: `第${String(index + 1).padStart(2, '0')}集`,
      url,
    })),
  };
};

const markInterruptedSegmentsPending = task => {
  hydrateSegments(task);
  for (const seg of task.segments) {
    if (seg.status === 'downloading') {
      seg.status = 'pending';
      seg.error = '';
    }
  }
  recalcProgress(task);
  persistSegments(task);
};

const downloadFile = async (url, dest, control = null) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const ctrl = new AbortController();
  if (control?.stopped || control?.paused) throw new Error('interrupted');
  control?.controllers.add(ctrl);
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_CONFIG.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'VDL/0.1.0' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return fs.statSync(dest).size;
  } finally {
    clearTimeout(timer);
    control?.controllers.delete(ctrl);
  }
};

const persistSegments = task => {
  atomicWrite(segmentsFile(task), JSON.stringify({
    segments: task.segments,
    keys: task.keys || [],
  }, null, 2));
};
const hydrateSegments = task => {
  if (task.segments?.length) return;
  const fp = segmentsFile(task);
  if (fs.existsSync(fp)) {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    task.segments = data.segments || [];
    task.keys = data.keys || [];
  } else {
    task.segments = [];
    task.keys = [];
  }
};

const recalcProgress = task => {
  hydrateSegments(task);
  const total = task.segments.length;
  const done = task.segments.filter(s => s.status === 'done').length;
  const failed = task.segments.filter(s => s.status === 'failed').length;
  task.totalSegments = total;
  task.doneSegments = done;
  task.failedSegments = failed;
  task.downloadedBytes = task.segments.reduce((sum, s) => sum + (s.size || 0), 0);
  task.progress = total ? Math.round((done / total) * 1000) / 10 : 0;
};

const buildLocalManifest = task => {
  hydrateSegments(task);
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-MEDIA-SEQUENCE:0'];
  const target = Math.max(1, Math.ceil(Math.max(...task.segments.map(s => s.duration || 1))));
  lines.push(`#EXT-X-TARGETDURATION:${target}`);
  const keys = new Map((task.keys || []).map(k => [k.id, k]));
  const writtenKeys = new Set();
  let lastKey = '';
  for (const seg of task.segments) {
    if (seg.status !== 'done') continue;
    if (seg.keyId && seg.keyId !== lastKey) {
      const key = keys.get(seg.keyId);
      if (key) {
        const kp = keyPath(task, [...keys.keys()].indexOf(seg.keyId));
        if (!writtenKeys.has(seg.keyId) && !fs.existsSync(kp)) {
          throw new Error(`key not downloaded: ${seg.keyId}`);
        }
        const iv = key.iv ? `,IV=${key.iv}` : '';
        lines.push(`#EXT-X-KEY:METHOD=${key.method},URI="${kp.replace(/\\/g, '/')}"${iv}`);
        writtenKeys.add(seg.keyId);
      }
      lastKey = seg.keyId;
    }
    lines.push(`#EXTINF:${seg.duration || 0},`);
    lines.push(localSegmentPath(task, seg.index).replace(/\\/g, '/'));
  }
  lines.push('#EXT-X-ENDLIST');
  fs.writeFileSync(manifestPath(task), lines.join('\n') + '\n');
};

const runFfmpeg = task => new Promise((resolve, reject) => {
  buildLocalManifest(task);
  const out = outputPath(task);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-allowed_extensions', 'ALL',
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
    '-i', manifestPath(task),
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-y',
    out,
  ];
  const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', c => { err += c.toString(); });
  proc.on('error', reject);
  proc.on('close', code => {
    if (code === 0 && fs.existsSync(out)) resolve(out);
    else reject(new Error(err.trim() || `ffmpeg exit ${code}`));
  });
});

const concatSegments = task => new Promise((resolve, reject) => {
  hydrateSegments(task);
  const out = outputPath(task);
  const ws = fs.createWriteStream(out);
  ws.on('error', reject);
  ws.on('finish', () => resolve(out));
  for (const seg of task.segments) {
    if (seg.status !== 'done') continue;
    const fp = localSegmentPath(task, seg.index);
    if (!fs.existsSync(fp)) continue;
    ws.write(fs.readFileSync(fp));
  }
  ws.end();
});

const mergeTask = async task => {
  hydrateSegments(task);
  if (!task.segments.some(s => s.status === 'done')) throw new Error('no downloaded segments to merge');
  task.status = 'merging';
  task.error = '';
  updateTask(task);
  try {
    let out;
    try {
      out = await runFfmpeg(task);
      task.mergeEngine = 'ffmpeg';
    } catch (e) {
      log('ffmpeg merge failed, fallback concat:', task.id, e.message);
      out = await concatSegments(task);
      task.mergeEngine = 'concat';
    }
    task.outputPath = out;
    task.outputSize = fs.statSync(out).size;
    task.status = task.failedSegments > 0 ? 'partial' : 'success';
    task.completedAt = Date.now();
    updateTask(task);
    return out;
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
    updateTask(task);
    throw e;
  }
};

const canMergeTask = task => {
  if (active.has(task.id)) return false;
  if (!['downloaded', 'failed', 'partial', 'stopped', 'paused'].includes(task.status)) return false;
  hydrateSegments(task);
  recalcProgress(task);
  return task.doneSegments > 0;
};

const startMergeTask = task => {
  if (task.status === 'merging') throw new Error('task is already merging');
  if (!canMergeTask(task)) throw new Error('task is not ready to merge');
  mergeTask(task).catch(e => log('merge failed:', task.id, e.message));
};

const downloadKeys = async (task, control) => {
  const keys = task.keys || [];
  for (let i = 0; i < keys.length; i += 1) {
    if (control.paused || control.stopped) throw new Error('interrupted');
    const dest = keyPath(task, i);
    if (!fs.existsSync(dest)) await downloadFile(keys[i].uri, dest, control);
  }
};

const runDownload = async task => {
  if (active.has(task.id)) return;
  active.add(task.id);
  const control = { paused: false, stopped: false, controllers: new Set() };
  controls.set(task.id, control);
  hydrateSegments(task);
  task.status = 'downloading';
  task.startedAt ||= Date.now();
  task.error = '';
  updateTask(task);
  try {
    await ensureTaskParsed(task);
    updateTask(task);
    await downloadKeys(task, control);
    let cursor = 0;
    let lastPersist = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(task.concurrency || DEFAULT_CONFIG.concurrency, 128)) }, async () => {
      while (cursor < task.segments.length) {
        if (control.paused || control.stopped) break;
        const seg = task.segments[cursor++];
        if (!seg || seg.status === 'done') continue;
        const dest = localSegmentPath(task, seg.index);
        if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
          seg.status = 'done';
          seg.size = fs.statSync(dest).size;
          recalcProgress(task);
          continue;
        }
        seg.status = 'downloading';
        seg.error = '';
        let ok = false;
        for (let attempt = 0; attempt <= (task.retries ?? DEFAULT_CONFIG.retries); attempt += 1) {
          if (control.paused || control.stopped) {
            seg.status = 'pending';
            seg.error = '';
            break;
          }
          try {
            seg.retries = attempt;
            seg.size = await downloadFile(seg.uri, dest, control);
            seg.status = 'done';
            ok = true;
            break;
          } catch (e) {
            if (control.paused || control.stopped) {
              seg.status = 'pending';
              seg.error = '';
              break;
            }
            seg.error = fetchErrorMessage(e);
            log('segment download failed:', task.id, seg.index, seg.uri, seg.error);
            if (attempt >= (task.retries ?? DEFAULT_CONFIG.retries)) {
              seg.status = 'failed';
            }
          }
        }
        recalcProgress(task);
        const now = Date.now();
        if (now - lastPersist > 500) {
          lastPersist = now;
          persistSegments(task);
          updateTask(task);
        }
      }
    });
    await Promise.all(workers);
    recalcProgress(task);
    persistSegments(task);
    if (control.paused || control.stopped) {
      markInterruptedSegmentsPending(task);
      task.status = control.stopped ? 'stopped' : 'paused';
      task.error = '';
      updateTask(task);
      return;
    }
    if (task.failedSegments > 0) {
      task.status = 'failed';
      task.error = `${task.failedSegments} segment(s) failed`;
      updateTask(task);
      return;
    }
    if (task.autoMerge) await mergeTask(task);
    else {
      task.status = 'downloaded';
      task.completedAt = Date.now();
      updateTask(task);
    }
  } catch (e) {
    if (control.paused || control.stopped || e.message === 'interrupted') {
      markInterruptedSegmentsPending(task);
      task.status = control.stopped ? 'stopped' : 'paused';
      task.error = '';
    } else {
      task.status = 'failed';
      task.error = e.message;
    }
    updateTask(task);
  } finally {
    for (const ctrl of control.controllers) {
      try { ctrl.abort(); } catch {}
    }
    controls.delete(task.id);
    active.delete(task.id);
    if (task.batchId) scheduleBatch(task.batchId);
  }
};

const createM3u8Task = async (body, options = {}) => {
  const m3u8Url = String(options.m3u8Url || body.m3u8Url || '').trim();
  if (!isValidUrl(m3u8Url)) throw new Error('m3u8 address must be http(s)');
  const explicitBaseUrl = String(options.baseUrl ?? body.baseUrl ?? '').trim();
  const baseUrl = explicitBaseUrl || defaultBase(m3u8Url);
  if (!isValidUrl(baseUrl)) throw new Error('base address must be http(s)');
  const id = `task_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const outputName = withMp4Ext(options.outputName || body.outputName || `video_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  const tempRoot = path.resolve(String(body.tempRoot || DEFAULT_CONFIG.tempRoot).trim() || DEFAULT_CONFIG.tempRoot);
  const tempDir = safeJoinUnder(tempRoot, id);
  fs.mkdirSync(path.join(tempDir, 'segments'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, 'keys'), { recursive: true });

  const task = {
    id,
    m3u8Url,
    baseUrl,
    baseUrlOverride: explicitBaseUrl,
    resourceType: options.resourceType || body.resourceType || 'other',
    batchId: options.batchId || '',
    batchTitle: options.batchTitle || '',
    batchConcurrency: parseInt(options.batchConcurrency || body.taskConcurrency || 1, 10) || 1,
    episodeName: options.episodeName || '',
    episodeIndex: options.episodeIndex || 0,
    tempRoot,
    tempDir,
    outputName,
    autoMerge: body.autoMerge === true,
    concurrency: parseInt(
      body.concurrency || (options.resourceType === 'ruyi' ? DEFAULT_CONFIG.ruyiConcurrency : DEFAULT_CONFIG.concurrency),
      10,
    ) || (options.resourceType === 'ruyi' ? DEFAULT_CONFIG.ruyiConcurrency : DEFAULT_CONFIG.concurrency),
    retries: parseInt(body.retries || DEFAULT_CONFIG.retries, 10) || DEFAULT_CONFIG.retries,
    status: options.initialStatus || 'pending',
    progress: 0,
    totalSegments: 0,
    doneSegments: 0,
    failedSegments: 0,
    downloadedBytes: 0,
    outputPath: '',
    movedPath: '',
    outputSize: 0,
    error: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: 0,
    completedAt: 0,
    mergeEngine: '',
    segments: [],
    keys: [],
  };

  tasks.set(id, task);
  updateTask(task);
  try {
    if (options.deferParse !== true) {
      await ensureTaskParsed(task);
      updateTask(task);
    }
    if (options.autoStart !== false) runDownload(task);
    return task;
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
    updateTask(task);
    if (options.continueOnError) return task;
    throw e;
  }
};

const createTask = async body => {
  const resourceType = String(body.resourceType || 'other');
  if (resourceType !== 'ruyi') return { task: await createM3u8Task(body) };

  const videoAddress = String(body.videoAddress || body.m3u8Url || '').trim();
  const mode = body.ruyiMode === 'all' ? 'all' : 'single';
  const resolved = await resolveRuyiEpisodes(videoAddress, body.sourcePage);
  if (!resolved.episodes.length) throw new Error('no ruyi episodes found');

  if (mode === 'single') {
    const parsedInput = parsePlayerInput(videoAddress);
    const episode = resolved.episodes[Math.min(Math.max(parsedInput.index || 0, 0), resolved.episodes.length - 1)] || resolved.episodes[0];
    const name = String(body.episodeName || episode.name || resolved.title || '').trim();
    return {
      task: await createM3u8Task(body, {
        m3u8Url: episode.url,
        outputName: name || body.outputName || episode.name,
        resourceType: 'ruyi',
        episodeName: name || episode.name,
        episodeIndex: resolved.episodes.indexOf(episode),
      }),
    };
  }

  const batchId = `batch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const batchConcurrency = Math.max(1, Math.min(parseInt(body.taskConcurrency || 1, 10) || 1, 20));
  const tasksCreated = [];
  for (let i = 0; i < resolved.episodes.length; i += 1) {
    const episode = resolved.episodes[i];
    const prefix = sanitizeName(resolved.title || 'ruyi');
    const episodeName = episode.name || `第${String(i + 1).padStart(2, '0')}集`;
    const outputName = `${prefix}_${sanitizeName(episodeName)}.mp4`;
    const task = await createM3u8Task(body, {
      m3u8Url: episode.url,
      outputName,
      resourceType: 'ruyi',
      batchId,
      batchTitle: resolved.title || '',
      batchConcurrency,
      episodeName,
      episodeIndex: i,
      initialStatus: i < batchConcurrency ? 'pending' : 'waiting',
      autoStart: i < batchConcurrency,
      deferParse: true,
      continueOnError: true,
    });
    tasksCreated.push(task);
  }
  scheduleBatch(batchId);
  return { tasks: tasksCreated };
};

const retryTask = async task => {
  hydrateSegments(task);
  if (!task.segments.length) {
    task.status = 'pending';
    task.error = '';
    updateTask(task);
    try {
      await ensureTaskParsed(task);
    } catch (e) {
      task.status = 'failed';
      task.error = e.message;
      updateTask(task);
      throw e;
    }
  }
  for (const seg of task.segments) {
    if (seg.status === 'failed' || seg.status === 'downloading') {
      seg.status = 'pending';
      seg.error = '';
    }
  }
  recalcProgress(task);
  persistSegments(task);
  runDownload(task);
};

const pauseTask = task => {
  const control = controls.get(task.id);
  if (control) {
    control.paused = true;
    for (const ctrl of control.controllers) {
      try { ctrl.abort(); } catch {}
    }
    task.status = 'paused';
    task.error = '';
    updateTask(task);
    return true;
  }
  if (['pending', 'waiting', 'downloading'].includes(task.status)) {
    task.status = 'paused';
    task.error = '';
    markInterruptedSegmentsPending(task);
    updateTask(task);
    return true;
  }
  return false;
};

const stopTask = task => {
  const control = controls.get(task.id);
  if (control) {
    control.stopped = true;
    for (const ctrl of control.controllers) {
      try { ctrl.abort(); } catch {}
    }
  }
  task.status = 'stopped';
  task.error = '';
  markInterruptedSegmentsPending(task);
  updateTask(task);
  return true;
};

const resumeTask = task => {
  if (active.has(task.id)) return false;
  hydrateSegments(task);
  for (const seg of task.segments) {
    if (seg.status === 'downloading') seg.status = 'pending';
  }
  task.status = task.batchId ? 'waiting' : 'pending';
  task.error = '';
  recalcProgress(task);
  persistSegments(task);
  updateTask(task);
  if (task.batchId) scheduleBatch(task.batchId);
  else runDownload(task);
  return true;
};

const moveTask = (task, destDir) => {
  const src = task.movedPath || task.outputPath || outputPath(task);
  if (!src || !fs.existsSync(src)) throw new Error('output video does not exist');
  const targetDir = path.resolve(String(destDir || '').trim());
  if (!targetDir || targetDir === path.parse(targetDir).root) throw new Error('invalid target directory');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(src));
  if (path.resolve(src) === path.resolve(target)) return target;
  try {
    fs.renameSync(src, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(src, target);
    const srcSize = fs.statSync(src).size;
    const targetSize = fs.statSync(target).size;
    if (srcSize !== targetSize) {
      try { fs.rmSync(target, { force: true }); } catch {}
      throw new Error(`copy failed: size mismatch (${srcSize} != ${targetSize})`);
    }
    fs.rmSync(src, { force: true });
  }
  task.movedPath = target;
  task.outputPath = '';
  task.status = 'moved';
  updateTask(task);
  return target;
};

const moveTaskAsync = async (task, destDir, previousStatus = task.status) => {
  const src = task.movedPath || task.outputPath || outputPath(task);
  if (!src || !fs.existsSync(src)) throw new Error('output video does not exist');
  const targetDir = path.resolve(String(destDir || '').trim());
  if (!targetDir || targetDir === path.parse(targetDir).root) throw new Error('invalid target directory');
  await fs.promises.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, path.basename(src));
  if (path.resolve(src) === path.resolve(target)) return target;

  task.status = 'moving';
  task.error = '';
  updateTask(task);
  try {
    try {
      await fs.promises.rename(src, target);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      await fs.promises.copyFile(src, target);
      const [srcStat, targetStat] = await Promise.all([
        fs.promises.stat(src),
        fs.promises.stat(target),
      ]);
      if (srcStat.size !== targetStat.size) {
        try { await fs.promises.rm(target, { force: true }); } catch {}
        throw new Error(`copy failed: size mismatch (${srcStat.size} != ${targetStat.size})`);
      }
      await fs.promises.rm(src, { force: true });
    }
    task.movedPath = target;
    task.outputPath = '';
    task.status = 'moved';
    updateTask(task);
    return target;
  } catch (e) {
    task.status = previousStatus;
    task.error = e.message;
    updateTask(task);
    throw e;
  }
};

const startMoveTask = (task, destDir) => {
  const src = task.movedPath || task.outputPath || outputPath(task);
  if (!src || !fs.existsSync(src)) throw new Error('output video does not exist');
  if (task.status === 'moving') throw new Error('task is already moving');
  const targetDir = path.resolve(String(destDir || '').trim());
  if (!targetDir || targetDir === path.parse(targetDir).root) throw new Error('invalid target directory');
  task.moveTargetDir = targetDir;
  const previousStatus = task.status;
  task.status = 'moving';
  task.error = '';
  updateTask(task);
  moveTaskAsync(task, targetDir, previousStatus).catch(e => log('move failed:', task.id, e.message));
};

const stopTaskForDelete = task => {
  const control = controls.get(task.id);
  if (control) {
    control.stopped = true;
    for (const ctrl of control.controllers) {
      try { ctrl.abort(); } catch {}
    }
  }
};

const deleteTask = task => {
  stopTaskForDelete(task);
  tasks.delete(task.id);
  saveTasks();
  if (task.tempDir && fs.existsSync(task.tempDir)) {
    fs.rmSync(task.tempDir, { recursive: true, force: true });
  }
  broadcast('delete', { id: task.id });
  broadcast('stats', buildStats());
};

const deleteAllTasks = () => {
  const ids = [...tasks.keys()];
  for (const task of tasks.values()) stopTaskForDelete(task);
  for (const task of [...tasks.values()]) {
    tasks.delete(task.id);
    if (task.tempDir && fs.existsSync(task.tempDir)) {
      try { fs.rmSync(task.tempDir, { recursive: true, force: true }); } catch (e) { log('delete temp failed:', task.id, e.message); }
    }
  }
  saveTasks();
  for (const id of ids) broadcast('delete', { id });
  broadcast('stats', buildStats());
  return { deleted: ids.length };
};

const moveAllTasks = destDir => {
  const result = { started: 0, skipped: 0, failed: 0, errors: [] };
  const movableStatuses = new Set(['success', 'partial']);
  for (const task of tasks.values()) {
    if (task.status === 'moving') {
      result.skipped += 1;
      continue;
    }
    if (!movableStatuses.has(task.status) || (!task.outputPath && !task.movedPath)) {
      result.skipped += 1;
      continue;
    }
    try {
      startMoveTask(task, destDir);
      result.started += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push({ id: task.id, name: task.outputName, error: e.message });
    }
  }
  return result;
};

const mergeAllTasks = () => {
  const result = { started: 0, skipped: 0, failed: 0, errors: [] };
  for (const task of tasks.values()) {
    if (task.status === 'merging') {
      result.skipped += 1;
      continue;
    }
    try {
      if (!canMergeTask(task)) {
        result.skipped += 1;
        continue;
      }
      startMergeTask(task);
      result.started += 1;
    } catch (e) {
      result.failed += 1;
      result.errors.push({ id: task.id, name: task.outputName, error: e.message });
    }
  }
  return result;
};

const buildStats = () => {
  const all = [...tasks.values()];
  const running = all.filter(t => ['waiting', 'pending', 'downloading', 'merging', 'moving'].includes(t.status)).length;
  const success = all.filter(t => ['success', 'moved'].includes(t.status)).length;
  const failed = all.filter(t => t.status === 'failed').length;
  const completed = all.filter(t => ['downloaded', 'success', 'partial', 'moved'].includes(t.status)).length;
  return { total: all.length, running, completed, success, failed };
};

const browse = dir => {
  const current = path.resolve(dir || DEFAULT_CONFIG.outputRoot);
  if (!fs.existsSync(current)) throw new Error('directory does not exist');
  if (!fs.statSync(current).isDirectory()) throw new Error('not a directory');
  const directories = fs.readdirSync(current, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => ({ name: d.name, path: path.join(current, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { currentPath: current, parentPath: path.dirname(current), directories, isRoot: current === path.parse(current).root };
};

const handleSse = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: stats\ndata: ${JSON.stringify(buildStats())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
};

const serveStatic = (pathname, res) => {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  if (rel.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
  let fp = path.join(UI_DIR, rel);
  if (!fp.startsWith(UI_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) fp = path.join(UI_DIR, 'index.html');
  const ext = path.extname(fp).toLowerCase();
  const contentType = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(fp).pipe(res);
};

const handle = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let pathname = url.pathname;
  if (pathname === BASE_PATH) {
    res.writeHead(308, { Location: `${BASE_PATH}/${url.search}` });
    res.end();
    return;
  }
  if (pathname.startsWith(BASE_PATH)) pathname = pathname.slice(BASE_PATH.length) || '/';
  try {
    if (pathname === '/api/health') return sendJSON(res, 200, { ok: true, version: VERSION, port: PORT, dataDir: DATA_DIR });
    if (pathname === '/api/events') return handleSse(req, res);
    if (pathname === '/api/stats') return sendJSON(res, 200, buildStats());
    if (pathname === '/api/defaults') return sendJSON(res, 200, DEFAULT_CONFIG);
    if (pathname === '/api/tasks' && req.method === 'GET') {
      return sendJSON(res, 200, { tasks: [...tasks.values()].map(t => {
        recalcProgress(t);
        return publicTask(t);
      }) });
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await createTask(body);
      if (result.tasks) return sendJSON(res, 200, { tasks: result.tasks.map(publicTask) });
      return sendJSON(res, 200, { task: publicTask(result.task) });
    }
    if (pathname === '/api/tasks/bulk/delete' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: true, ...deleteAllTasks() });
    }
    if (pathname === '/api/tasks/bulk/move' && req.method === 'POST') {
      const body = await readBody(req);
      return sendJSON(res, 200, { ok: true, ...moveAllTasks(body.destDir) });
    }
    if (pathname === '/api/tasks/bulk/merge' && req.method === 'POST') {
      return sendJSON(res, 200, { ok: true, ...mergeAllTasks() });
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/([^/]+))?$/);
    if (taskMatch) {
      const task = tasks.get(taskMatch[1]);
      if (!task) return sendJSON(res, 404, { error: 'task not found' });
      const action = taskMatch[2] || '';
      if (req.method === 'GET' && !action) {
        hydrateSegments(task);
        recalcProgress(task);
        return sendJSON(res, 200, { task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'retry') {
        await retryTask(task);
        return sendJSON(res, 200, { ok: true, task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'pause') {
        const ok = pauseTask(task);
        return sendJSON(res, 200, { ok, task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'resume') {
        const ok = resumeTask(task);
        return sendJSON(res, 200, { ok, task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'stop') {
        const ok = stopTask(task);
        return sendJSON(res, 200, { ok, task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'merge') {
        hydrateSegments(task);
        recalcProgress(task);
        startMergeTask(task);
        return sendJSON(res, 202, { ok: true, task: publicTask(task) });
      }
      if (req.method === 'POST' && action === 'move') {
        const body = await readBody(req);
        startMoveTask(task, body.destDir);
        return sendJSON(res, 202, { ok: true, task: publicTask(task) });
      }
      if (req.method === 'DELETE' && !action) {
        deleteTask(task);
        return sendJSON(res, 200, { ok: true });
      }
    }
    if (pathname === '/api/browse' && req.method === 'GET') {
      return sendJSON(res, 200, browse(url.searchParams.get('path')));
    }
    if (!pathname.startsWith('/api')) return serveStatic(pathname, res);
    sendJSON(res, 404, { error: 'not found' });
  } catch (e) {
    log('request failed:', pathname, e.message);
    sendJSON(res, 500, { error: e.message });
  }
};

const isAbortError = err => err?.name === 'AbortError' || String(err?.message || err).includes('operation was aborted');

process.on('unhandledRejection', reason => {
  if (isAbortError(reason)) {
    log('download request aborted');
    return;
  }
  log('unhandledRejection:', reason instanceof Error ? reason.stack : String(reason));
});
process.on('uncaughtException', err => {
  if (isAbortError(err)) {
    log('download request aborted');
    return;
  }
  log('uncaughtException:', err.stack || err.message);
  process.exit(1);
});

const main = () => {
  const httpServer = http.createServer(handle);
  httpServer.listen(PORT, '0.0.0.0', () => log(`HTTP listening on ${PORT}`));

  const sockServer = http.createServer(handle);
  if (process.platform !== 'win32') {
    if (fs.existsSync(SOCK_PATH)) fs.unlinkSync(SOCK_PATH);
    sockServer.listen(SOCK_PATH, () => log(`UNIX socket listening on ${SOCK_PATH}`));
  }

  const shutdown = () => {
    log('shutdown');
    saveTasks();
    try { httpServer.close(); } catch {}
    try { sockServer.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main();
