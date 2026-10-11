const $ = selector => document.querySelector(selector);
const API_BASE = location.pathname.startsWith('/app/vdl') ? '/app/vdl' : '';

const taskList = $('#taskList');
const taskDialog = $('#taskDialog');
const form = $('#taskForm');
const formMessage = $('#formMessage');
const filter = $('#filter');
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
let tasks = [];
let moveTaskId = '';
let moveMode = 'single';
let currentBrowsePath = '';
let currentBrowseParent = '';

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
const fmtTime = value => value ? new Date(value).toLocaleString() : '-';
const fmtBytes = bytes => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
};
const statusText = status => ({
  waiting: '等待',
  pending: '等待',
  downloading: '下载中',
  downloaded: '未合并',
  merging: '合并中',
  moving: '移动中',
  success: '成功',
  partial: '部分合并',
  failed: '失败',
  paused: '已暂停',
  stopped: '已停止',
  moved: '已移动',
}[status] || status);

const setStats = stats => {
  $('#statTotal').textContent = stats.total ?? 0;
  $('#statRunning').textContent = stats.running ?? 0;
  $('#statCompleted').textContent = stats.completed ?? 0;
  $('#statSuccess').textContent = stats.success ?? 0;
  $('#statFailed').textContent = stats.failed ?? 0;
};

const visibleTasks = () => {
  const value = filter.value;
  if (value === 'running') return tasks.filter(t => ['waiting', 'pending', 'downloading', 'merging', 'moving'].includes(t.status));
  if (value === 'failed') return tasks.filter(t => t.status === 'failed');
  if (value === 'finished') return tasks.filter(t => ['downloaded', 'success', 'partial', 'moved'].includes(t.status));
  return tasks;
};

const actionButtons = task => {
  const buttons = [];
  const canPause = ['waiting', 'pending', 'downloading'].includes(task.status);
  const canResume = ['paused', 'stopped'].includes(task.status);
  const canStop = ['waiting', 'pending', 'downloading', 'paused'].includes(task.status);
  const canRetry = task.status === 'failed' || task.failedSegments > 0;
  const mergeableSegments = (task.doneSegments || 0) - (task.adRemovedSegments || 0);
  const canMerge = ['downloaded', 'failed', 'partial', 'stopped', 'paused'].includes(task.status) && mergeableSegments > 0;
  const canMove = ['success', 'partial'].includes(task.status) && (task.outputPath || task.movedPath);
  const canRemoveAds = ['downloaded', 'failed', 'partial', 'stopped', 'paused'].includes(task.status)
    && mergeableSegments > 0;
  const canPlay = ['success', 'partial', 'moved'].includes(task.status) && (task.outputPath || task.movedPath);
  if (canPlay) buttons.push('<button data-action="play" type="button">播放</button>');
  if (canPause) buttons.push('<button data-action="pause" type="button">暂停</button>');
  if (canResume) buttons.push('<button data-action="resume" type="button">继续</button>');
  if (canStop) buttons.push('<button data-action="stop" class="warn-button" type="button">停止</button>');
  if (canRetry) buttons.push('<button data-action="retry" class="warn-button" type="button">重试</button>');
  if (canRemoveAds) buttons.push('<button data-action="remove-ads" type="button">去广告</button>');
  if (canMerge) buttons.push('<button data-action="merge" type="button">合并</button>');
  if (canMove) buttons.push('<button data-action="move" type="button">移动</button>');
  buttons.push('<button data-action="delete" class="danger-button" type="button">删除</button>');
  return buttons.join('');
};

