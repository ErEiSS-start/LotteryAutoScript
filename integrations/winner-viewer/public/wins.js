'use strict';

const state = {
  status: 'pending',
  renderedStatus: '',
  records: [],
  recordsByStatus: { pending: null, review: null, dismissed: null },
  request: null,
  requestSequence: 0,
};
const $ = id => document.getElementById(id);
const elements = {
  viewerInstance: $('viewerInstance'),
  logViewerLink: $('logViewerLink'),
  peerWinnerLink: $('peerWinnerLink'),
  refreshWins: $('refreshWins'),
  logoutViewer: $('logoutViewer'),
  pendingCount: $('pendingCount'),
  reviewCount: $('reviewCount'),
  dismissedCount: $('dismissedCount'),
  reservationCount: $('reservationCount'),
  winSyncStatus: $('winSyncStatus'),
  winsWarnings: $('winsWarnings'),
  winsList: $('winsList'),
  toast: $('toast'),
};

let toastTimer;
function toast(message, type = '') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type}`;
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 2800);
}

function isAbortError(error) {
  return error && error.name === 'AbortError';
}

function beginWinRequest({ replace = true } = {}) {
  if (state.request && !replace) return null;
  if (state.request) state.request.controller.abort();
  const request = {
    id: ++state.requestSequence,
    controller: new AbortController(),
  };
  state.request = request;
  return request;
}

function isCurrentRequest(request) {
  return state.request === request;
}

function finishWinRequest(request) {
  if (isCurrentRequest(request)) state.request = null;
}

function setSyncStatus(mode, text) {
  elements.winSyncStatus.className = `sync-status ${mode}`;
  elements.winSyncStatus.textContent = text;
}

function markSyncSuccess() {
  setSyncStatus('success', `已同步 ${new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date())}`);
}

function markSyncError() {
  setSyncStatus('error', '连接中断，当前显示为缓存内容');
}

async function api(endpoint, parameters = {}, options = {}) {
  const url = new URL(`./api/${endpoint}`, window.location.href);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url, { cache: 'no-store', signal: options.signal });
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
    headers: { 'Content-Type': 'application/json', 'X-QLV-Action': '1' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (response.status === 401) window.location.reload();
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function formatTime(value) {
  const number = Number(value || 0);
  if (!number) return '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(number < 10_000_000_000 ? number * 1000 : number));
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

function profileUrl(uid) {
  return /^\d+$/.test(String(uid || '')) ? `https://space.bilibili.com/${uid}` : '';
}

function identity(name, uid) {
  return `${name || '昵称暂未获取'}（UID ${uid || '未知'}）`;
}

function metadata(label, value) {
  const item = document.createElement('span');
  const name = document.createElement('b');
  name.textContent = `${label}：`;
  item.append(name, document.createTextNode(value));
  return item;
}

function actionLink(label, href) {
  const link = document.createElement('a');
  link.className = 'button-link';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = label;
  return link;
}

function renderLoading() {
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  const title = document.createElement('strong');
  title.textContent = '正在读取中奖提醒…';
  loading.append(title);
  elements.winsList.replaceChildren(loading);
}

function renderUnavailable() {
  const unavailable = document.createElement('div');
  unavailable.className = 'empty-state';
  const title = document.createElement('strong');
  title.textContent = '当前筛选暂时无法同步';
  const hint = document.createElement('span');
  hint.textContent = '网络恢复后会自动重试，也可以点击刷新。';
  unavailable.append(title, hint);
  elements.winsList.replaceChildren(unavailable);
}

