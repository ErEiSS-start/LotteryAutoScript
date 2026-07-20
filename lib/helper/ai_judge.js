const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../data/config');
const { log, delay, lottery_info_dir, readLotteryInfoFile } = require('../utils');
const {
    requestAiWithFailover,
    normalizeAiProviders,
    getAiProviderAvailability,
} = require('./ai_client');

const CACHE_VERSION = 1;
const JUDGE_SCHEMA_VERSION = '2026-07-17-v1';
const DAY = 24 * 60 * 60 * 1000;
const JUDGE_JSON_SCHEMA = {
    type: 'json_schema',
    json_schema: {
        name: 'bilibili_lottery_judgment',
        strict: true,
        schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
                is_lottery: { type: 'boolean' },
                is_ended: { type: 'boolean' },
                need_at: { type: 'boolean' },
                need_topic: { type: 'string' },
                draw_time: { type: 'integer' },
                reason: { type: 'string' },
            },
            required: ['is_lottery', 'is_ended', 'need_at', 'need_topic', 'draw_time', 'reason'],
        },
    },
};

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseJsonText(value) {
    const text = String(value || '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

function normalizeTopic(value) {
    const topic = String(value || '').trim();
    if (!topic) return '';
    const matches = topic.match(/#[^#\r\n]+#/g);
    return matches ? [...new Set(matches)].join(' ') : '';
}

function validateJudgment(value) {
    const raw = typeof value === 'string' ? parseJsonText(value) : value;
    if (!raw || typeof raw !== 'object') return null;

    const isLottery = raw.is_lottery ?? raw.has_key_words;
    const isEnded = raw.is_ended ?? false;
    const needAt = raw.need_at ?? raw.needAt;
    const needTopic = raw.need_topic ?? raw.needTopic ?? '';
    let drawTime = Number(raw.draw_time ?? raw.drawtime ?? -1);
    if (drawTime > 1e12) drawTime = Math.floor(drawTime / 1000);

    if (typeof isLottery !== 'boolean'
        || typeof isEnded !== 'boolean'
        || typeof needAt !== 'boolean'
        || !Number.isInteger(drawTime)
        || (drawTime !== -1 && drawTime < 1e9)) {
        return null;
    }

    return {
        is_lottery: isLottery,
        is_ended: isEnded,
        need_at: needAt,
        need_topic: normalizeTopic(needTopic),
        draw_time: drawTime,
        reason: String(raw.reason ?? raw.more ?? '').slice(0, 300),
    };
}

function getJudgeProviders(parm = {}) {
    return normalizeAiProviders(parm, { responseFormat: { type: 'json_object' } })
        .map(provider => ({
            ...provider,
            response_format: provider.response_format
                || (/gemini/i.test(String(provider.name || provider.body?.model || ''))
                    ? JUDGE_JSON_SCHEMA
                    : { type: 'json_object' }),
        }));
}

function getJudgeSignature(parm = config.ai_judge_parm) {
    const providers = new Map();
    getJudgeProviders(parm).forEach(provider => {
        const description = {
            name: provider.base_provider_name || provider.name,
            url: provider.url,
            model: provider.body?.model,
            response_format: provider.response_format,
        };
        providers.set(JSON.stringify(description), description);
    });
    return hash(JSON.stringify({
        schema: JUDGE_SCHEMA_VERSION,
        prompt: parm?.prompt || '',
        providers: [...providers.values()],
    }));
}

function buildJudgePrompt(basePrompt, lotteryInfo, now = Date.now()) {
    const publishedAt = Number(lotteryInfo?.create_time) > 0
        ? new Date(Number(lotteryInfo.create_time) * 1000).toISOString()
        : 'unknown';
    const beijingNow = new Date(now + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
    return `${String(basePrompt || '').trim()}

当前北京时间：${beijingNow}
动态发布时间：${publishedAt}
请只根据动态正文中明确的信息判断，不要因为包含“福利、购买、进群”等词就认定为抽奖。
如果已经公布中奖名单、明确写明活动结束，或明确开奖时间早于当前时间，is_ended=true。
没有明确开奖时间时draw_time=-1；时间戳必须是秒级10位整数。
参与条件要求@好友时need_at=true；需要携带话题时need_topic返回完整#话题#，否则返回空字符串。
只输出JSON对象：{"is_lottery":true,"is_ended":false,"need_at":false,"need_topic":"","draw_time":-1,"reason":"简短依据"}`.trim();
}

class AiJudgeCache {
    constructor({
        filePath = path.join(lottery_info_dir, 'ai_judge_cache.json'),
        now = Date.now,
        flushEvery = 25,
    } = {}) {
        this.filePath = filePath;
        this.now = now;
        this.flushEvery = Math.max(1, Number(flushEvery) || 25);
        this.pendingWrites = 0;
        this.data = { version: CACHE_VERSION, entries: {} };
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed?.version === CACHE_VERSION && parsed.entries && typeof parsed.entries === 'object') {
                this.data = parsed;
            }
        } catch (_) {
            this.data = { version: CACHE_VERSION, entries: {} };
        }
    }

    get(lotteryInfo, signature) {
        const dyid = String(lotteryInfo?.dyid || '');
        const entry = this.data.entries[dyid];
        if (!entry
            || entry.content_hash !== hash(lotteryInfo?.des || '')
            || entry.signature !== signature
            || Number(entry.expires_at) <= this.now()) {
            return null;
        }
        return validateJudgment(entry.result);
    }

    set(lotteryInfo, signature, result, provider) {
        const normalized = validateJudgment(result);
        if (!normalized) return;
        const longLived = !normalized.is_lottery
            || normalized.is_ended
            || normalized.draw_time > 0;
        const ttl = longLived ? 30 * DAY : DAY;
        this.data.entries[String(lotteryInfo.dyid)] = {
            content_hash: hash(lotteryInfo?.des || ''),
            signature,
            result: normalized,
            provider,
            judged_at: this.now(),
            expires_at: this.now() + ttl,
        };
        this.pendingWrites += 1;
        if (this.pendingWrites >= this.flushEvery) this.flush();
    }

    prune() {
        const cutoff = this.now() - 60 * DAY;
        for (const [dyid, entry] of Object.entries(this.data.entries)) {
            if (Number(entry.expires_at) < cutoff) delete this.data.entries[dyid];
        }
    }

    flush() {
        if (!this.pendingWrites && fs.existsSync(this.filePath)) return;
        this.prune();
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const temporary = `${this.filePath}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.data));
        fs.renameSync(temporary, this.filePath);
        this.pendingWrites = 0;
    }
}

let sharedCache;
const failedThisRun = new Set();

function getSharedCache() {
    if (!sharedCache) sharedCache = new AiJudgeCache();
    return sharedCache;
}

function isAiJudgeEnabled() {
    return /^(?:1|true|yes|on)$/i.test(String(process.env.ENABLE_AI_JUDGE || ''));
}

function getFailureKey(lotteryInfo, signature = getJudgeSignature(config.ai_judge_parm || {})) {
    return `${lotteryInfo?.dyid}:${hash(lotteryInfo?.des || '')}:${signature}`;
}

function markFailedThisRun(lotteryInfo, signature) {
    failedThisRun.add(getFailureKey(lotteryInfo, signature));
}

async function judgeLotteryInfo(lotteryInfo, {
    cache = getSharedCache(),
    now = Date.now,
    request = requestAiWithFailover,
} = {}) {
    if (!isAiJudgeEnabled() || lotteryInfo?.hasOfficialLottery) return null;
    const parm = config.ai_judge_parm || {};
    const signature = getJudgeSignature(parm);
    const cached = cache.get(lotteryInfo, signature);
    if (cached) return { result: cached, provider: 'cache', cached: true, attempted: false };

    const failureKey = getFailureKey(lotteryInfo, signature);
    if (failedThisRun.has(failureKey)) {
        return { result: null, failed: true, skippedThisRun: true, attempted: false };
    }

    const providers = getJudgeProviders(parm);
    const response = await request({
        providers,
        prompt: buildJudgePrompt(parm.prompt, lotteryInfo, now()),
        content: String(lotteryInfo?.des || ''),
        validate: validateJudgment,
        purpose: 'AI判断',
        timeout: Math.max(5000, Number(config.ai_request_timeout) || 30000),
        retryCount: Math.max(0, Number(config.ai_judge_provider_retry_count) || 0),
        failureThreshold: Math.max(1, Number(config.ai_circuit_failure_threshold) || 3),
        circuitCooldown: Math.max(60000, Number(config.ai_circuit_cooldown) || 10 * 60 * 1000),
        modelBusyCooldown: Math.max(1000, Number(config.ai_model_busy_cooldown) || 2 * 60 * 1000),
    });
    if (!response) {
        const availability = getAiProviderAvailability(providers, now);
        // 配额/模型繁忙属于暂时性故障。不要把当前候选永久标成失败，
        // 预判器会在最早恢复时间后继续重试同一条。
        if (!availability.allUnavailable) failedThisRun.add(failureKey);
        return {
            result: null,
            failed: true,
            attempted: true,
            stopBatch: availability.allUnavailable,
            retryAfter: availability.nextAvailableAt,
        };
    }

    cache.set(lotteryInfo, signature, response.parsed, response.provider);
    return { result: response.parsed, provider: response.provider, cached: false, attempted: true };
}

async function preJudgeSharedSnapshot(filename = 'lottery_info_1.json', options = {}) {
    if (!isAiJudgeEnabled()) {
        log.info('AI预判', 'ENABLE_AI_JUDGE未开启，跳过固定快照预判');
        return { total: 0, cached: 0, requested: 0, fallback: 0 };
    }

    const items = options.items || await readLotteryInfoFile(filename);
    const unique = new Map();
    items.forEach(item => {
        if (!item?.hasOfficialLottery && item?.dyid && !unique.has(String(item.dyid))) {
            unique.set(String(item.dyid), item);
        }
    });
    const candidates = [...unique.values()];
    const interval = Math.max(0, Number(config.ai_judge_interval) || 3000);
    const cache = options.cache || getSharedCache();
    const judge = options.judge || judgeLotteryInfo;
    const wait = options.wait || delay;
    const now = options.now || Date.now;
    const signature = getJudgeSignature(config.ai_judge_parm || {});
    const stats = { total: candidates.length, cached: 0, requested: 0, fallback: 0 };
    const maxOutageWait = Math.max(
        60000,
        Number(config.ai_prejudge_max_outage_wait) || 30 * 60 * 1000
    );
    let unavailableSince = null;

    log.info('AI预判', `开始串行判断非官方候选(${candidates.length})，实际请求间隔${interval}ms`);
    for (let index = 0; index < candidates.length;) {
        const item = candidates[index];
        const judged = await judge(item, { cache });

        if (judged?.stopBatch) {
            const currentTime = now();
            if (unavailableSince === null) unavailableSince = currentTime;
            const outageElapsed = currentTime - unavailableSince;
            if (outageElapsed < maxOutageWait) {
                const retryAt = Number(judged.retryAfter) || currentTime + 60000;
                const waitTime = Math.max(
                    1000,
                    Math.min(retryAt - currentTime, maxOutageWait - outageElapsed)
                );
                log.warn(
                    'AI预判等待',
                    `全部模型/账号暂时不可用，${Math.ceil(waitTime / 1000)}秒后重试当前候选(${index + 1}/${candidates.length})`
                );
                await wait(waitTime);
                continue;
            }

            let remainingFallback = 0;
            for (const remaining of candidates.slice(index)) {
                if (cache.get(remaining, signature)) stats.cached += 1;
                else {
                    markFailedThisRun(remaining, signature);
                    stats.fallback += 1;
                    remainingFallback += 1;
                }
            }
            if (remainingFallback) {
                log.warn(
                    'AI预判',
                    `持续不可用已达${Math.ceil(maxOutageWait / 60000)}分钟，剩余${remainingFallback}条本次任务使用关键词筛选`
                );
            }
            break;
        }

        unavailableSince = null;
        if (judged?.cached) stats.cached += 1;
        else if (judged?.result) stats.requested += 1;
        else stats.fallback += 1;

        const completed = index + 1;
        if (completed % 25 === 0 || completed === candidates.length) {
            log.info('AI预判', `进度${completed}/${candidates.length}`);
        }

        if (judged?.attempted && index + 1 < candidates.length && interval > 0) await wait(interval);
        index += 1;
    }

    cache.flush();
    log.info(
        'AI预判',
        `完成：总计${stats.total}，缓存${stats.cached}，新请求${stats.requested}，关键词降级${stats.fallback}`
    );
    return stats;
}

function resetAiJudgeState() {
    sharedCache = null;
    failedThisRun.clear();
}

module.exports = {
    AiJudgeCache,
    judgeLotteryInfo,
    preJudgeSharedSnapshot,
    validateJudgment,
    getJudgeSignature,
    buildJudgePrompt,
    _getFailureKey: getFailureKey,
    _markFailedThisRun: markFailedThisRun,
    _resetAiJudgeState: resetAiJudgeState,
};
