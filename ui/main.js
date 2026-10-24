const $ = selector => document.querySelector(selector);
const API_BASE = location.pathname.startsWith('/app/vdl') ? '/app/vdl' : '';

const taskList = $('#taskList');
const taskDialog = $('#taskDialog');
const form = $('#taskForm');
const formMessage = $('#formMessage');
const moveDialog = $('#moveDialog');
const moveForm = $('#moveForm');
const moveDest = $('#moveDest');
const browseDialog = $('#browseDialog');
const browsePath = $('#browsePath');
const browseList = $('#browseList');
const playerDialog = $('#playerDialog');
const playerVideo = $('#playerVideo');
const playerTitle = $('#playerTitle');
const playerMessage = $('#playerMessage');
const notice = $('#pageNotice');
const noticeText = $('#noticeText');

let tasks = [];
let filterValue = 'all';
let moveTaskId = '';
let moveMode = 'single';
let currentBrowsePath = '';
let currentBrowseParent = '';

const VIEWS = {
  all: '全部任务',
  running: '进行中',
  toMerge: '待合并',
  failed: '失败',
  finished: '已完成',
};
const RUNNING_STATUSES = ['waiting', 'pending', 'downloading', 'merging', 'moving'];
const DONE_STATUSES = ['success', 'partial', 'moved'];
// 队列顺序：需要处理的在前，同组内按创建时间倒序
const STATUS_RANK = {
  failed: 0,
  downloading: 1,
  merging: 2,
  moving: 3,
  waiting: 4,
  pending: 4,
  downloaded: 5,
  paused: 6,
  stopped: 7,
  partial: 8,
  success: 9,
  moved: 10,
};
const sortTasks = list => list.sort((a, b) => (
  (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99)
  || (b.createdAt || 0) - (a.createdAt || 0)
));

const STATUS_TEXT = {
  waiting: ['排队中', 'neutral'],
  pending: ['排队中', 'neutral'],
  downloading: ['下载中', 'neutral'],
  downloaded: ['待合并', 'warning'],
  merging: ['合并中', 'neutral'],
  moving: ['移动中', 'neutral'],
  success: ['已完成', 'positive'],
  partial: ['部分合并', 'warning'],
  failed: ['失败', 'negative'],
  paused: ['已暂停', 'neutral'],
  stopped: ['已停止', 'neutral'],
  moved: ['已移动', 'positive'],
};

const PRIMARY_ACTION = {
  waiting: 'pause',
  pending: 'pause',
  downloading: 'pause',
  paused: 'resume',
  stopped: 'resume',
  failed: 'retry',
  downloaded: 'merge',
  success: 'play',
  partial: 'play',
  moved: 'play',
};

const api = async (path, options = {}) => {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}[ch]));

const pad2 = n => String(n).padStart(2, '0');
const fmtNum = value => Number(value || 0).toLocaleString('zh-CN');
const sizeParts = bytes => {
  const value = Number(bytes) || 0;
  if (!value) return { value: '0', unit: 'B' };
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = value;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return { value: v.toFixed(i ? 1 : 0), unit: units[i] };
};
const sizeHtml = bytes => {
  const parts = sizeParts(bytes);
  return `<span class="num">${parts.value}</span> <span class="unit">${parts.unit}</span>`;
};
const dateParts = value => {
  if (!value) return null;
  const d = new Date(value);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
};
const timeHtml = value => {
  const parts = dateParts(value);
  return parts
    ? `<span class="num">${parts.date}</span><span class="num">${parts.time}</span>`
    : '<span class="dash">—</span>';
};
const shortPath = value => {
  const text = String(value || '').replace(/\\/g, '/');
  if (!text) return '';
  if (text.length <= 26) return text;
  const parts = text.split('/').filter(Boolean);
  const tail = parts.slice(-2).join('/');
  return tail.length <= 26 ? `…/${tail}` : `…${text.slice(-25)}`;
};

const elementFromHtml = html => {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
};

const visibleTasks = () => {
  if (filterValue === 'running') return tasks.filter(t => RUNNING_STATUSES.includes(t.status));
  if (filterValue === 'toMerge') return tasks.filter(t => t.status === 'downloaded');
  if (filterValue === 'failed') return tasks.filter(t => t.status === 'failed');
  if (filterValue === 'finished') return tasks.filter(t => DONE_STATUSES.includes(t.status));
  return tasks;
};

