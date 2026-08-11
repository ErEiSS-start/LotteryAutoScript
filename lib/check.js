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

function isWinnerMessage(content, noticeKeyWords) {
    const text = messageText(content).replace(/\s+/g, ' ').trim();
    if (!text) return false;

    // “预约成功并参与抽奖”是系统参与确认。奖品描述中即使带有
    // “联系客服领取”等字样，也不能把整条确认消息判成中奖通知。
    const hardNonWinnerSignals = [
        /预约成功.{0,32}(?:参与|参加)(?:了|本次)?抽奖/,
    ];
    if (hardNonWinnerSignals.some(pattern => pattern.test(text))) return false;

    const strongWinnerSignals = [
        /(?:恭喜|祝贺)(?:您|你)?.{0,16}(?:中奖|获奖|抽中|获得)/,
        /(?:你|您).{0,16}(?:中奖|获奖|被抽中)/,
        /(?:中奖|获奖)(?:通知|提醒|结果)/,
        /(?:请|麻烦)(?:您|你)?.{0,24}(?:填写|提供|回复|提交).{0,24}(?:收货|地址|姓名|电话|手机|联系方式|支付宝|领奖|兑奖)/,
        /(?:联系|添加).{0,16}(?:客服|工作人员).{0,16}(?:领奖|领取|兑奖)/,
        /(?:领取|兑换)(?:您的|你的|本次)?.{0,8}(?:奖品|奖励)/,
    ];
    if (strongWinnerSignals.some(pattern => pattern.test(text))) return true;

    const nonWinnerSignals = [
        /(?:成功|已经|已)?(?:参与|参加)(?:了|本次)?抽奖(?:活动)?/,
        /【有奖(?:调研|活动)】/,
        /(?:诚邀|邀请).{0,20}(?:参与|填写).{0,12}(?:调研|问卷)/,
        /(?:点击|前往).{0,24}(?:参与活动|参与调研|填写问卷|完成任务)/,
    ];
    if (nonWinnerSignals.some(pattern => pattern.test(text))) return false;
    return judge(text, noticeKeyWords);
}

async function getSessionInfoWithRetry(sessionType, endTs = '', options = {}) {
    const client = options.client || bili;
    const delayFn = options.delayFn || delay;
    const logger = options.logger || log;
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
    const baseWaitMs = Math.max(1000, Number(options.baseWaitMs) || 15000);
    let result;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = await client.getSessionInfo(sessionType, endTs);
        if (!result?.errorCode) return result;
        if (Number(result.errorCode) !== -509 || attempt >= maxAttempts) return result;
        const waitMs = baseWaitMs * attempt;
        logger.warn(
            '中奖私信重试',
            `当前页第${attempt}次收到-509，${Math.round(waitMs / 1000)}秒后只重试当前页`
        );
        await delayFn(waitMs);
    }
    return result || { has_more: 0, data: [], errorCode: -1, errorMessage: '未知错误' };
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
    const ignoredRecords = pendingStore.ignoreWhere(
        record => !isWinnerMessage(record.content, notice_key_words),
        'filtered-non-winner-message'
    );
    if (ignoredRecords.length) {
        log.notice(
            '待领取中奖记录',
            `自动归档${ignoredRecords.length}条预约成功、调研或活动邀请误报`
        );
    }

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
                if (isWinnerMessage(source, notice_key_words)) {
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
        let sessionScanComplete = true;
        const check = async (type, expectedUnread) => {
            let session_t = '';
            let coveredUnread = 0;
            let pagesRead = 0;
            const retryOptions = {
                baseWaitMs: Math.max(15000, Number(get_session_wait) || 0),
            };
            let MySession = await getSessionInfoWithRetry(type, '', retryOptions);
            log.info(
                '准备检查私信',
                `未读${expectedUnread}条，最多${check_session_pages}页，覆盖全部未读后立即停止`
            );
            for (const index of infiniteNumber()) {
                if (MySession.errorCode) {
                    log.warn(
                        '中奖私信扫描',
                        `当前页连续失败(code=${MySession.errorCode})，本轮扫描不完整，等待下次任务补查`
                    );
                    return false;
                }
                pagesRead += 1;
                const previousSessionTs = session_t;
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
                        coveredUnread += Math.max(0, Number(unread_count) || 0);
                        const messages = await bili.getSessionMessages(
                            talker_id,
                            Math.max(unread_count, Number(winner_reply_check_size) || 20)
                        );
                        messagesByTalker.set(String(talker_id), messages);
                        for (const message of messages) {
                            const normalized = normalizeSessionMessage(message);
                            if (normalized.senderUid === myUid) continue;
                            const content = messageText(message.content).trim();
                            if (!isWinnerMessage(content, notice_key_words)) continue;
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
                if (coveredUnread >= Number(expectedUnread)) {
                    log.info(
                        '中奖私信扫描',
                        `读取${pagesRead}页已覆盖${coveredUnread}/${expectedUnread}条未读，停止继续翻页`
                    );
                    return true;
                }
                if (MySession.has_more && index < check_session_pages) {
                    if (!session_t || session_t === previousSessionTs) {
                        log.warn('中奖私信扫描', '分页游标未推进，本轮提前停止以避免重复请求');
                        return false;
                    }
                    await delay(get_session_wait);
                    MySession = await getSessionInfoWithRetry(type, session_t, retryOptions);
                } else {
                    const complete = !MySession.has_more;
                    if (!complete) {
                        log.warn(
                            '中奖私信扫描',
                            `达到${check_session_pages}页上限，仅覆盖${coveredUnread}/${expectedUnread}条未读`
                        );
                    }
                    return complete;
                }
            }
            return false;
        };
        if (follow_unread) {
            log.info('中奖检测', '<-- 正在检查已关注者的私信');
        }
        if (unfollow_unread) {
            log.info('中奖检测', '<-- 正在检查未关注者的私信');
        }
        if (follow_unread) sessionScanComplete = await check('1', follow_unread) && sessionScanComplete;
        if (unfollow_unread) sessionScanComplete = await check('2', unfollow_unread) && sessionScanComplete;
        if (sessionScanComplete) log.info('中奖检测', '--> OK');
        else log.warn('中奖检测', '--> 私信扫描部分完成，下轮将继续补查');
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
    getSessionInfoWithRetry,
    identity,
    isWinnerMessage,
    isMe,
    privateMessageDescription,
};
