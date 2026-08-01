const { log, delay, infiniteNumber, judge } = require('./utils');
const { sendNotify } = require('./helper/notify');
const path = require('path');
const {
    PendingWinStore,
    messageText,
    normalizeSessionMessage,
} = require('./helper/pending_win_store');
const { createProfileResolver } = require('./helper/profile_resolver');
const config = require('./data/config');
const global_var = require('./data/global_var');
const bili = require('./net/bili');

const winnerProfileResolver = createProfileResolver({
    cacheFile: path.join(process.cwd(), 'web_state', 'profile-cache.json'),
    logger: {
        warn(message) {
            log.warn('中奖昵称', message);
        },
    },
});

function identity(name, uid) {
    return `${String(name || '').trim() || '昵称暂未获取'}（UID ${String(uid || '').trim() || '未知'}）`;
}

async function enrichPrivateMessageRecords(records, accountName, resolver = winnerProfileResolver) {
    const source = Array.isArray(records) ? records : [];
    const fallbackAccountName = String(accountName || '').trim();
    const missingUids = [];
    for (const record of source) {
        if (!record.senderName && record.senderUid) missingUids.push(record.senderUid);
        if (!record.accountName && !fallbackAccountName && record.accountUid) {
            missingUids.push(record.accountUid);
        }
    }
    let profileNames = {};
    if (missingUids.length) {
        try {
            profileNames = await resolver.resolveMany(missingUids);
        } catch (error) {
            log.warn('中奖昵称', `昵称补全失败，本轮仅显示UID: ${error.message}`);
        }
    }
    return source.map(record => ({
        ...record,
        senderName: record.senderName || profileNames[record.senderUid] || '',
        accountName: record.accountName || fallbackAccountName || profileNames[record.accountUid] || '',
    }));
}

function privateMessageDescription(records) {
    let desp = '';
    for (const record of records) {
        desp += '## 待领取中奖私信\n\n';
        desp += '- - - -\n\n';
        desp += `发生时间: ${new Date(record.messageTimestamp * 1000).toLocaleString()}\n\n`;
        desp += `发信人: ${identity(record.senderName, record.senderUid || record.talkerId)}\n\n`;
        desp += `中奖账号: ${identity(record.accountName, record.accountUid)}\n\n`;
        desp += `私信内容:\n${record.content}\n\n`;
        desp += `[前往回复](${record.link})\n\n`;
        desp += `这是第${Number(record.notifyCount || 0) + 1}次提醒；在该私信会话回复后将自动停止。\n\n`;
        desp += '- - - -\n\n';
    }
    return desp;
}

/**
 * 是否中奖
 * @param {number} num
 */
