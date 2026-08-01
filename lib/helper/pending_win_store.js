const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

const DEFAULT_RETENTION_DAYS = 180;
const DEFAULT_DISMISSED_FILE = path.join(process.cwd(), 'web_state', 'dismissed-wins.json');

function toId(value) {
    return String(value ?? '').trim();
}

function toTimestamp(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function messageText(content) {
    if (content && typeof content === 'object') {
        return String(content.content ?? content.title ?? JSON.stringify(content));
    }
    const text = String(content ?? '');
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
            return String(parsed.content ?? parsed.title ?? text);
        }
    } catch (_) {
        // 普通文本私信无需解析。
    }
    return text;
}

function normalizeSessionMessage(message = {}) {
    return {
        senderUid: toId(message.sender_uid),
        receiverUid: toId(message.receiver_id ?? message.receiver_uid),
        sequence: toId(message.msg_seqno),
        timestamp: toTimestamp(message.timestamp),
        content: messageText(message.content),
    };
}

function compareSequence(left, right) {
    if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return 0;
    try {
        const a = BigInt(left);
        const b = BigInt(right);
        return a === b ? 0 : (a > b ? 1 : -1);
    } catch (_) {
        return 0;
    }
}

function isReplyAfter(record, message, myUid) {
    const normalized = normalizeSessionMessage(message);
    if (!normalized.senderUid || normalized.senderUid !== toId(myUid)) return false;

    const sequenceOrder = compareSequence(normalized.sequence, toId(record.messageSequence));
    if (sequenceOrder) return sequenceOrder > 0;
    return normalized.timestamp > toTimestamp(record.messageTimestamp);
}

function makeRecordId({ talkerId, messageSequence, messageTimestamp, content }) {
    const identity = [
        toId(talkerId),
        toId(messageSequence),
        toTimestamp(messageTimestamp),
        messageText(content),
    ].join('\n');
    return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
}

function validRecord(record) {
    return record
        && /^[0-9]+$/.test(toId(record.talkerId))
        && typeof record.content === 'string'
        && ['pending', 'acknowledged'].includes(record.status);
}

function dismissalKey(accountUid, recordId) {
    return `${toId(accountUid)}:${toId(recordId)}`;
}

function readDismissedKeys(filePath) {
    if (!fs.existsSync(filePath)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || !Array.isArray(parsed.records)) {
        throw new Error('取消提醒账本格式无效');
    }
    return new Set(parsed.records
        .filter(record => (
            record
            && /^\d+$/.test(toId(record.accountUid))
            && /^[a-f0-9]{24}$/i.test(toId(record.recordId))
        ))
        .map(record => dismissalKey(record.accountUid, record.recordId)));
}

class PendingWinStore {
    constructor({
        accountUid,
        accountNumber,
        filePath,
        now = () => Date.now(),
        logger = log,
        retentionDays = DEFAULT_RETENTION_DAYS,
        dismissedFilePath = process.env.WIN_STATE_FILE || DEFAULT_DISMISSED_FILE,
    } = {}) {
        this.accountUid = toId(accountUid);
        this.accountNumber = Math.max(1, Number(accountNumber) || 1);
        this.filePath = filePath || path.join(
            process.cwd(),
            'lottery_info',
            `pending_wins_${this.accountUid || `account_${this.accountNumber}`}.json`
        );
        this.now = now;
        this.logger = logger;
        this.retentionDays = Math.max(1, Number(retentionDays) || DEFAULT_RETENTION_DAYS);
        this.dismissedFilePath = dismissedFilePath;
        this.dismissedReadWarning = '';
        this.loaded = false;
        this.records = [];
    }