const viewCounts = () => ({
  all: tasks.length,
  running: tasks.filter(t => RUNNING_STATUSES.includes(t.status)).length,
  toMerge: tasks.filter(t => t.status === 'downloaded').length,
  failed: tasks.filter(t => t.status === 'failed').length,
  finished: tasks.filter(t => DONE_STATUSES.includes(t.status)).length,
});

const showNotice = (text, isError = false) => {
  notice.hidden = false;
  noticeText.textContent = text;
  notice.classList.toggle('error', isError);
};
const hideNotice = () => { notice.hidden = true; };

const summaryLine = () => {
  if (!tasks.length) return '队列为空，新增任务后会出现在这里。';
  const failed = tasks
    .filter(t => t.status === 'failed')
    .sort((a, b) => (b.failedSegments || 0) - (a.failedSegments || 0))[0];
  if (failed) {
    const count = fmtNum(failed.failedSegments);
    return `${failed.outputName} 有 ${count} 片失败，重试后继续；失败的切片在进度条里标红。`;
  }
  const active = tasks.find(t => t.status === 'downloading');
  if (active) {
    const pct = active.totalSegments ? Math.round((active.doneSegments / active.totalSegments) * 1000) / 10 : 0;
    return `${active.outputName} 正在下载，已完成 ${pct}%（${fmtNum(active.doneSegments)} / ${fmtNum(active.totalSegments)} 片）。`;
  }
  const merging = tasks.find(t => t.status === 'merging');
  if (merging) return `${merging.outputName} 正在合并，完成后即可播放。`;
  const waitingMerge = tasks.filter(t => t.status === 'downloaded').length;
  if (waitingMerge) return `${waitingMerge} 个任务等待合并，合并后可以播放或移动。`;
  return '队列空闲，当前没有进行中的任务。';
};

const freshnessLine = () => {
  const latest = tasks.reduce((max, t) => Math.max(max, t.updatedAt || 0), 0);
  const parts = dateParts(latest);
  return parts ? `更新于 ${parts.time}` : '';
};

const updateSummary = () => {
  const counts = viewCounts();
  const failedEl = $('#statFailed');
  $('#statRunning').textContent = counts.running;
  $('#statToMerge').textContent = counts.toMerge;
  failedEl.textContent = counts.failed;
  failedEl.classList.toggle('negative', counts.failed > 0);
  $('#statDone').textContent = counts.finished;

  const volume = tasks.reduce((sum, t) => sum + (t.downloadedBytes || 0), 0);
  const parts = sizeParts(volume);
  $('#statVolume').innerHTML = `${parts.value}<span class="unit">${parts.unit}</span>`;

  document.querySelectorAll('#filter [data-count]').forEach(el => {
    el.textContent = counts[el.dataset.count] ?? 0;
  });

  $('#queueTitleText').textContent = VIEWS[filterValue];
  $('#queueCount').textContent = visibleTasks().length;
  $('#pageFinding').textContent = summaryLine();
  $('#freshness').textContent = freshnessLine();
};

const stripHtml = task => {
  const total = task.totalSegments || 0;
  if (!total) return { strip: '<div class="strip-none">—</div>', nums: '' };
  const done = task.doneSegments || 0;
  const pct = Math.round((done / total) * 1000) / 10;
  const seq = task.segmentStrip || '';
  const cells = [...seq].map(ch => `<i class="s-${ch}"></i>`).join('');
  const active = task.status === 'downloading' ? ' active' : '';
  return {
    strip: `<div class="strip${active}" role="img" aria-label="切片 ${fmtNum(done)} / ${fmtNum(total)} 片">${cells}</div>`,
    nums: `<div class="slice-nums"><span><span class="num">${fmtNum(done)}</span><span class="total num"> / ${fmtNum(total)}</span></span><span class="pct num">${pct}%</span></div>`,
  };
};

const actionItems = task => {
  const mergeable = (task.doneSegments || 0) - (task.adRemovedSegments || 0);
  const items = [];
  if (['waiting', 'pending', 'downloading'].includes(task.status)) items.push({ action: 'pause', label: '暂停' });
  if (['paused', 'stopped'].includes(task.status)) items.push({ action: 'resume', label: '继续' });
  if (['waiting', 'pending', 'downloading', 'paused'].includes(task.status)) items.push({ action: 'stop', label: '停止' });
  if (task.status === 'failed' || (task.failedSegments || 0) > 0) items.push({ action: 'retry', label: '重试' });
  if (['downloaded', 'failed', 'partial', 'stopped', 'paused'].includes(task.status) && mergeable > 0) {
    items.push({ action: 'remove-ads', label: '去广告' });
    items.push({ action: 'merge', label: '合并' });
  }
  if (['success', 'partial'].includes(task.status) && (task.outputPath || task.movedPath)) items.push({ action: 'move', label: '移动' });
  if (['success', 'partial', 'moved'].includes(task.status) && (task.outputPath || task.movedPath)) items.push({ action: 'play', label: '播放' });
  items.push({ action: 'delete', label: '删除', danger: true });
  const wanted = PRIMARY_ACTION[task.status];
  const primary = items.find(item => item.action === wanted) || null;
  return { primary, rest: items.filter(item => item !== primary) };
};

const kebabIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="19" r="1.7"/></svg>';

const actionsHtml = task => {
  const { primary, rest } = actionItems(task);
  return `${primary ? `<button type="button" class="row-action" data-action="${primary.action}">${primary.label}</button>` : ''}
    <button type="button" class="kebab" data-menu aria-haspopup="menu" aria-expanded="false" aria-label="更多操作">${kebabIcon}</button>
    <div class="menu" role="menu" hidden>${rest.map(item => `<button type="button" role="menuitem" data-action="${item.action}"${item.danger ? ' class="danger"' : ''}>${item.label}</button>`).join('')}</div>`;
};

const rowHtml = task => {
  const [statusText, tone] = STATUS_TEXT[task.status] || [task.status, 'neutral'];
  const noteParts = [];
  if (task.batchTitle || task.episodeName) {
    noteParts.push([task.batchTitle, task.episodeName].filter(Boolean).join(' / '));
  }
  if (task.adRemovedSegments) noteParts.push(`已去广告 ${fmtNum(task.adRemovedSegments)} 片`);
  if (task.error) {
    // 服务端的段错误文案是英文，列表里用产品自己的说法
    noteParts.push(/segment/i.test(task.error) && task.failedSegments
      ? `${fmtNum(task.failedSegments)} 片下载失败`
      : task.error);
  }
  const note = noteParts.join(' · ');
  const filePath = task.movedPath || task.outputPath || '';
  const pathLabel = task.movedPath ? shortPath(task.movedPath) : (task.outputPath ? '临时目录' : '—');
  const pathTitle = filePath || task.tempDir || '';
  const slices = stripHtml(task);
  return `
    <article class="task" data-id="${escapeHtml(task.id)}" data-status="${escapeHtml(task.status)}">
      <div class="task-id">
        <div class="task-name" title="${escapeHtml(task.m3u8Url || '')}">${escapeHtml(task.outputName)}</div>
        <div class="task-sub" title="${escapeHtml([task.m3u8Url, task.tempDir].filter(Boolean).join('\n'))}">${escapeHtml(note || '—')}</div>
      </div>
      <div class="task-status"><span class="pill ${tone}">${statusText}</span></div>
      <div class="task-slices">${slices.strip}${slices.nums}</div>
      <div class="task-facts">
        <span class="task-size">${sizeHtml(task.downloadedBytes)}</span>
        <span class="task-time">${timeHtml(task.createdAt)}</span>
        <span class="task-path ${filePath ? '' : 'dash'}" title="${escapeHtml(pathTitle)}">${escapeHtml(pathLabel)}</span>
      </div>
      <div class="task-actions">${actionsHtml(task)}</div>
    </article>`;
};

const emptyHtml = filtered => {
  if (!filtered) {
    return `<div class="empty"><h3>队列是空的</h3><p>粘贴如意或暴风播放器地址，或直接填写 m3u8 地址开始下载。</p><button type="button" class="btn primary" data-action="add">新增任务</button></div>`;
  }
  return `<div class="empty"><h3>${VIEWS[filterValue]}里没有任务</h3><p>换一个视图，或新增一个下载任务。</p><button type="button" class="btn primary" data-action="add">新增任务</button></div>`;
};

const render = () => {
  const items = visibleTasks();
  updateSummary();
  if (!tasks.length) {
    taskList.innerHTML = emptyHtml(false);
    return;
  }
  if (!items.length) {
    taskList.innerHTML = emptyHtml(true);
    return;
  }
  taskList.innerHTML = items.map(rowHtml).join('');
};

const rowElement = id => {
  for (const child of taskList.children) {
    if (child.dataset && child.dataset.id === id) return child;
  }
  return null;
};

