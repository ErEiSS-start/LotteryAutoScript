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
    if (!validIdentity(accountUid, recordId) || !['pending', 'review'].includes(record.status)) return null;
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
        recordStatus: record.status,
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

function createWinReminderStore({
    lotteryRoot,
    stateFile,
    accountRegistryFile = path.join(lotteryRoot, 'web_state', 'local-accounts.json'),
    now = () => Date.now(),
} = {}) {
    const lotteryInfoDirectory = path.join(lotteryRoot, 'lottery_info');
    let writeQueue = Promise.resolve();
    let lastCompactionAt = 0;

    async function readLedger(strict = false) {
        try {
            const document = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
            if (!document || !Array.isArray(document.records)) throw new Error('账本格式无效');
            return { records: normalizeLedger(document), warning: '', valid: true };
        } catch (error) {
            if (error.code === 'ENOENT') return { records: [], warning: '', valid: true };
            if (strict) {
                throw Object.assign(new Error(`取消提醒账本读取失败：${error.message}`), { statusCode: 500 });
            }
            return {
                records: [],
                warning: `取消提醒账本读取失败，本次按未取消显示：${error.message}`,
                valid: false,
            };
        }
    }

    async function readAccountRegistry() {
        try {
            const document = JSON.parse(await fsp.readFile(accountRegistryFile, 'utf8'));
            if (!document || !Array.isArray(document.accounts)) throw new Error('帐号清单格式无效');
            const uids = new Set(document.accounts
                .map(account => String(account && account.uid || ''))
                .filter(uid => UID_PATTERN.test(uid)));
            if (!uids.size) throw new Error('帐号清单没有有效UID');
            return { uids, warnings: [] };
        } catch (error) {
            const detail = error.code === 'ENOENT' ? '尚未生成' : error.message;
            return {
                uids: null,
                warnings: [`本机帐号清单${detail}，暂时显示全部历史帐号记录`],
            };
        }
    }

    async function readPendingRecords() {
        let entries;
        try {
            entries = await fsp.readdir(lotteryInfoDirectory, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return { records: [], warnings: [], complete: true };
            throw error;
        }
        const files = entries.filter(entry => entry.isFile() && /^pending_wins_(\d+)\.json$/.test(entry.name));
        const groups = await Promise.all(files.map(async entry => {
            const match = entry.name.match(/^pending_wins_(\d+)\.json$/);
            const filePath = path.join(lotteryInfoDirectory, entry.name);
            try {
                const stat = await fsp.lstat(filePath);
                if (!stat.isFile() || stat.isSymbolicLink()) return { records: [], warnings: [], complete: true };
                if (stat.size > MAX_PENDING_FILE_SIZE) {
                    return {
                        records: [],
                        warnings: [`${entry.name} 超过安全读取上限，已跳过`],
                        complete: false,
                    };
                }
                const document = JSON.parse(await fsp.readFile(filePath, 'utf8'));
                if (!document || !Array.isArray(document.records)) {
                    return {
                        records: [],
                        warnings: [`${entry.name} 格式无效，已跳过`],
                        complete: false,
                    };
                }
                return {
                    records: document.records
                        .map(record => normalizePendingRecord(record, document, match[1]))
                        .filter(Boolean),
                    warnings: [],
                    complete: true,
                };
            } catch (error) {
                return {
                    records: [],
                    warnings: [`${entry.name} 读取失败，已保留文件：${error.message}`],
                    complete: false,
                };
            }
        }));
        return {
            records: groups.flatMap(group => group.records).sort((left, right) => (
                right.messageTimestamp - left.messageTimestamp
                || right.detectedAt - left.detectedAt
            )),
            warnings: groups.flatMap(group => group.warnings),
            complete: groups.every(group => group.complete),
        };
    }

    function scheduleLedgerCompaction(pendingRecords, ledgerRecords, complete) {
        const current = now();
        if (!complete || current - lastCompactionAt < 60 * 60 * 1000) return;
        const pendingKeys = new Set(pendingRecords.map(record => keyOf(record.accountUid, record.recordId)));
        if (!ledgerRecords.some(record => !pendingKeys.has(keyOf(record.accountUid, record.recordId)))) {
            lastCompactionAt = current;
            return;
        }
        lastCompactionAt = current;
        const operation = writeQueue.then(async () => {
            const latest = await readLedger(true);
            const compacted = latest.records.filter(record => pendingKeys.has(keyOf(record.accountUid, record.recordId)));
            if (compacted.length !== latest.records.length) await writeLedger(compacted);
        });
        writeQueue = operation.catch(error => console.error('取消提醒账本清理失败', error));
    }

    async function list(status = 'pending') {
        if (!['pending', 'review', 'dismissed', 'all'].includes(status)) {
            throw Object.assign(new Error('status 只能是 pending、review、dismissed 或 all'), { statusCode: 400 });
        }
        const [pendingResult, ledger, registry] = await Promise.all([
            readPendingRecords(),
            readLedger(),
            readAccountRegistry(),
        ]);
        const dismissed = new Map(ledger.records.map(record => [keyOf(record.accountUid, record.recordId), record]));
        const visibleRecords = registry.uids
            ? pendingResult.records.filter(record => registry.uids.has(record.accountUid))
            : pendingResult.records;
        const records = visibleRecords.map(record => {
            const dismissal = dismissed.get(keyOf(record.accountUid, record.recordId));
            return {
                ...record,
                status: dismissal ? 'dismissed' : record.recordStatus,
                sourceStatus: record.recordStatus,
                dismissedAt: dismissal ? dismissal.dismissedAt : 0,
            };
        });
        const result = {
            records: status === 'all' ? records : records.filter(record => record.status === status),
            counts: {
                pending: records.filter(record => record.status === 'pending').length,
                review: records.filter(record => record.status === 'review').length,
                dismissed: records.filter(record => record.status === 'dismissed').length,
            },
            warnings: [...pendingResult.warnings, ...registry.warnings, ...(ledger.warning ? [ledger.warning] : [])],
        };
        if (ledger.valid) scheduleLedgerCompaction(pendingResult.records, ledger.records, pendingResult.complete);
        return result;
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
            const [pendingResult, registry] = await Promise.all([readPendingRecords(), readAccountRegistry()]);
            if (registry.uids && !registry.uids.has(normalizedUid)) {
                throw Object.assign(new Error('该帐号不属于当前服务器'), { statusCode: 404 });
            }
            if (!pendingResult.records.some(record => (
                record.accountUid === normalizedUid && record.recordId === normalizedId
            ))) {
                throw Object.assign(new Error('待领取中奖记录不存在或已被帐号回复确认'), { statusCode: 404 });
            }
            const ledger = await readLedger(true);
            const key = keyOf(normalizedUid, normalizedId);
            const withoutRecord = ledger.records.filter(record => keyOf(record.accountUid, record.recordId) !== key);
            if (dismissed) {
                withoutRecord.push({
                    accountUid: normalizedUid,
                    recordId: normalizedId,
                    dismissedAt: now(),
                    reason: 'manual',
                });
            }
            await writeLedger(withoutRecord);
            const sourceRecord = pendingResult.records.find(record => (
                record.accountUid === normalizedUid && record.recordId === normalizedId
            ));
            return {
                accountUid: normalizedUid,
                recordId: normalizedId,
                status: dismissed ? 'dismissed' : sourceRecord.recordStatus,
            };
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
