'use strict';

const DEFAULT_DIRECTORY = 'LotteryAutoScript_start';

const state = {
  directory: '',
  entries: [],
  totalEntries: 0,
  listOffset: 0,
  selectedFile: '',
  fileSize: 0,
  chunkStart: 0,
  chunkEnd: 0,
  chunkSize: Number(localStorage.getItem('qlv_chunk_size')) || 131072,
  follow: localStorage.getItem('qlv_follow') === '1',
  followTimer: null,
  runtimeTimer: null,
  directoryRequestId: 0,
  selectedRunning: false,
  loadingChunk: false,
  winStatus: 'pending',
  wins: [],
  winTimer: null,
};

const $ = (id) => document.getElementById(id);
const elements = {
  breadcrumbs: $('breadcrumbs'),
  fileFilter: $('fileFilter'),
  fileList: $('fileList'),
  refreshList: $('refreshList'),
  loadMore: $('loadMore'),
  fileName: $('fileName'),
  fileMeta: $('fileMeta'),
  runningBadge: $('runningBadge'),
  previousChunk: $('previousChunk'),
  nextChunk: $('nextChunk'),
  latestChunk: $('latestChunk'),
  chunkSize: $('chunkSize'),
  followLog: $('followLog'),
  downloadLog: $('downloadLog'),
  logSearch: $('logSearch'),
  caseSensitive: $('caseSensitive'),
  searchButton: $('searchButton'),
  clearSearch: $('clearSearch'),
  searchPanel: $('searchPanel'),
  searchSummary: $('searchSummary'),
  searchResults: $('searchResults'),
  rangeStatus: $('rangeStatus'),
  requestStatus: $('requestStatus'),
  logViewport: $('logViewport'),
  logContent: $('logContent'),
  emptyState: $('emptyState'),
  toast: $('toast'),
  logWorkspace: $('logWorkspace'),
  winsWorkspace: $('winsWorkspace'),
  showWins: $('showWins'),
  winBadge: $('winBadge'),
  viewerInstance: $('viewerInstance'),
  peerViewer: $('peerViewer'),
  refreshWins: $('refreshWins'),
  backToLogs: $('backToLogs'),
  pendingCount: $('pendingCount'),
  dismissedCount: $('dismissedCount'),
  winsList: $('winsList'),
  logoutViewer: $('logoutViewer'),
};

