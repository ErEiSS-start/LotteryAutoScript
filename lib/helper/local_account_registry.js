const fs = require('fs');
const path = require('path');

const DEFAULT_REGISTRY_FILE = path.join(process.cwd(), 'web_state', 'local-accounts.json');

function cookieUid(cookie) {
    const match = String(cookie || '').match(/(?:^|;\s*)DedeUserID=([^;]+)/);
    const uid = match ? match[1].trim() : '';
    return /^[1-9]\d*$/.test(uid) ? uid : '';
}

function normalizeAccounts(accounts = []) {
    const normalized = [];
    const seen = new Set();
    for (const account of Array.isArray(accounts) ? accounts : []) {
        const uid = cookieUid(account && account.COOKIE);
        const number = Math.max(1, Number(account && account.NUMBER) || 1);
        if (!uid || seen.has(uid)) continue;
        seen.add(uid);
        normalized.push({ uid, number });
    }
    return normalized.sort((left, right) => left.number - right.number || left.uid.localeCompare(right.uid));
}

function writeLocalAccountRegistry(accounts, {
    filePath = process.env.ACCOUNT_REGISTRY_FILE || DEFAULT_REGISTRY_FILE,
    now = () => Date.now(),
} = {}) {
    const normalized = normalizeAccounts(accounts);
    if (!normalized.length) throw new Error('未找到可登记的有效帐号UID');
    const directory = path.dirname(filePath);
    const temporary = `${filePath}.${process.pid}.${now()}.next`;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(temporary, JSON.stringify({
            version: 1,
            updatedAt: now(),
            accounts: normalized,
        }, null, 2), { encoding: 'utf8', mode: 0o644 });
        fs.renameSync(temporary, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
        } catch (_) {
            // 原始错误更有诊断价值。
        }
        throw error;
    }
    return normalized;
}

module.exports = {
    DEFAULT_REGISTRY_FILE,
    cookieUid,
    normalizeAccounts,
    writeLocalAccountRegistry,
};
