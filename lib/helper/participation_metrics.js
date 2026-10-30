const fs = require('fs');
const path = require('path');
const result = require('./task_result');
let sequence = 0;
let broken = false;
const candidateCache = new Map();
const enabled = () => process.env.TASK_GUARD_TASK_KEY === 'start' && Boolean(process.env.TASK_METRICS_FILE);
function emit(type, data = {}, identity = {}) {
    if (!enabled() || broken) return;
    try {
        const match = /(?:^|;\s*)DedeUserID=(\d+)/.exec(process.env.COOKIE || '');
        const event = { version: 1, event_id: `${process.env.TASK_GUARD_RUN_ID}:${++sequence}`,
            run_id: process.env.TASK_GUARD_RUN_ID, server: process.env.TASK_METRICS_SERVER,
            at: Date.now() / 1000, type, uid: identity.uid || (match ? match[1] : ''),
            number: Number(identity.number || process.env.NUMBER) || null, data };
        const filename = process.env.TASK_METRICS_FILE;
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        const fd = fs.openSync(filename, 'a', 0o600);
        try {
            const line = JSON.stringify(event) + '\n';
            if (fs.writeSync(fd, line) !== Buffer.byteLength(line)) throw new Error('short telemetry write');
            fs.fsyncSync(fd);
        }
        finally { fs.closeSync(fd); }
    } catch (_) {
        broken = true;
        try { result.warning('METRICS_INCOMPLETE'); } catch (_) { /* Business execution continues. */ }
        console.warn('[参与量统计] 写入异常，统计不完整；不改变业务执行策略');
    }
}
function candidates(items, queue, resumed) {
    if (!enabled() || broken) return;
    try {
        const ids = [...new Set(items.map(i => String(i.dyid)).filter(id => /^\d+$/.test(id)))];
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
        const uid = /(?:^|;\s*)DedeUserID=(\d+)/.exec(process.env.COOKIE || '');
        const account = uid ? uid[1] : String(process.env.NUMBER);
        const key = day + ':' + queue;
        let cache = candidateCache.get(account);
        if (!cache || cache.key !== key) {
            cache = { key, ids: new Set() };
            candidateCache.set(account, cache);
        }
        const added = ids.filter(id => !cache.ids.has(id));
        for (const id of added) cache.ids.add(id);
        for (let i = 0; i < added.length; i += 500) emit('candidates', { ids: added.slice(i, i + 500), queue, resumed });
        emit('queue', { remaining: ids.length, queue, resumed });
    } catch (_) {
        broken = true;
        try { result.warning('METRICS_INCOMPLETE'); } catch (_) { /* Business execution continues. */ }
        console.warn('[参与量统计] 候选统计不完整；业务执行继续');
    }
}
module.exports = { emit, candidates };