    load() {
        if (this.loaded) return this.records;
        this.loaded = true;
        try {
            if (fs.existsSync(this.filePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.records = Array.isArray(parsed?.records)
                    ? parsed.records.filter(validRecord)
                    : [];
            }
        } catch (error) {
            this.records = [];
            this.logger.warn('待领取中奖记录', `读取失败，将保留损坏文件并从空记录继续: ${error.message}`);
            try {
                if (fs.existsSync(this.filePath)) {
                    fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${this.now()}`);
                }
            } catch (backupError) {
                this.logger.warn('待领取中奖记录', `损坏文件备份失败: ${backupError.message}`);
            }
        }
        this.prune();
        return this.records;
    }

    prune() {
        const cutoff = this.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        this.records = this.records.filter(record => (
            record.status === 'pending'
            || Number(record.acknowledgedAt || 0) >= cutoff
        ));
        return this.records;
    }

    add({
        talkerId,
        senderUid,
        sessionType = 1,
        messageSequence,
        messageTimestamp,
        content,
        link,
    }) {
        this.load();
        const normalized = {
            talkerId: toId(talkerId),
            senderUid: toId(senderUid || talkerId),
            sessionType: Math.max(1, Number(sessionType) || 1),
            messageSequence: toId(messageSequence),
            messageTimestamp: toTimestamp(messageTimestamp),
            content: messageText(content).trim(),
            link: String(link || ''),
        };
        if (!/^[0-9]+$/.test(normalized.talkerId) || !normalized.content) return null;

        const id = makeRecordId(normalized);
        const existing = this.records.find(record => record.id === id);
        if (existing) return { record: existing, created: false };

        const record = {
            id,
            accountUid: this.accountUid,
            accountNumber: this.accountNumber,
            ...normalized,
            status: 'pending',
            detectedAt: this.now(),
            lastNotifiedAt: 0,
            notifyCount: 0,
        };
        this.records.push(record);
        this.save();
        return { record, created: true };
    }

    pending() {
        this.load();
        let dismissed = new Set();
        try {
            dismissed = readDismissedKeys(this.dismissedFilePath);
            this.dismissedReadWarning = '';
        } catch (error) {
            // 账本损坏时宁可继续提醒，也不能漏掉真实中奖。
            const warning = `${this.dismissedFilePath}:${error.message}`;
            if (warning !== this.dismissedReadWarning) {
                this.logger.warn('中奖取消提醒账本', `读取失败，本轮按未取消处理: ${error.message}`);
                this.dismissedReadWarning = warning;
            }
        }
        return this.records.filter(record => (
            record.status === 'pending'
            && !dismissed.has(dismissalKey(record.accountUid || this.accountUid, record.id))
        ));
    }

    due(intervalMs) {
        const now = this.now();
        const interval = Math.max(0, Number(intervalMs) || 0);
        return this.pending().filter(record => (
            !record.lastNotifiedAt || now - Number(record.lastNotifiedAt) >= interval
        ));
    }

    acknowledgeByMessages(talkerId, messages, myUid) {
        this.load();
        const now = this.now();
        const acknowledged = [];
        for (const record of this.records) {
            if (record.status !== 'pending' || record.talkerId !== toId(talkerId)) continue;
            const reply = messages.find(message => isReplyAfter(record, message, myUid));
            if (!reply) continue;
            const normalizedReply = normalizeSessionMessage(reply);
            record.status = 'acknowledged';
            record.acknowledgedAt = now;
            record.acknowledgedBySequence = normalizedReply.sequence;
            acknowledged.push(record);
        }
        if (acknowledged.length) this.save();
        return acknowledged;
    }

    markNotified(recordIds) {
        this.load();
        const ids = new Set(recordIds);
        const now = this.now();
        let changed = false;
        for (const record of this.records) {
            if (record.status !== 'pending' || !ids.has(record.id)) continue;
            record.lastNotifiedAt = now;
            record.notifyCount = Number(record.notifyCount || 0) + 1;
            changed = true;
        }
        if (changed) this.save();
        return changed;
    }

    save() {
        this.prune();
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${process.pid}.next`;
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(
                temporaryPath,
                JSON.stringify({
                    version: 1,
                    accountUid: this.accountUid,
                    accountNumber: this.accountNumber,
                    updatedAt: this.now(),
                    records: this.records,
                }, null, 2),
                'utf8'
            );
            fs.renameSync(temporaryPath, this.filePath);
            return true;
        } catch (error) {
            this.logger.warn('待领取中奖记录', `保存失败: ${error.message}`);
            try {
                if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            } catch (_) {
                // 清理失败不影响中奖检测。
            }
            return false;
        }
    }
}

module.exports = {
    PendingWinStore,
    dismissalKey,
    isReplyAfter,
    messageText,
    normalizeSessionMessage,
    readDismissedKeys,
};