function render() {
  elements.winsList.replaceChildren();
  if (!state.records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = state.status === 'pending'
      ? '当前没有待领取提醒'
      : state.status === 'review' ? '当前没有待确认消息' : state.status === 'reservation' ? '当前没有参与或预约确认' : '当前没有已归档记录';
    const hint = document.createElement('span');
    hint.textContent = state.status === 'pending'
      ? '只有具备明确中奖信号的私信会持续提醒。'
      : state.status === 'review'
        ? '只有弱中奖线索的私信只推送一次，可人工归档。'
        : state.status === 'reservation' ? '参与确认静默保留，不计入中奖数量。' : '已回复、手动归档及自动过滤的记录保留在这里。';
    empty.append(title, hint);
    elements.winsList.append(empty);
    return;
  }

  state.records.forEach(record => {
    const card = document.createElement('article');
    card.className = `win-card ${record.status}`;
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = record.accountName || `账号 ${record.accountNumber || ''}`;
    const account = document.createElement('div');
    account.className = 'win-account';
    const avatar = document.createElement('span');
    avatar.className = 'win-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (record.accountName || '奖').slice(0, 1);
    const accountCopy = document.createElement('div');
    accountCopy.className = 'win-account-copy';
    const uid = document.createElement('small');
    uid.textContent = `${record.owner || '归属未设置'} · ${record.server || ''} · UID ${record.accountUid || '未知'}`;
    accountCopy.append(title, uid);
    account.append(avatar, accountCopy);
    const status = document.createElement('span');
    status.className = `win-status ${record.status}`;
    status.textContent = record.status === 'dismissed'
      ? `已归档${record.sourceStatus === 'review' ? '（原待确认）' : ''}`
      : ({review:'待确认', reservation:'参与／预约', acknowledged:'已回复', ignored:'自动过滤'})[record.status] || '待领取';
    header.append(account, status);

    const meta = document.createElement('div');
    meta.className = 'win-meta';
    meta.append(
      metadata('本地序号', `帐号${record.accountNumber}`),
      metadata('发信人', identity(record.senderName, record.senderUid || record.talkerId)),
      metadata('私信时间', formatTime(record.messageTimestamp)),
      metadata('发现时间', formatTime(record.detectedAt)),
      metadata('已推送', `${record.notifyCount} 次`),
      metadata('来源', ({private:'私信',at:'@消息',reply:'回复'})[record.source] || '私信'),
      metadata('判定', record.reason || '等待分类'),
    );
    if (record.lastNotifiedAt) meta.append(metadata('最近推送', formatTime(record.lastNotifiedAt)));
    if (record.dismissedAt) meta.append(metadata('归档时间', formatTime(record.dismissedAt)));

    const content = document.createElement('pre');
    content.className = 'win-content';
    content.textContent = record.content || '（私信正文为空）';

    const actions = document.createElement('footer');
    const accountProfile = profileUrl(record.accountUid);
    if (accountProfile) actions.append(actionLink('账号主页 ↗', accountProfile));
    const messageLink = safeBilibiliUrl(record.link);
    if (messageLink) actions.append(actionLink('查看原消息 ↗', messageLink));
    if (record.status === 'review') {
      const confirm = document.createElement('button');
      confirm.textContent = '确认为中奖'; confirm.type = 'button';
      const operationId = crypto.randomUUID();
      confirm.addEventListener('click', async () => {
        if (!window.confirm('确认这条消息是该账号中奖？确认后每2小时提醒，回复或归档后停止。')) return;
        confirm.disabled = true;
        try {
          await apiPost('wins/confirm', {accountUid: record.accountUid, recordId: record.id || record.recordId, operationId});
          state.recordsByStatus = {}; await loadWins(); toast('已确认为中奖', 'success');
        } catch (error) { toast(`确认未完成：${error.message}`, 'error'); confirm.disabled = false; }
      });
      actions.append(confirm);
    }
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = record.status === 'dismissed' ? '' : 'danger-action';
    toggle.textContent = record.status === 'dismissed'
      ? (record.sourceStatus === 'review' ? '恢复待确认' : '恢复提醒')
      : record.status === 'review' ? '归档' : '取消提醒';
    toggle.addEventListener('click', async () => {
      const dismissing = record.status !== 'dismissed';
      const prompt = dismissing
        ? record.status === 'review'
          ? '确定归档这条待确认消息？\n\n这不会标记已读、删除或修改 B 站私信。'
          : '确定取消这条 PushPlus 提醒？\n\n这不会标记已读、删除或修改 B 站私信。'
        : record.sourceStatus === 'review'
          ? '确定恢复到待确认？疑似中奖消息不会再次推送。'
          : '确定恢复这条提醒？达到提醒间隔后会重新推送。';
      if (!window.confirm(prompt)) return;
      toggle.disabled = true;
      try {
        await apiPost(dismissing ? 'wins/dismiss' : 'wins/restore', {
          accountUid: record.accountUid,
          recordId: record.id || record.recordId,
          operationId: toggle.dataset.operationId || (toggle.dataset.operationId = crypto.randomUUID()),
        });
        state.recordsByStatus.pending = null;
        state.recordsByStatus.review = null;
        state.recordsByStatus.dismissed = null;
        toast(
          dismissing
            ? (record.status === 'review' ? '已归档待确认消息' : '已取消后续重复提醒')
            : (record.sourceStatus === 'review' ? '已恢复到待确认' : '已恢复提醒'),
          'success'
        );
        await loadWins();
      } catch (error) {
        toast(`操作失败：${error.message}`, 'error');
        toggle.disabled = false;
      }
    });
    if (!['acknowledged', 'ignored'].includes(record.status)) actions.append(toggle);
    card.append(header, meta, content, actions);
    elements.winsList.append(card);
  });
}