const upsertTask = task => {
  const index = tasks.findIndex(t => t.id === task.id);
  const previous = index >= 0 ? tasks[index] : null;
  if (previous) tasks[index] = task;
  else tasks.push(task);
  sortTasks(tasks);
  // 新任务或状态变化会改变队列顺序，整体重排；进度更新只替换本行，避免打断操作
  if (!previous || previous.status !== task.status) {
    render();
    return;
  }
  if (taskList.querySelector('.loading, .empty')) {
    render();
    return;
  }
  const existing = rowElement(task.id);
  if (!visibleTasks().some(t => t.id === task.id)) {
    if (existing) existing.remove();
    if (!taskList.querySelector('.task')) render();
    else updateSummary();
    return;
  }
  const node = elementFromHtml(rowHtml(task));
  if (existing) existing.replaceWith(node);
  else taskList.prepend(node);
  updateSummary();
};

const removeTaskRow = id => {
  tasks = tasks.filter(t => t.id !== id);
  const node = rowElement(id);
  if (node) node.remove();
  if (!taskList.querySelector('.task')) render();
  else updateSummary();
};

const setView = value => {
  if (!VIEWS[value] || value === filterValue) return;
  filterValue = value;
  document.querySelectorAll('#filter button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === value));
  });
  render();
};

const closeMenus = () => {
  document.querySelectorAll('.menu:not([hidden])').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('button[data-menu][aria-expanded="true"]').forEach(button => {
    button.setAttribute('aria-expanded', 'false');
  });
};

const openMenu = (button, menu) => {
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  menu.style.top = '0px';
  menu.style.left = '0px';
  const rect = button.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - 6 - menuRect.height);
  }
  const left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
};

const loadDefaults = async () => {
  const defaults = await api('/api/defaults');
  $('#tempRoot').value = defaults.tempRoot || '';
  $('#concurrency').value = defaults.concurrency || 32;
  $('#retries').value = defaults.retries || 3;
};

const loadHealth = async () => {
  try {
    const health = await api('/api/health');
    $('#appVersion').textContent = health.version || '—';
    const dir = $('#dataDir');
    dir.textContent = shortPath(health.dataDir) || '—';
    dir.title = health.dataDir || '';
  } catch {}
};

const refresh = async () => {
  try {
    const data = await api('/api/tasks');
    tasks = sortTasks(data.tasks || []);
    hideNotice();
    render();
  } catch (error) {
    showNotice(`任务列表加载失败：${error.message}`, true);
  }
};

const syncSourceFields = () => {
  const type = $('#resourceType').value;
  const isCms = type === 'ruyi' || type === 'bfzy';
  $('#ruyiFields').hidden = !isCms;
  $('#otherFields').hidden = isCms;
  $('#videoAddress').required = isCms;
  $('#m3u8Url').required = !isCms;
  if (isCms && (!$('#concurrency').value || Number($('#concurrency').value) > 12)) {
    $('#concurrency').value = 6;
  }
  syncRuyiMode();
};

const syncRuyiMode = () => {
  const mode = $('#ruyiMode').value;
  const cmsVisible = !$('#ruyiFields').hidden;
  $('#episodeNameRow').hidden = mode !== 'single';
  $('#episodeSelectRow').hidden = mode !== 'partial';
  $('#taskConcurrencyRow').hidden = mode === 'single';
  // 面板隐藏时不能保留 required，否则会阻塞「其他」类型的提交
  $('#episodeSelect').required = cmsVisible && mode === 'partial';
};

const openTaskDialog = async () => {
  form.reset();
  await loadDefaults().catch(() => {});
  $('#resourceType').value = 'ruyi';
  $('#ruyiMode').value = 'single';
  $('#taskConcurrency').value = 2;
  $('#autoMerge').checked = false;
  $('#removeAds').checked = true;
  syncSourceFields();
  formMessage.textContent = '';
  formMessage.classList.remove('error');
  taskDialog.showModal();
  $('#videoAddress').focus();
};

