'use strict';

const state = { status: 'pending', records: [] };
const $ = id => document.getElementById(id);
const elements = {
  viewerInstance: $('viewerInstance'),
  logViewerLink: $('logViewerLink'),
  peerWinnerLink: $('peerWinnerLink'),
  refreshWins: $('refreshWins'),
  logoutViewer: $('logoutViewer'),
  pendingCount: $('pendingCount'),
  dismissedCount: $('dismissedCount'),
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

function render() {
  elements.winsList.replaceChildren();
  if (!state.records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = state.status === 'pending' ? '当前没有待处理提醒' : '当前没有已取消提醒';
    const hint = document.createElement('span');
    hint.textContent = state.status === 'pending'
      ? '只有脚本已经检测并保存的中奖私信会出现在这里。'
      : '手动取消的提醒会保留在这里，可随时恢复。';
    empty.append(title, hint);
    elements.winsList.append(empty);
    return;
  }

  state.records.forEach(record => {
    const card = document.createElement('article');
    card.className = `win-card ${record.status}`;
    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = `中奖账号：${identity(record.accountName, record.accountUid)}`;
    const status = document.createElement('span');
    status.className = `win-status ${record.status}`;
    status.textContent = record.status === 'dismissed' ? '已取消提醒' : '待处理';
    header.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'win-meta';
    meta.append(
      metadata('本地序号', `帐号${record.accountNumber}`),
      metadata('发信人', identity(record.senderName, record.senderUid || record.talkerId)),
      metadata('私信时间', formatTime(record.messageTimestamp)),
      metadata('发现时间', formatTime(record.detectedAt)),
      metadata('已推送', `${record.notifyCount} 次`),
    );
    if (record.lastNotifiedAt) meta.append(metadata('最近推送', formatTime(record.lastNotifiedAt)));
    if (record.dismissedAt) meta.append(metadata('取消时间', formatTime(record.dismissedAt)));

    const content = document.createElement('pre');
    content.className = 'win-content';
    content.textContent = record.content || '（私信正文为空）';

    const actions = document.createElement('footer');
    const accountProfile = profileUrl(record.accountUid);
    if (accountProfile) actions.append(actionLink('打开中奖账号主页', accountProfile));
    const messageLink = safeBilibiliUrl(record.link);
    if (messageLink) actions.append(actionLink('打开 B 站私信', messageLink));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = record.status === 'dismissed' ? '' : 'danger-action';
    toggle.textContent = record.status === 'dismissed' ? '恢复提醒' : '取消提醒';
    toggle.addEventListener('click', async () => {
      const dismissing = record.status !== 'dismissed';
      const prompt = dismissing
        ? '确定取消这条 PushPlus 提醒？\n\n这不会标记已读、删除或修改 B 站私信。'
        : '确定恢复这条提醒？达到提醒间隔后会重新推送。';
      if (!window.confirm(prompt)) return;
      toggle.disabled = true;
      try {
        await apiPost(dismissing ? 'wins/dismiss' : 'wins/restore', {
          accountUid: record.accountUid,
          recordId: record.recordId,
        });
        toast(dismissing ? '已取消后续重复提醒' : '已恢复提醒', 'success');
        await loadWins();
      } catch (error) {
        toast(`操作失败：${error.message}`, 'error');
        toggle.disabled = false;
      }
    });
    actions.append(toggle);
    card.append(header, meta, content, actions);
    elements.winsList.append(card);
  });
}

async function loadWins(options = {}) {
  try {
    if (!options.silent) elements.winsList.setAttribute('aria-busy', 'true');
    const payload = await api('wins', { status: state.status });
    state.records = payload.records;
    elements.viewerInstance.textContent = payload.instance || '本服务器';
    elements.pendingCount.textContent = String(payload.counts.pending);
    elements.dismissedCount.textContent = String(payload.counts.dismissed);
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
  } catch (error) {
    if (!options.silent) toast(`中奖提醒读取失败：${error.message}`, 'error');
  } finally {
    elements.winsList.removeAttribute('aria-busy');
  }
}

elements.refreshWins.addEventListener('click', () => loadWins());
elements.logoutViewer.addEventListener('click', async () => {
  if (!window.confirm('确定退出？下次访问日志或中奖管理均需要重新登录。')) return;
  await apiPost('logout', {});
  window.location.reload();
});
document.querySelectorAll('[data-win-status]').forEach(button => {
  button.addEventListener('click', async () => {
    state.status = button.dataset.winStatus;
    document.querySelectorAll('[data-win-status]').forEach(item => item.classList.toggle('active', item === button));
    await loadWins();
  });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadWins({ silent: true });
});

loadWins();
setInterval(() => {
  if (!document.hidden) loadWins({ silent: true });
}, 60_000);