async function loadWins(options = {}) {
  const request = beginWinRequest({ replace: !options.silent });
  if (!request) return false;
  const requestedStatus = state.status;
  try {
    if (!options.silent) {
      elements.winsList.setAttribute('aria-busy', 'true');
      setSyncStatus('syncing', '正在同步');
    }
    if (state.renderedStatus !== requestedStatus) {
      const cachedRecords = state.recordsByStatus[requestedStatus];
      state.renderedStatus = requestedStatus;
      if (Array.isArray(cachedRecords)) {
        state.records = cachedRecords;
        render();
      } else {
        state.records = [];
        renderLoading();
      }
    }
    elements.refreshWins.disabled = true;
    const filters = {status: requestedStatus};
    for (const [id, field] of [['serverFilter','server'],['ownerFilter','owner'],['accountFilter','accountUid'],['categoryFilter','category']]) {
      if ($(id).value) filters[field] = $(id).value;
    }
    const payload = await api('wins', filters, { signal: request.controller.signal });
    if (!isCurrentRequest(request) || state.status !== requestedStatus) return false;
    state.records = payload.records;
    state.recordsByStatus[requestedStatus] = payload.records;
    state.renderedStatus = requestedStatus;
    elements.viewerInstance.textContent = payload.instance === '主服务器' ? '主账号组'
      : payload.instance === '副服务器' ? '副账号组' : payload.instance || '当前账号组';
    elements.peerWinnerLink.textContent = payload.instance === '主服务器' ? '切换至副账号组 ↗'
      : payload.instance === '副服务器' ? '切换至主账号组 ↗' : '切换账号组 ↗';
    elements.pendingCount.textContent = String(payload.counts.pending);
    elements.reviewCount.textContent = String(payload.counts.review);
    elements.dismissedCount.textContent = String(payload.counts.dismissed);
    elements.reservationCount.textContent = String(payload.counts.reservation || 0);
    if (payload.options) for (const [id, field, label] of [['serverFilter','server','全部服务器'],['ownerFilter','owner','全部归属'],['accountFilter','accountUid','全部账号']]) {
      const select = $(id), selected = select.value;
      select.replaceChildren(new Option(label, ''), ...(payload.options[field] || []).map(value => new Option(field==='accountUid' && payload.accountLabels ? payload.accountLabels[value] || value : value, value)));
      select.value = selected;
    }
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(Boolean) : [];
    elements.winsWarnings.replaceChildren(...warnings.map(message => {
      const item = document.createElement('p');
      item.textContent = message;
      return item;
    }));
    elements.winsWarnings.classList.toggle('hidden', warnings.length === 0);
    for (const [element, href] of [
      [elements.logViewerLink, payload.logViewerUrl],
      [elements.peerWinnerLink, payload.peerWinnerUrl],
    ]) {
      if (href) {
        element.href = href;
        element.classList.remove('hidden');
      } else {
        element.classList.add('hidden');
      }
    }
    render();
    markSyncSuccess();
    return true;
  } catch (error) {
    if (!isCurrentRequest(request) || isAbortError(error)) return false;
    markSyncError();
    if (!Array.isArray(state.recordsByStatus[requestedStatus])) renderUnavailable();
    if (!options.silent) toast(`中奖提醒读取失败：${error.message}`, 'error');
    return false;
  } finally {
    if (isCurrentRequest(request)) {
      finishWinRequest(request);
      elements.winsList.removeAttribute('aria-busy');
      elements.refreshWins.disabled = false;
    }
  }
}

elements.refreshWins.addEventListener('click', () => loadWins());
elements.logoutViewer.addEventListener('click', async () => {
  if (!window.confirm('确定退出？下次访问日志或中奖管理均需要重新登录。')) return;
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
    state.status = button.dataset.winStatus;
    document.querySelectorAll('[data-win-status]').forEach(item => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    document.getElementById('currentFilterLabel').textContent = `/ ${{ pending: '待处理', review: '待确认', reservation:'参与／预约', dismissed: '已归档' }[state.status]}`;
    await loadWins();
  });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadWins({ silent: true });
});
window.addEventListener('pagehide', () => {
  if (state.request) state.request.controller.abort();
  state.request = null;
});

for (const id of ['serverFilter','ownerFilter','accountFilter','categoryFilter']) $(id).addEventListener('change', () => {
  state.recordsByStatus = {}; state.renderedStatus = ''; loadWins();
});
loadWins();
setInterval(() => {
  if (!document.hidden) loadWins({ silent: true });
}, 60_000);