elements.chunkSize.value = String(state.chunkSize);
elements.followLog.checked = state.follow;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[index]}`;
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp));
}

let toastTimer;
function toast(message, type = '') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 2800);
}

async function api(endpoint, parameters = {}) {
  const url = new URL(`./api/${endpoint}`, window.location.href);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url, { cache: 'no-store' });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === 401) window.location.reload();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function apiPost(endpoint, body) {
  const url = new URL(`./api/${endpoint}`, window.location.href);
  const response = await fetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      'X-QLV-Action': '1',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === 401) window.location.reload();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function showLogWorkspace() {
  elements.winsWorkspace.classList.add('hidden');
  elements.logWorkspace.classList.remove('hidden');
  elements.showWins.classList.remove('active');
}

function safeBilibiliUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'bilibili.com' && !url.hostname.endsWith('.bilibili.com'))) return '';
    return url.href;
  } catch (_) {
    return '';
  }
}

function reminderTime(value) {
  const number = Number(value || 0);
  if (!number) return '未知';
  return formatTime(number < 10_000_000_000 ? number * 1000 : number);
}

function winMeta(label, value) {
  const item = document.createElement('span');
  const name = document.createElement('b');
  name.textContent = `${label}：`;
  item.append(name, document.createTextNode(value));
  return item;
}

function renderWins() {
  elements.winsList.replaceChildren();
  if (!state.wins.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = state.winStatus === 'pending' ? '当前没有待处理提醒' : '当前没有已取消提醒';
    const hint = document.createElement('span');
    hint.textContent = state.winStatus === 'pending'
      ? '只有脚本已检测并保存的中奖私信会出现在这里。'
      : '手动取消的提醒会保留在这里，可随时恢复。';
    empty.append(title, hint);
    elements.winsList.append(empty);
    return;
  }
  state.wins.forEach(record => {
    const card = document.createElement('article');
    card.className = `win-card ${record.status}`;

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = `帐号${record.accountNumber} · UID ${record.accountUid}`;
    const status = document.createElement('span');
    status.className = `win-status ${record.status}`;
    status.textContent = record.status === 'dismissed' ? '已取消提醒' : '待处理';
    header.append(title, status);

    const metadata = document.createElement('div');
    metadata.className = 'win-meta';
    metadata.append(
      winMeta('发信 UID', record.senderUid || record.talkerId || '未知'),
      winMeta('私信时间', reminderTime(record.messageTimestamp)),
      winMeta('发现时间', reminderTime(record.detectedAt)),
      winMeta('已推送', `${record.notifyCount} 次`),
    );
    if (record.lastNotifiedAt) metadata.append(winMeta('最近推送', reminderTime(record.lastNotifiedAt)));
    if (record.dismissedAt) metadata.append(winMeta('取消时间', reminderTime(record.dismissedAt)));

    const content = document.createElement('pre');
    content.className = 'win-content';
    content.textContent = record.content || '（私信正文为空）';

    const actions = document.createElement('footer');
    const link = safeBilibiliUrl(record.link);
    if (link) {
      const open = document.createElement('a');
      open.className = 'button-link';
      open.href = link;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = '打开 B 站私信';
      actions.append(open);
    }
    const action = document.createElement('button');
    action.type = 'button';
    action.className = record.status === 'dismissed' ? '' : 'danger-action';
    action.textContent = record.status === 'dismissed' ? '恢复提醒' : '取消提醒';
    action.addEventListener('click', async () => {
      const dismissing = record.status !== 'dismissed';
      const message = dismissing
        ? '确定取消这条 PushPlus 提醒？\n\n这不会标记已读、删除或修改 B 站私信。'
        : '确定恢复这条提醒？它会在下次中奖检查达到提醒间隔后重新推送。';
      if (!window.confirm(message)) return;
      action.disabled = true;
      try {
        await apiPost(dismissing ? 'wins/dismiss' : 'wins/restore', {
          accountUid: record.accountUid,
          recordId: record.recordId,
        });
        toast(dismissing ? '已取消后续重复提醒' : '已恢复提醒', 'success');
        await loadWins();
      } catch (error) {
        toast(`操作失败：${error.message}`, 'error');
        action.disabled = false;
      }
    });
    actions.append(action);
    card.append(header, metadata, content, actions);
    elements.winsList.append(card);
  });
}

async function loadWins(options = {}) {
  try {
    if (!options.silent) elements.winsList.setAttribute('aria-busy', 'true');
    const payload = await api('wins', { status: state.winStatus });
    state.wins = payload.records;
    elements.viewerInstance.textContent = payload.instance || '本服务器';
    elements.pendingCount.textContent = String(payload.counts.pending);
    elements.dismissedCount.textContent = String(payload.counts.dismissed);
    elements.winBadge.textContent = String(payload.counts.pending);
    elements.winBadge.classList.toggle('hidden', payload.counts.pending === 0);
    if (payload.peerViewerUrl) {
      elements.peerViewer.href = payload.peerViewerUrl;
      elements.peerViewer.classList.remove('hidden');
    } else {
      elements.peerViewer.classList.add('hidden');
    }
    renderWins();
  } catch (error) {
    if (!options.silent) toast(`中奖提醒读取失败：${error.message}`, 'error');
  } finally {
    elements.winsList.removeAttribute('aria-busy');
  }
}

async function showWinWorkspace() {
  elements.logWorkspace.classList.add('hidden');
  elements.winsWorkspace.classList.remove('hidden');
  elements.showWins.classList.add('active');
  await loadWins();
}

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  const fragments = state.directory ? state.directory.split('/') : [];
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb';
  root.textContent = '全部日志';
  root.addEventListener('click', () => { showLogWorkspace(); loadDirectory(''); });
  elements.breadcrumbs.append(root);
  fragments.forEach((fragment, index) => {
    const separator = document.createElement('span');
    separator.className = 'crumb-separator';
    separator.textContent = '/';
    elements.breadcrumbs.append(separator);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'crumb';
    button.textContent = fragment;
    button.addEventListener('click', () => {
      showLogWorkspace();
      loadDirectory(fragments.slice(0, index + 1).join('/'));
    });
    elements.breadcrumbs.append(button);
  });
  document.querySelectorAll('.quick-folders button').forEach(button => {
    button.classList.toggle('active', button.dataset.directory === state.directory);
  });
}

function renderFiles() {
  const filter = elements.fileFilter.value.trim().toLocaleLowerCase();
  elements.fileList.replaceChildren();
  const entries = state.entries.filter(entry => !filter || entry.name.toLocaleLowerCase().includes(filter));
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = '<strong>当前目录没有匹配项</strong><span>试试清除筛选条件或刷新目录。</span>';
    elements.fileList.append(empty);
  }
  entries.forEach(entry => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `file-row ${entry.type}${entry.path === state.selectedFile ? ' active' : ''}${entry.running ? ' running' : ''}`;
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = entry.type === 'directory' ? '▰' : '▤';
    const copy = document.createElement('span');
    copy.className = 'file-copy';
    const titleRow = document.createElement('span');
    titleRow.className = 'file-title-row';
    const title = document.createElement('span');
    title.className = 'file-title';
    title.textContent = entry.name;
    titleRow.append(title);
    if (entry.running) {
      const badge = document.createElement('span');
      badge.className = 'running-badge';
      badge.textContent = '运行中';
      titleRow.append(badge);
    }
    const subtitle = document.createElement('span');
    subtitle.className = 'file-subtitle';
    subtitle.textContent = formatTime(entry.mtimeMs);
    copy.append(titleRow, subtitle);
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = entry.type === 'file' ? formatBytes(entry.size) : '';
    row.append(icon, copy, size);
    row.addEventListener('click', () => {
      showLogWorkspace();
      return entry.type === 'directory' ? loadDirectory(entry.path) : selectFile(entry);
    });
    elements.fileList.append(row);
  });
  elements.loadMore.classList.toggle('hidden', state.entries.length >= state.totalEntries || Boolean(filter));
}

function updateSelectedRuntime() {
  if (!state.selectedFile) {
    state.selectedRunning = false;
  } else {
    const selected = state.entries.find(entry => entry.path === state.selectedFile);
    if (selected) state.selectedRunning = Boolean(selected.running);
  }
  elements.runningBadge.classList.toggle('hidden', !state.selectedRunning);
}

async function loadDirectory(directory, append = false, options = {}) {
  const requestId = ++state.directoryRequestId;
  const listScrollTop = elements.fileList.scrollTop;
  try {
    if (!options.silent) elements.requestStatus.textContent = '读取目录…';
    const offset = append ? state.entries.length : 0;
    const limit = append ? 200 : (options.silent ? Math.min(500, Math.max(200, state.entries.length)) : 200);
    const payload = await api('list', { path: directory, offset, limit });
    if (requestId !== state.directoryRequestId) return false;
    state.directory = payload.path;
    state.totalEntries = payload.total;
    state.entries = append ? [...state.entries, ...payload.entries] : payload.entries;
    renderBreadcrumbs();
    renderFiles();
    updateSelectedRuntime();
    if (options.silent) elements.fileList.scrollTop = listScrollTop;
    else elements.requestStatus.textContent = `${payload.total} 项`;
    return true;
  } catch (error) {
    if (requestId !== state.directoryRequestId) return false;
    if (!options.silent) {
      elements.requestStatus.textContent = '';
      toast(`目录读取失败：${error.message}`, 'error');
    }
    return false;
  }
}

function classifyLine(line) {
  if (/\[(?:Error|ERR)\]|异常|失败/.test(line)) return 'error';
  if (/\[(?:Warn|WRN)\]/.test(line)) return 'warn';
  if (/412|12014|-352|风控|熔断/.test(line)) return 'risk';
  if (/成功|完成 ✅|来源进度/.test(line)) return 'success';
  return '';
}

function renderLog(text) {
  const fragment = document.createDocumentFragment();
  text.split('\n').forEach(line => {
    const span = document.createElement('span');
    span.className = `log-line ${classifyLine(line)}`;
    span.textContent = line || ' ';
    fragment.append(span);
  });
  elements.logContent.replaceChildren(fragment);
  elements.emptyState.classList.add('hidden');
  elements.logContent.classList.add('visible');
}

function scrollLogToEnd() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      elements.logViewport.scrollTop = elements.logViewport.scrollHeight;
    });
  });
}

function updateChunkControls() {
  const hasFile = Boolean(state.selectedFile);
  elements.previousChunk.disabled = !hasFile || state.chunkStart <= 0 || state.loadingChunk;
  elements.nextChunk.disabled = !hasFile || state.chunkEnd >= state.fileSize || state.loadingChunk;
  elements.latestChunk.disabled = !hasFile || state.loadingChunk;
  elements.logSearch.disabled = !hasFile;
  elements.searchButton.disabled = !hasFile;
  elements.downloadLog.classList.toggle('disabled', !hasFile);
  elements.downloadLog.setAttribute('aria-disabled', hasFile ? 'false' : 'true');
  elements.rangeStatus.textContent = hasFile
    ? `${formatBytes(state.chunkStart)} – ${formatBytes(state.chunkEnd)} / ${formatBytes(state.fileSize)}`
    : '等待选择文件';
}

async function loadChunk(offset = null, options = {}) {
  if (!state.selectedFile || state.loadingChunk) return;
  state.loadingChunk = true;
  updateChunkControls();
  const started = performance.now();
  elements.requestStatus.textContent = '读取分块…';
  try {
    const payload = await api('chunk', {
      path: state.selectedFile,
      offset,
      limit: state.chunkSize,
    });
    state.fileSize = payload.size;
    state.chunkStart = payload.start;
    state.chunkEnd = payload.end;
    renderLog(payload.text || '');
    elements.fileMeta.textContent = `${formatBytes(payload.size)} · 更新于 ${formatTime(payload.mtimeMs)}`;
    elements.requestStatus.textContent = `${Math.round(performance.now() - started)} ms`;
    if (options.scrollToEnd || offset === null) scrollLogToEnd();
  } catch (error) {
    elements.requestStatus.textContent = '';
    toast(`日志读取失败：${error.message}`, 'error');
  } finally {
    state.loadingChunk = false;
    updateChunkControls();
  }
}

async function selectFile(entry) {
  state.selectedFile = entry.path;
  state.selectedRunning = Boolean(entry.running);
  state.fileSize = entry.size;
  state.chunkStart = 0;
  state.chunkEnd = 0;
  elements.fileName.textContent = entry.name;
  elements.fileMeta.textContent = `${formatBytes(entry.size)} · 正在加载末尾`;
  updateSelectedRuntime();
  elements.downloadLog.href = `./api/download?path=${encodeURIComponent(entry.path)}`;
  clearSearchResults();
  renderFiles();
  localStorage.setItem('qlv_last_file', entry.path);
  await loadChunk(null, { scrollToEnd: true });
}

async function searchLog() {
  const query = elements.logSearch.value.trim();
  if (!query || !state.selectedFile) return;
  elements.searchButton.disabled = true;
  elements.searchButton.textContent = '搜索中…';
  try {
    const payload = await api('search', {
      path: state.selectedFile,
      q: query,
      case: elements.caseSensitive.checked ? '1' : '0',
      limit: 100,
    });
    elements.searchPanel.classList.remove('hidden');
    elements.clearSearch.disabled = false;
    elements.searchSummary.textContent = `找到 ${payload.matches.length} 条${payload.limited ? '（已达到显示上限）' : ''} · ${payload.elapsedMs} ms`;
    elements.searchResults.replaceChildren();
    payload.matches.forEach(match => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'search-hit';
      const line = document.createElement('code');
      line.textContent = `L${match.line}`;
      const text = document.createElement('span');
      text.textContent = match.text;
      button.append(line, text);
      button.addEventListener('click', () => loadChunk(Math.max(0, match.offset - Math.floor(state.chunkSize / 4))));
      elements.searchResults.append(button);
    });
  } catch (error) {
    toast(`搜索失败：${error.message}`, 'error');
  } finally {
    elements.searchButton.disabled = false;
    elements.searchButton.textContent = '搜索';
  }
}

function clearSearchResults() {
  elements.searchPanel.classList.add('hidden');
  elements.searchResults.replaceChildren();
  elements.searchSummary.textContent = '';
  elements.clearSearch.disabled = true;
}

async function followTick() {
  if (!state.follow || !state.selectedFile || state.loadingChunk) return;
  try {
    const metadata = await api('meta', { path: state.selectedFile });
    if (metadata.size !== state.fileSize) await loadChunk(null, { scrollToEnd: true });
  } catch (error) {
    toast(`自动追踪暂停：${error.message}`, 'error');
  }
}

function configureFollow() {
  clearInterval(state.followTimer);
  state.followTimer = null;
  if (state.follow) state.followTimer = setInterval(followTick, 2000);
}

function configureRuntimePolling() {
  clearInterval(state.runtimeTimer);
  state.runtimeTimer = setInterval(() => {
    if (!document.hidden) loadDirectory(state.directory, false, { silent: true });
  }, 5000);
}

elements.fileFilter.addEventListener('input', renderFiles);
elements.refreshList.addEventListener('click', () => loadDirectory(state.directory));
elements.loadMore.addEventListener('click', () => loadDirectory(state.directory, true));
elements.previousChunk.addEventListener('click', () => loadChunk(Math.max(0, state.chunkStart - state.chunkSize)));
elements.nextChunk.addEventListener('click', () => loadChunk(state.chunkEnd));
elements.latestChunk.addEventListener('click', () => loadChunk(null, { scrollToEnd: true }));
elements.chunkSize.addEventListener('change', () => {
  state.chunkSize = Number(elements.chunkSize.value);
  localStorage.setItem('qlv_chunk_size', String(state.chunkSize));
  if (state.selectedFile) loadChunk(null, { scrollToEnd: true });
});
elements.followLog.addEventListener('change', () => {
  state.follow = elements.followLog.checked;
  localStorage.setItem('qlv_follow', state.follow ? '1' : '0');
  configureFollow();
  if (state.follow) loadChunk(null, { scrollToEnd: true });
});
elements.searchButton.addEventListener('click', searchLog);
elements.logSearch.addEventListener('keydown', event => { if (event.key === 'Enter') searchLog(); });
elements.clearSearch.addEventListener('click', () => {
  elements.logSearch.value = '';
  clearSearchResults();
});
elements.downloadLog.addEventListener('click', event => {
  if (!state.selectedFile) event.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadDirectory(state.directory, false, { silent: true });
});
document.querySelectorAll('.quick-folders button').forEach(button => {
  button.addEventListener('click', async () => {
    showLogWorkspace();
    const loaded = await loadDirectory(button.dataset.directory || '');
    const latest = state.entries.find(entry => entry.type === 'file');
    if (loaded && latest) await selectFile(latest);
  });
});
elements.showWins.addEventListener('click', showWinWorkspace);
elements.backToLogs.addEventListener('click', showLogWorkspace);
elements.refreshWins.addEventListener('click', () => loadWins());
elements.logoutViewer.addEventListener('click', async () => {
  if (!window.confirm('确定退出日志查看器？下次访问需要重新登录。')) return;
  elements.logoutViewer.disabled = true;
  try {
    await apiPost('logout', {});
    window.location.reload();
  } catch (error) {
    toast(`退出失败：${error.message}`, 'error');
    elements.logoutViewer.disabled = false;
  }
});
document.querySelectorAll('[data-win-status]').forEach(button => {
  button.addEventListener('click', async () => {
    state.winStatus = button.dataset.winStatus;
    document.querySelectorAll('[data-win-status]').forEach(item => item.classList.toggle('active', item === button));
    await loadWins();
  });
});

configureFollow();
configureRuntimePolling();
(async function bootstrap() {
  await loadWins({ silent: true });
  const loaded = await loadDirectory(DEFAULT_DIRECTORY);
  const latest = state.entries.find(entry => entry.type === 'file');
  if (loaded && latest) await selectFile(latest);
})();
state.winTimer = setInterval(() => {
  if (!document.hidden) loadWins({ silent: true });
}, 60_000);