const render = () => {
  const items = visibleTasks();
  if (!items.length) {
    taskList.innerHTML = '<tr><td colspan="7"><div class="empty">暂无下载任务</div></td></tr>';
    return;
  }
  taskList.innerHTML = items.map(task => {
    const done = task.doneSegments || 0;
    const total = task.totalSegments || 0;
    const progress = total ? Math.round((done / total) * 1000) / 10 : 0;
    const pathText = task.movedPath || task.outputPath || task.tempDir || '';
    const adText = task.adRemovedSegments ? `，已去广告 ${task.adRemovedSegments}` : '';
    const adScanText = task.adScan
      ? `<div class="subtle">去广告：样本 ${task.adScan.patterns || 0}，命中 ${task.adScan.matches || 0} 段，移除 ${task.adScan.removedSegments || 0} 片${task.adScan.errors?.length ? `，读取失败 ${task.adScan.errors.length}` : ''}</div>`
      : '';
    const titleParts = [task.outputName];
    if (task.batchTitle || task.episodeName) titleParts.push([task.batchTitle, task.episodeName].filter(Boolean).join(' / '));
    return `
      <tr data-id="${task.id}">
        <td class="task-main">
          <div class="task-title" title="${escapeHtml(titleParts.join(' - '))}">${escapeHtml(task.outputName)}</div>
          <div class="task-url" title="${escapeHtml(task.m3u8Url)}">${escapeHtml(task.m3u8Url)}</div>
          ${task.batchTitle || task.episodeName ? `<div class="subtle">${escapeHtml([task.batchTitle, task.episodeName].filter(Boolean).join(' / '))}</div>` : ''}
          ${adScanText}
          ${task.error ? `<div class="error-line">${escapeHtml(task.error)}</div>` : ''}
        </td>
        <td><span class="badge ${task.status}">${statusText(task.status)}</span></td>
        <td class="progress-cell">
          <div class="progress-line">
            <strong>${done}/${total}</strong>
            <span>${progress}%</span>
          </div>
          <div class="progress"><span style="width:${Math.min(100, progress)}%"></span></div>
          <div class="subtle">失败 ${task.failedSegments || 0}${adText}</div>
        </td>
        <td>${fmtBytes(task.downloadedBytes)}</td>
        <td>${fmtTime(task.createdAt)}</td>
        <td class="path" title="${escapeHtml(pathText)}">${escapeHtml(pathText || '-')}</td>
        <td><div class="task-actions">${actionButtons(task)}</div></td>
      </tr>
    `;
  }).join('');
};

const loadDefaults = async () => {
  const defaults = await api('/api/defaults');
  $('#tempRoot').value = defaults.tempRoot || '';
  $('#concurrency').value = defaults.concurrency || 32;
  $('#retries').value = defaults.retries || 3;
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

const loadStats = async () => setStats(await api('/api/stats'));
const loadTasks = async () => {
  const data = await api('/api/tasks');
  tasks = data.tasks || [];
  tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  render();
};
const refresh = async () => Promise.all([loadTasks(), loadStats()]);

const openTaskDialog = async () => {
  form.reset();
  await loadDefaults();
  $('#resourceType').value = 'ruyi';
  $('#ruyiMode').value = 'single';
  $('#taskConcurrency').value = 2;
  $('#autoMerge').checked = false;
  $('#removeAds').checked = true;
  syncSourceFields();
  syncRuyiMode();
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
  } catch (e) {
    formMessage.textContent = e.message;
    formMessage.classList.add('error');
  } finally {
    submit.disabled = false;
  }
});

taskList.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('[data-id]');
  const id = row?.dataset.id;
  const task = tasks.find(t => t.id === id);
  if (!id || !task) return;
  const action = button.dataset.action;
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
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
  }
});

const renderBrowse = data => {
  currentBrowsePath = data.currentPath || '';
  currentBrowseParent = data.parentPath || '';
  browsePath.textContent = currentBrowsePath || '-';
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
  browseList.innerHTML = '<div class="browse-empty">加载中...</div>';
  const query = path ? `?path=${encodeURIComponent(path)}` : '';
  const data = await api(`/api/browse${query}`);
  renderBrowse(data);
};

const openBrowseDialog = async () => {
  browseDialog.showModal();
  try {
    await loadBrowse(moveDest.value.trim());
  } catch (e) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(e.message)}</div>`;
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
  } catch (e) {
    alert(e.message);
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
  } catch (e) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(e.message)}</div>`;
  }
});
$('#browseList').addEventListener('click', async event => {
  const item = event.target.closest('.browse-item');
  if (!item) return;
  try {
    await loadBrowse(item.dataset.path || '');
  } catch (e) {
    browseList.innerHTML = `<div class="browse-empty">${escapeHtml(e.message)}</div>`;
  }
});
$('#refreshBtn').addEventListener('click', refresh);
$('#deleteAllBtn').addEventListener('click', async () => {
  if (!tasks.length) return;
  if (!confirm('确定删除全部任务并清理对应临时文件？移动后的视频不会删除。')) return;
  try {
    const result = await api('/api/tasks/bulk/delete', { method: 'POST', body: '{}' });
    alert(`已删除 ${result.deleted || 0} 个任务`);
    await refresh();
  } catch (e) {
    alert(e.message);
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
  } catch (e) {
    alert(e.message);
  }
});
filter.addEventListener('change', render);

const connectEvents = () => {
  const es = new EventSource(`${API_BASE}/api/events`);
  es.addEventListener('stats', event => setStats(JSON.parse(event.data)));
  es.addEventListener('task', event => {
    const task = JSON.parse(event.data);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    else tasks.unshift(task);
    tasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    render();
  });
  es.addEventListener('delete', event => {
    const data = JSON.parse(event.data);
    tasks = tasks.filter(t => t.id !== data.id);
    render();
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 3000);
  };
};

window.addEventListener('beforeunload', () => {
  if (playerDialog.open) closePlayer();
});

await loadDefaults();
await refresh();
connectEvents();