async function isMe(num) {
    let desp = '';
    const
        {
            notice_key_words,
            get_session_wait,
            check_session_pages,
            winner_reminder_interval,
            winner_reply_check_size,
        } = config,
        { at: unread_at_num, reply: unread_reply_num } = await bili.getUnreadNum(),
        unread_session_num = await bili.getUnreadSessionNum(),
        { follow_unread, unfollow_unread } = unread_session_num || { unfollow_unread: 0, follow_unread: 0 },
        myUid = String(global_var.get('myUID') || ''),
        pendingStore = new PendingWinStore({ accountUid: myUid, accountNumber: num }),
        messagesByTalker = new Map();
    pendingStore.load();

    if (unread_at_num) {
        log.info('中奖检测', '<-- 正在检查at');
        const MyAtInfo = await bili.getMyAtInfo();
        MyAtInfo
            .slice(0, unread_at_num)
            .forEach(({ at_time, up_uname, business, source_content, url }) => {
                desp += '## [at]检测结果\n\n';
                desp += '- - - -\n\n';
                desp += `发生时间: ${new Date(at_time * 1000).toLocaleString()}\n\n`;
                desp += `用户: ${up_uname}\n\n`;
                desp += `在${business}中@了[你](https://space.bilibili.com/${global_var.get('myUID')})\n\n`;
                desp += `原内容为: ${source_content}\n\n`;
                desp += `[直达链接](${url})\n\n`;
                desp += '- - - -\n\n';
            });
        log.info('中奖检测', '--> OK');
    }
    if (unread_reply_num) {
        log.info('中奖检测', '<-- 正在检查回复');
        const replys = await bili.getReplyMsg();
        replys
            .slice(0, unread_reply_num)
            .forEach(({ nickname, uri, source, timestamp }) => {
                if (judge(source, notice_key_words)) {
                    desp += '## 回复检测结果\n\n';
                    desp += '- - - -\n\n';
                    desp += `发生时间: ${new Date(timestamp * 1000).toLocaleString()}\n\n`;
                    desp += `用户: ${nickname}\n\n`;
                    desp += `回复[你](https://space.bilibili.com/${global_var.get('myUID')})说:\n${source}\n\n`;
                    desp += `[直达链接](${uri})\n\n`;
                    desp += '- - - -\n\n';
                }
            });
        log.info('中奖检测', '--> OK');
    }

    if (follow_unread + unfollow_unread > 0) {
        const check = async (type) => {
            let session_t = '';
            let MySession = await bili.getSessionInfo(type);
            log.info('准备检查私信', check_session_pages + '页');
            for (const index of infiniteNumber()) {
                for (const Session of MySession.data) {
                    const {
                        sender_uid,
                        sender_name,
                        session_ts,
                        timestamp,
                        unread_count,
                        talker_id,
                        msg_seqno,
                    } = Session;
                    session_t = session_ts;
                    if (unread_count) {
                        const messages = await bili.getSessionMessages(
                            talker_id,
                            Math.max(unread_count, Number(winner_reply_check_size) || 20)
                        );
                        messagesByTalker.set(String(talker_id), messages);
                        for (const message of messages) {
                            const normalized = normalizeSessionMessage(message);
                            if (normalized.senderUid === myUid) continue;
                            const content = messageText(message.content).trim();
                            if (!content || !judge(content, notice_key_words)) continue;
                            const result = pendingStore.add({
                                talkerId: talker_id,
                                senderUid: normalized.senderUid || sender_uid,
                                senderName: sender_name,
                                accountName: global_var.get('myUNAME') || '',
                                sessionType: type,
                                messageSequence: normalized.sequence || msg_seqno,
                                messageTimestamp: normalized.timestamp || timestamp,
                                content,
                                link: `https://message.bilibili.com/#/whisper/mid${talker_id}`,
                            });
                            if (result?.created) {
                                log.notice(
                                    '待领取中奖记录',
                                    `新增帐号${num}与用户${talker_id}的中奖私信，保持未读`
                                );
                            }
                        }
                    }
                }
                if (MySession.has_more && index < check_session_pages) {
                    await delay(get_session_wait);
                    MySession = await bili.getSessionInfo(type, session_t);
                } else {
                    break;
                }
            }
        };
        if (follow_unread) {
            log.info('中奖检测', '<-- 正在检查已关注者的私信');
        }
        if (unfollow_unread) {
            log.info('中奖检测', '<-- 正在检查未关注者的私信');
        }
        if (follow_unread) await check('1');
        if (unfollow_unread) await check('2');
        log.info('中奖检测', '--> OK');
    }

    const pendingByTalker = new Map();
    for (const record of pendingStore.pending()) {
        const records = pendingByTalker.get(record.talkerId) || [];
        records.push(record);
        pendingByTalker.set(record.talkerId, records);
    }
    for (const [talkerId] of pendingByTalker) {
        const messages = messagesByTalker.get(talkerId)
            || await bili.getSessionMessages(talkerId, Number(winner_reply_check_size) || 20);
        const acknowledged = pendingStore.acknowledgeByMessages(talkerId, messages, myUid);
        if (acknowledged.length) {
            log.notice(
                '待领取中奖记录',
                `检测到帐号${num}已在用户${talkerId}的私信会话回复，停止提醒${acknowledged.length}条记录`
            );
        }
    }

    const dueRecords = pendingStore.due(
        Number(winner_reminder_interval) || 2 * 60 * 60 * 1000
    );
    if (dueRecords.length) {
        const enrichedRecords = await enrichPrivateMessageRecords(
            dueRecords,
            global_var.get('myUNAME') || ''
        );
        desp += privateMessageDescription(enrichedRecords);
    }

    if (desp) {
        const pendingCount = pendingStore.pending().length;
        log.notice('可能中奖了', desp);
        await sendNotify(
            pendingCount
                ? `帐号${num}有${pendingCount}条中奖信息待领取`
                : `帐号${num}可能中奖了`,
            desp
        );
        pendingStore.markNotified(dueRecords.map(record => record.id));
    } else {
        const pendingCount = pendingStore.pending().length;
        log.notice(
            '中奖检测',
            pendingCount
                ? `有${pendingCount}条待领取记录，尚未到下次提醒时间`
                : '暂未中奖'
        );
    }
    return;
}


module.exports = {
    enrichPrivateMessageRecords,
    identity,
    isMe,
    privateMessageDescription,
};
