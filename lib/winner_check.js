const fs = require('fs');
const { log, delay } = require('./utils');
const config = require('./data/config');
const globalVar = require('./data/global_var');
const client = require('./net/bili');
const result = require('./helper/task_result');
const events = require('./helper/winner_events');
const { PendingWinStore, normalizeSessionMessage } = require('./helper/pending_win_store');
const { scanUnreadSessions } = require('./helper/session_scan');
async function run(number) {
    const uid = String(globalVar.get('myUID'));
    const name = globalVar.get('myUNAME') || '';
    const store = new PendingWinStore({ accountUid: uid, accountNumber: number });
    let aliases = [];
    if (process.env.TASK_WINS_CONFIG && fs.existsSync(process.env.TASK_WINS_CONFIG)) {
        const owner = JSON.parse(fs.readFileSync(process.env.TASK_WINS_CONFIG,'utf8')).owners || {};
        if (owner[uid] && owner[uid].name) aliases.push(owner[uid].name);
    }
    const common = { accountUid: uid, accountNumber: number, accountName: name, aliases, keywords: config.notice_key_words };
    const active = new Set();
    const seenTalkers = new Set();
    for (const row of store.load()) if (['pending', 'review'].includes(row.status)) active.add(String(row.talkerId));
    if (process.env.TASK_WINS_ACTIVE && fs.existsSync(process.env.TASK_WINS_ACTIVE)) {
        for (const row of JSON.parse(fs.readFileSync(process.env.TASK_WINS_ACTIVE, 'utf8'))) {
            if (String(row.accountUid) === uid) active.add(String(row.talkerId));
        }
    }
    function save(record) {
        const row = events.message({ ...common, ...record });
        // Retain a compatible ledger for older releases, without dispatching notifications.
        if (row.source === 'private' && ['winner', 'review'].includes(row.category)) store.add({ ...row, status: row.category === 'winner' ? 'pending' : 'review' });
    }
    const unread = await client.getUnreadNum();
    const counts = await client.getUnreadSessionNum();
    if (!unread || !counts) result.fail('CHECK_INCOMPLETE', 'check');
    for (const type of ['at', 'reply']) {
        const expected = Number(unread && unread[type]) || 0;
        if (!expected) continue;
        let cursor = '', covered = 0;
        const limit = Math.max(1, Number(config.check_session_pages) || 16);
        const seen = new Set();
        for (let page = 0; page < limit; page++) {
            const response = await client.getWinnerFeedPage(type, cursor);
            if (!response || response.errorCode) { result.fail('CHECK_INCOMPLETE', 'check'); break; }
            for (const row of response.items) {
                if (seen.has(row.sourceMessageId)) continue;
                seen.add(row.sourceMessageId); covered++;
                save({ ...row, source: type, talkerId: row.senderUid });
            }
            if (covered >= expected || response.end) break;
            if (!response.cursor || response.cursor === cursor || page + 1 >= limit) { result.fail('CHECK_INCOMPLETE', 'check'); break; }
            cursor = response.cursor; await delay(config.get_session_wait);
        }
    }
    async function messages(talkerId, expected, onlyReplies, senderName = '') {
        if (seenTalkers.has(String(talkerId))) return;
        seenTalkers.add(String(talkerId));
        const page = await client.getWinnerPrivateMessages(talkerId, expected,
            { maxPages: config.check_session_pages, wait: delay, waitMs: config.get_session_wait, onlyReplies });
        if (!page.complete) result.fail('CHECK_INCOMPLETE', 'check');
        for (const raw of page.messages) {
            if (Number(raw.msg_status) === 1) continue; // Do not surface recalled private content.
            const msg = normalizeSessionMessage(raw);
            if (msg.senderUid === uid) events.reply({ ...common, talkerId: String(talkerId), messageSequence: msg.sequence, messageTimestamp: msg.timestamp });
            else if (!onlyReplies) save({ ...common, source: 'private', senderName, talkerId: String(talkerId), senderUid: msg.senderUid || String(talkerId),
                sourceMessageId: String(raw.msg_key || msg.sequence || ''), messageSequence: msg.sequence,
                messageTimestamp: msg.timestamp, content: msg.content, link: 'https://message.bilibili.com/#/whisper/mid' + talkerId });
        }
    }
    if (counts) for (const [scope, expected] of [['1', counts.follow_unread], ['2', counts.unfollow_unread]]) {
        if (!expected) continue;
        const scanned = await scanUnreadSessions({ expectedUnread: expected, maxPages: config.check_session_pages,
            getPage: cursor => require('./check').getSessionInfoWithRetry(scope, cursor),
            wait: delay, delayMs: config.get_session_wait,
            onSession: row => messages(row.talker_id, row.unread_count, false, row.sender_name) });
        if (!scanned.complete) result.fail('CHECK_INCOMPLETE', 'check');
    }
    for (const talkerId of active) if (/^[1-9]\d*$/.test(talkerId)) await messages(talkerId, Number(config.winner_reply_check_size) || 20, true);
    log.info('中奖检查', '新线索已持久化；通知由宿主机可靠队列处理，保持平台消息未读');
}
module.exports = { run };