form.addEventListener('submit', async event => {
  event.preventDefault();
  formMessage.textContent = '';
  formMessage.classList.remove('error');
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    const resourceType = $('#resourceType').value;
    const body = {
      resourceType,
      tempRoot: $('#tempRoot').value.trim(),
      concurrency: Number($('#concurrency').value || 32),
      retries: Number($('#retries').value || 3),
      autoMerge: $('#autoMerge').checked,
      removeAds: $('#removeAds').checked,
    };
    if (resourceType === 'ruyi' || resourceType === 'bfzy') {
      body.videoAddress = $('#videoAddress').value.trim();
      body.sourcePage = $('#sourcePage').value;
      body.ruyiMode = $('#ruyiMode').value;
      body.episodeName = $('#episodeName').value.trim();
      body.episodeSelect = $('#episodeSelect').value.trim();
      body.taskConcurrency = Number($('#taskConcurrency').value || 1);
    } else {
      body.m3u8Url = $('#m3u8Url').value.trim();
      body.baseUrl = $('#baseUrl').value.trim();
      body.outputName = $('#outputName').value.trim();
    }
    await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    taskDialog.close();
    await refresh();
  } catch (error) {
    formMessage.textContent = error.message;
    formMessage.classList.add('error');
  } finally {
    submit.disabled = false;
  }
});

