'use strict';

const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const path = require('path');

const UID_PATTERN = /^\d+$/;
const POSITIVE_TTL = 30 * 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 6 * 60 * 60 * 1000;
const MAX_RESPONSE_SIZE = 256 * 1024;

function fetchProfileName(uid, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const request = https.get({
            hostname: 'api.bilibili.com',
            path: `/x/web-interface/card?mid=${encodeURIComponent(uid)}`,
            headers: {
                Accept: 'application/json',
                'User-Agent': 'Mozilla/5.0 LotteryAutoScript/2.11',
            },
        }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_RESPONSE_SIZE) request.destroy(new Error('响应内容过大'));
                else chunks.push(chunk);
            });
            response.on('end', () => {
                try {
                    const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    const name = document && document.code === 0
                        && document.data && document.data.card
                        ? String(document.data.card.name || '').trim()
                        : '';
                    resolve(name);
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('查询昵称超时')));
        request.on('error', reject);
    });
}

function createProfileResolver({
    cacheFile,
    now = () => Date.now(),
    fetchName = fetchProfileName,
    logger = console,
} = {}) {
    let loaded = false;
    let cache = {};
    let writeQueue = Promise.resolve();
    const inFlight = new Map();

    async function load() {
        if (loaded) return;
        loaded = true;
        try {
            const document = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
            cache = document && document.profiles && typeof document.profiles === 'object'
                ? document.profiles
                : {};
        } catch (error) {
            if (error.code !== 'ENOENT') {
                cache = {};
                if (logger && typeof logger.warn === 'function') {
                    logger.warn(`昵称缓存读取失败，将在后台重新建立: ${error.message}`);
                }
            }
        }
    }

    function save() {
        const snapshot = JSON.parse(JSON.stringify(cache));
        const operation = writeQueue.then(async () => {
            const directory = path.dirname(cacheFile);
            const temporary = `${cacheFile}.${process.pid}.${now()}.${Math.random().toString(16).slice(2)}.next`;
            await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
            try {
                await fsp.writeFile(temporary, JSON.stringify({
                    version: 1,
                    updatedAt: now(),
                    profiles: snapshot,
                }, null, 2), { encoding: 'utf8', mode: 0o600 });
                await fsp.rename(temporary, cacheFile);
            } catch (error) {
                await fsp.unlink(temporary).catch(() => {});
                throw error;
            }
        });
        writeQueue = operation.catch(() => {});
        return operation;
    }

    async function resolveUid(uid) {
        const current = now();
        const cached = cache[uid];
        const ttl = cached && cached.name ? POSITIVE_TTL : NEGATIVE_TTL;
        if (cached && current - Number(cached.updatedAt || 0) < ttl) return cached.name || '';
        if (inFlight.has(uid)) return inFlight.get(uid);
        const operation = Promise.resolve(fetchName(uid)).then(name => {
            cache[uid] = { name: String(name || '').trim(), updatedAt: now() };
            return cache[uid].name;
        }).catch(() => {
            cache[uid] = { name: '', updatedAt: now() };
            return '';
        }).finally(() => inFlight.delete(uid));
        inFlight.set(uid, operation);
        return operation;
    }

    function normalizeUids(values) {
        return [...new Set((Array.isArray(values) ? values : [])
            .map(value => String(value || ''))
            .filter(value => UID_PATTERN.test(value)))].slice(0, 100);
    }

    async function cachedMany(values) {
        await load();
        const result = {};
        for (const uid of normalizeUids(values)) {
            if (cache[uid] && cache[uid].name) result[uid] = cache[uid].name;
        }
        return result;
    }

    async function refreshMany(values, { limit = 8, concurrency = 4 } = {}) {
        await load();
        const current = now();
        const uids = normalizeUids(values).filter(uid => {
            const cached = cache[uid];
            const ttl = cached && cached.name ? POSITIVE_TTL : NEGATIVE_TTL;
            return !cached || current - Number(cached.updatedAt || 0) >= ttl;
        }).slice(0, Math.max(0, Number(limit) || 0));
        const before = JSON.stringify(cache);
        const result = {};
        const groupSize = Math.max(1, Math.min(8, Number(concurrency) || 4));
        for (let index = 0; index < uids.length; index += groupSize) {
            const group = uids.slice(index, index + groupSize);
            const names = await Promise.all(group.map(resolveUid));
            group.forEach((uid, nameIndex) => { result[uid] = names[nameIndex]; });
        }
        if (JSON.stringify(cache) !== before) await save().catch(() => {});
        return result;
    }

    async function resolveMany(values) {
        await refreshMany(values, { limit: 100, concurrency: 4 });
        return cachedMany(values);
    }

    return { cachedMany, refreshMany, resolveMany };
}

module.exports = {
    createProfileResolver,
    fetchProfileName,
};
