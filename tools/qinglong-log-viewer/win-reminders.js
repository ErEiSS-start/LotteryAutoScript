'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MAX_PENDING_FILE_SIZE = 4 * 1024 * 1024;
const RECORD_ID_PATTERN = /^[a-f0-9]{24}$/i;
const UID_PATTERN = /^\d+$/;

function keyOf(accountUid, recordId) {
    return `${String(accountUid)}:${String(recordId).toLowerCase()}`;
}

function validIdentity(accountUid, recordId) {
    return UID_PATTERN.test(String(accountUid || ''))
        && RECORD_ID_PATTERN.test(String(recordId || ''));
}

function normalizeContent(content) {
    if (typeof content === 'string') return content;
    if (content === undefined || content === null) return '';
    return JSON.stringify(content);
}

function normalizePendingRecord(record, document, filenameUid) {
    record = record || {};
    document = document || {};
    const accountUid = String(record.accountUid || document.accountUid || filenameUid || '');
    const recordId = String(record.id || '').toLowerCase();
    if (!validIdentity(accountUid, recordId) || record.status !== 'pending') return null;
    return {
        accountUid,
        accountNumber: Math.max(1, Number(record.accountNumber || document.accountNumber) || 1),
        recordId,
        talkerId: String(record.talkerId || ''),
        senderUid: String(record.senderUid || record.talkerId || ''),
        senderName: String(record.senderName || ''),
        accountName: String(record.accountName || ''),
        messageSequence: String(record.messageSequence || ''),
        messageTimestamp: Number(record.messageTimestamp || 0),
        content: normalizeContent(record.content),
        link: String(record.link || ''),
        detectedAt: Number(record.detectedAt || 0),
        lastNotifiedAt: Number(record.lastNotifiedAt || 0),
        notifyCount: Math.max(0, Number(record.notifyCount || 0)),
    };
}

function normalizeLedger(document) {
    const records = document && Array.isArray(document.records) ? document.records : [];
    return records.filter(record => validIdentity(record && record.accountUid, record && record.recordId)).map(record => ({
        accountUid: String(record.accountUid),
        recordId: String(record.recordId).toLowerCase(),
        dismissedAt: Number(record.dismissedAt || 0),
        reason: 'manual',
    }));
}

function createWinReminderStore({ lotteryRoot, stateFile, now = () => Date.now() }) {
    const lotteryInfoDirectory = path.join(lotteryRoot, 'lottery_info');
    let writeQueue = Promise.resolve();

    async function readLedger() {
        try {
            const document = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
            if (!document || !Array.isArray(document.records)) throw new Error('账本格式无效');
            return normalizeLedger(document);
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw Object.assign(new Error(`取消提醒账本读取失败：${error.message}`), { statusCode: 500 });
        }
    }

    async function readPendingRecords() {
        let entries;
        try {
            entries = await fsp.readdir(lotteryInfoDirectory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
        const files = entries.filter(entry => entry.isFile() && /^pending_wins_(\d+)\.json$/.test(entry.name));
        const groups = await Promise.all(files.map(async entry => {
            const match = entry.name.match(/^pending_wins_(\d+)\.json$/);
            const filePath = path.join(lotteryInfoDirectory, entry.name);
            const stat = await fsp.lstat(filePath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PENDING_FILE_SIZE) return [];
            let document;
            try {
                document = JSON.parse(await fsp.readFile(filePath, 'utf8'));
            } catch (error) {
                if (error instanceof SyntaxError) return [];
                throw error;
            }
            if (!document || !Array.isArray(document.records)) return [];
            return document.records
                .map(record => normalizePendingRecord(record, document, match[1]))
                .filter(Boolean);
        }));
        return groups.flat().sort((left, right) => (
            right.messageTimestamp - left.messageTimestamp
            || right.detectedAt - left.detectedAt
        ));
    }

    async function list(status = 'pending') {
        if (!['pending', 'dismissed', 'all'].includes(status)) {
            throw Object.assign(new Error('status 只能是 pending、dismissed 或 all'), { statusCode: 400 });
        }
        const [pendingRecords, ledger] = await Promise.all([readPendingRecords(), readLedger()]);
        const dismissed = new Map(ledger.map(record => [keyOf(record.accountUid, record.recordId), record]));
        const records = pendingRecords.map(record => {
            const dismissal = dismissed.get(keyOf(record.accountUid, record.recordId));
            return {
                ...record,
                status: dismissal ? 'dismissed' : 'pending',
                dismissedAt: dismissal ? dismissal.dismissedAt : 0,
            };
        });
        return {
            records: status === 'all' ? records : records.filter(record => record.status === status),
            counts: {
                pending: records.filter(record => record.status === 'pending').length,
                dismissed: records.filter(record => record.status === 'dismissed').length,
            },
        };
    }

    async function writeLedger(records) {
        const directory = path.dirname(stateFile);
        const temporaryPath = `${stateFile}.${process.pid}.${now()}.next`;
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        try {
            await fsp.writeFile(temporaryPath, JSON.stringify({
                version: 1,
                updatedAt: now(),
                records,
            }, null, 2), { encoding: 'utf8', mode: 0o600 });
            await fsp.rename(temporaryPath, stateFile);
        } catch (error) {
            await fsp.unlink(temporaryPath).catch(() => {});
            throw error;
        }
    }

    function change(accountUid, recordId, dismissed) {
        if (!validIdentity(accountUid, recordId)) {
            return Promise.reject(Object.assign(new Error('帐号 UID 或中奖记录 ID 无效'), { statusCode: 400 }));
        }
        const normalizedUid = String(accountUid);
        const normalizedId = String(recordId).toLowerCase();
        const operation = writeQueue.then(async () => {
            const pendingRecords = await readPendingRecords();
            if (!pendingRecords.some(record => (
                record.accountUid === normalizedUid && record.recordId === normalizedId
            ))) {
                throw Object.assign(new Error('待领取中奖记录不存在或已被帐号回复确认'), { statusCode: 404 });
            }
            const ledger = await readLedger();
            const key = keyOf(normalizedUid, normalizedId);
            const withoutRecord = ledger.filter(record => keyOf(record.accountUid, record.recordId) !== key);
            if (dismissed) {
                withoutRecord.push({
                    accountUid: normalizedUid,
                    recordId: normalizedId,
                    dismissedAt: now(),
                    reason: 'manual',
                });
            }
            await writeLedger(withoutRecord);
            return { accountUid: normalizedUid, recordId: normalizedId, status: dismissed ? 'dismissed' : 'pending' };
        });
        writeQueue = operation.catch(() => {});
        return operation;
    }

    return {
        list,
        dismiss: (accountUid, recordId) => change(accountUid, recordId, true),
        restore: (accountUid, recordId) => change(accountUid, recordId, false),
    };
}

module.exports = {
    createWinReminderStore,
    keyOf,
    validIdentity,
};