taskList.addEventListener('click', async event => {
  const menuButton = event.target.closest('button[data-menu]');
  if (menuButton) {
    const menu = menuButton.parentElement.querySelector('.menu');
    const isOpen = menu && !menu.hidden;
    closeMenus();
    if (menu && !isOpen) openMenu(menuButton, menu);
    return;
  }

  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'add') {
    await openTaskDialog();
    return;
  }
  const row = button.closest('[data-id]');
  const id = row?.dataset.id;
  const task = tasks.find(t => t.id === id);
  if (!id || !task) return;
  closeMenus();
  button.disabled = true;
  try {
    if (action === 'pause') await api(`/api/tasks/${id}/pause`, { method: 'POST', body: '{}' });
    if (action === 'resume') await api(`/api/tasks/${id}/resume`, { method: 'POST', body: '{}' });
    if (action === 'stop') await api(`/api/tasks/${id}/stop`, { method: 'POST', body: '{}' });
    if (action === 'retry') await api(`/api/tasks/${id}/retry`, { method: 'POST', body: '{}' });
    if (action === 'remove-ads') {
      const data = await api(`/api/tasks/${id}/remove-ads`, { method: 'POST', body: '{}' });
      const result = data.result || {};
      const errorText = result.errors?.length ? `，读取失败 ${result.errors.length} 个目录/文件` : '';
      alert(`去广告扫描完成：样本 ${result.patterns || 0} 个，命中 ${result.matches || 0} 段，移除 ${result.removedSegments || 0} 个切片${errorText}`);
    }
    if (action === 'merge') await api(`/api/tasks/${id}/merge`, { method: 'POST', body: '{}' });
    if (action === 'play') {
      openPlayer(task);
      return;
    }
    if (action === 'move') {
      moveTaskId = id;
      moveMode = 'single';
      moveDest.value = '';
      moveDialog.showModal();
      return;
    }
    if (action === 'delete') {
      await api(`/api/tasks/${id}`, { method: 'DELETE' });
    }
    await refresh();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('click', event => {
  if (!event.target.closest('.task-actions')) closeMenus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMenus();
});
window.addEventListener('scroll', closeMenus, { passive: true });
window.addEventListener('resize', closeMenus);

const renderBrowse = data => {
  currentBrowsePath = data.currentPath || '';
  currentBrowseParent = data.parentPath || '';
  browsePath.textContent = currentBrowsePath || '—';
  const dirs = data.directories || [];
  if (!dirs.length) {
    browseList.innerHTML = '<div class="browse-empty">当前目录没有子目录</div>';
    return;
  }
  browseList.innerHTML = dirs.map(dir => `
    <button type="button" class="browse-item" data-path="${escapeHtml(dir.path)}">
      <span class="folder-icon">▸</span>
      <span>${escapeHtml(dir.name)}</span>
    </button>
  `).join('');
};

const loadBrowse = async (path = '') => {
  browseList.innerHTML = '<div class="browse-empty">加载中…</div>';
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  renderBrowse(await api(`/api/browse${query}`));
};

const openBrowseDialog = async () => {
  browseDialog.showModal();
  try {
    await loadBrowse(moveDest.value.trim());
  } catch (error) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(error.message)}</div>`;
  }
};

moveForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    if (moveMode === 'all') {
      const result = await api('/api/tasks/bulk/move', {
        method: 'POST',
        body: JSON.stringify({ destDir: moveDest.value.trim() }),
      });
      alert(`已开始后台移动：${result.started || 0} 个，跳过 ${result.skipped || 0} 个，启动失败 ${result.failed || 0} 个`);
    } else {
      if (!moveTaskId) return;
      await api(`/api/tasks/${moveTaskId}/move`, {
        method: 'POST',
        body: JSON.stringify({ destDir: moveDest.value.trim() }),
      });
    }
    moveDialog.close();
    moveTaskId = '';
    moveMode = 'single';
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

const videoUrl = id => `${API_BASE}/api/tasks/${id}/video`;

const openPlayer = task => {
  playerTitle.textContent = task.outputName || '播放视频';
  playerMessage.textContent = '';
  playerMessage.classList.remove('error');
  playerVideo.src = videoUrl(task.id);
  playerDialog.showModal();
  playerVideo.play().catch(() => {});
};

const resetPlayer = () => {
  playerVideo.pause();
  playerVideo.removeAttribute('src');
  playerVideo.load();
  playerMessage.textContent = '';
  playerMessage.classList.remove('error');
};

const closePlayer = () => {
  resetPlayer();
  if (playerDialog.open) playerDialog.close();
};

playerDialog.addEventListener('close', resetPlayer);
playerDialog.addEventListener('cancel', resetPlayer);
playerVideo.addEventListener('error', () => {
  if (!playerVideo.getAttribute('src')) return;
  playerMessage.textContent = '视频加载失败：文件可能已被移动或删除，或格式不被浏览器支持。';
  playerMessage.classList.add('error');
});

$('#openAddTask').addEventListener('click', openTaskDialog);
$('#closePlayer').addEventListener('click', closePlayer);
$('#closePlayerBtn').addEventListener('click', closePlayer);
$('#resourceType').addEventListener('change', syncSourceFields);
$('#ruyiMode').addEventListener('change', syncRuyiMode);
$('#closeTaskDialog').addEventListener('click', () => taskDialog.close());
$('#cancelTask').addEventListener('click', () => taskDialog.close());
$('#cancelMove').addEventListener('click', () => moveDialog.close());
$('#openMoveBrowse').addEventListener('click', openBrowseDialog);
$('#closeBrowse').addEventListener('click', () => browseDialog.close());
$('#selectBrowsePath').addEventListener('click', () => {
  if (currentBrowsePath) moveDest.value = currentBrowsePath;
  browseDialog.close();
});
$('#browseParent').addEventListener('click', async () => {
  if (!currentBrowseParent || currentBrowseParent === currentBrowsePath) return;
  try {
    await loadBrowse(currentBrowseParent);
  } catch (error) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(error.message)}</div>`;
  }
});
$('#browseList').addEventListener('click', async event => {
  const item = event.target.closest('.browse-item');
  if (!item) return;
  try {
    await loadBrowse(item.dataset.path || '');
  } catch (error) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(error.message)}</div>`;
  }
});
$('#filter').addEventListener('click', event => {
  const button = event.target.closest('button[data-filter]');
  if (button) setView(button.dataset.filter);
});
$('#refreshBtn').addEventListener('click', refresh);
$('#noticeRetry').addEventListener('click', () => {
  hideNotice();
  refresh();
});
$('#deleteAllBtn').addEventListener('click', async () => {
  if (!tasks.length) return;
  if (!confirm('确定删除全部任务并清理对应临时文件？移动后的视频不会删除。')) return;
  try {
    const result = await api('/api/tasks/bulk/delete', { method: 'POST', body: '{}' });
    alert(`已删除 ${result.deleted || 0} 个任务`);
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});
$('#moveAllBtn').addEventListener('click', () => {
  moveMode = 'all';
  moveTaskId = '';
  moveDest.value = '';
  moveDialog.showModal();
});
$('#mergeAllBtn').addEventListener('click', async () => {
  try {
    const result = await api('/api/tasks/bulk/merge', { method: 'POST', body: '{}' });
    alert(`已开始后台合并：${result.started || 0} 个，跳过 ${result.skipped || 0} 个，启动失败 ${result.failed || 0} 个`);
    await refresh();
  } catch (error) {
    alert(error.message);
  }
});

const connectEvents = () => {
  const es = new EventSource(`${API_BASE}/api/events`);
  es.onopen = () => hideNotice();
  es.addEventListener('task', event => {
    upsertTask(JSON.parse(event.data));
  });
  es.addEventListener('delete', event => {
    const data = JSON.parse(event.data);
    removeTaskRow(data.id);
  });
  es.onerror = () => {
    es.close();
    showNotice('实时更新已断开，正在重连…', false);
    setTimeout(connectEvents, 3000);
  };
};

window.addEventListener('beforeunload', () => {
  if (playerDialog.open) closePlayer();
});

await loadHealth();
await loadDefaults().catch(() => {});
await refresh();
connectEvents();
