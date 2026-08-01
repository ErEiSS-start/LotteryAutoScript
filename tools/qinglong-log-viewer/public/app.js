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
  winnerViewerLink: $('winnerViewerLink'),
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

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  const fragments = state.directory ? state.directory.split('/') : [];
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb';
  root.textContent = '全部日志';
  root.addEventListener('click', () => loadDirectory(''));
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
    const loaded = await loadDirectory(button.dataset.directory || '');
    const latest = state.entries.find(entry => entry.type === 'file');
    if (loaded && latest) await selectFile(latest);
  });
});
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
configureFollow();
configureRuntimePolling();
(async function bootstrap() {
  try {
    const config = await api('config');
    if (config.winnerViewerUrl) elements.winnerViewerLink.href = config.winnerViewerUrl;
    else elements.winnerViewerLink.classList.add('disabled');
  } catch (_) {
    elements.winnerViewerLink.classList.add('disabled');
  }
  const loaded = await loadDirectory(DEFAULT_DIRECTORY);
  const latest = state.entries.find(entry => entry.type === 'file');
  if (loaded && latest) await selectFile(latest);
})();
