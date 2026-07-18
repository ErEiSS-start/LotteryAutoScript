const { send } = require('../net/http');
const { log } = require('../utils');

const providerStates = new Map();
const providerPoolCursors = new Map();
const warnedMissingKeys = new Set();

function getProviderName(provider, index) {
    return String(provider?.name || provider?.body?.model || `provider-${index + 1}`);
}

function getProviderState(provider, index) {
    const key = String(provider?.state_key || getProviderName(provider, index));
    if (!providerStates.has(key)) {
        providerStates.set(key, {
            consecutiveFailures: 0,
            openUntil: 0,
            openWarningLogged: false,
        });
    }
    return providerStates.get(key);
}

function getApiKey(provider) {
    const envName = String(provider?.api_key_env || 'AI_API_KEY');
    const direct = process.env[envName];
    if (direct) return direct;
    if (envName === 'ZHIPU_API_KEY') return process.env.AI_API_KEY || '';
    return '';
}

function parseResponseBody(body) {
    try {
        const data = JSON.parse(String(body || ''));
        const content = data?.choices?.[0]?.message?.content;
        return typeof content === 'string' ? content.trim() : '';
    } catch (_) {
        return '';
    }
}

function getNumberedZhipuCredentials(env = process.env) {
    const seenKeys = new Set();
    return Object.keys(env)
        .map(name => {
            const match = name.match(/^ZHIPU_API_KEY_(\d+)$/);
            return match ? { name, number: Number(match[1]), key: String(env[name] || '').trim() } : null;
        })
        .filter(item => item && Number.isSafeInteger(item.number) && item.number > 0 && item.key)
        .sort((left, right) => left.number - right.number)
        .filter(item => {
            if (seenKeys.has(item.key)) return false;
            seenKeys.add(item.key);
            return true;
        });
}

function expandProviderCredentials(provider, env = process.env) {
    if (String(provider?.api_key_env || '') !== 'ZHIPU_API_KEY') return [provider];
    const credentials = getNumberedZhipuCredentials(env);
    if (!credentials.length) return [provider];

    const baseName = String(provider?.name || provider?.body?.model || 'glm-4.7-flash');
    const poolKey = [provider?.url || '', provider?.body?.model || baseName, 'zhipu-numbered'].join('|');
    return credentials.map(({ name, number }, poolIndex) => ({
        ...provider,
        name: `${baseName}(智谱账号${number})`,
        base_provider_name: baseName,
        api_key_env: name,
        state_key: `${poolKey}|${name}`,
        credential_pool_key: poolKey,
        credential_pool_index: poolIndex,
    }));
}

function normalizeAiProviders(parm = {}, { responseFormat = { type: 'text' } } = {}) {
    const providers = Array.isArray(parm.providers) && parm.providers.length
        ? parm.providers
        : parm.url ? [{
        name: parm.body?.model || 'legacy-ai',
        url: parm.url,
        api_key_env: 'AI_API_KEY',
        body: parm.body || {},
        response_format: responseFormat,
    }] : [];
    return providers.flatMap(provider => expandProviderCredentials(provider));
}

function orderProvidersForRequest(providers) {
    const poolKey = providers[0]?.credential_pool_key;
    if (!poolKey
        || providers.length < 2
        || providers.some(provider => provider.credential_pool_key !== poolKey)) {
        return { entries: providers.map((provider, index) => ({ provider, originalIndex: index })), poolKey: '' };
    }

    const start = Number(providerPoolCursors.get(poolKey) || 0) % providers.length;
    return {
        poolKey,
        start,
        entries: Array.from({ length: providers.length }, (_, offset) => {
            const originalIndex = (start + offset) % providers.length;
            return { provider: providers[originalIndex], originalIndex };
        }),
    };
}

function advanceProviderPool(poolKey, nextIndex, providerCount) {
    if (!poolKey || providerCount < 1) return;
    providerPoolCursors.set(poolKey, Number(nextIndex) % providerCount);
}

function getAiProviderAvailability(providers = [], now = Date.now) {
    let configured = 0;
    let available = 0;
    providers.forEach((provider, index) => {
        if (!provider?.url || !getApiKey(provider)) return;
        configured += 1;
        if (getProviderState(provider, index).openUntil <= now()) available += 1;
    });
    return {
        configured,
        available,
        allUnavailable: configured === 0 || available === 0,
    };
}

function requestProvider(provider, { prompt, content, timeout }) {
    return new Promise(resolve => {
        const apiKey = getApiKey(provider);
        if (!apiKey) {
            resolve({ ok: false, error: `缺少${provider.api_key_env || 'AI_API_KEY'}` });
            return;
        }

        const body = {
            ...(provider.body || {}),
            stream: false,
            messages: [
                { role: 'system', content: prompt },
                { role: 'user', content },
            ],
        };
        if (provider.response_format) body.response_format = provider.response_format;

        send({
            method: 'POST',
            url: provider.url,
            headers: {
                authorization: `Bearer ${apiKey}`,
                'content-type': 'application/json',
            },
            config: {
                timeout,
                retry: false,
                retry_times: 0,
            },
            contents: body,
            success: response => {
                const responseContent = parseResponseBody(response.body);
                resolve(responseContent
                    ? { ok: true, content: responseContent }
                    : { ok: false, error: '响应中没有有效文本' });
            },
            failure: error => resolve({ ok: false, error: String(error || '请求失败') }),
        });
    });
}

function markSuccess(state) {
    state.consecutiveFailures = 0;
    state.openUntil = 0;
    state.openWarningLogged = false;
}

function markFailure(state, { failureThreshold, circuitCooldown, now, forceOpen = false }) {
    state.consecutiveFailures += 1;
    if (forceOpen || state.consecutiveFailures >= failureThreshold) {
        state.openUntil = now() + circuitCooldown;
        state.consecutiveFailures = 0;
        state.openWarningLogged = false;
    }
}

/**
 * 按顺序调用OpenAI兼容供应商，并在技术失败或无效响应时自动切换。
 * @param {object} options
 * @param {object[]} options.providers
 * @param {string} options.prompt
 * @param {string} options.content
 * @param {(content:string)=>any} [options.validate]
 * @param {string} [options.purpose]
 * @param {number} [options.timeout]
 * @param {number} [options.retryCount]
 * @param {number} [options.failureThreshold]
 * @param {number} [options.circuitCooldown]
 * @param {(provider:object, request:object)=>Promise<object>} [options.transport]
 * @param {()=>number} [options.now]
 * @returns {Promise<{content:string, parsed:any, provider:string}|null>}
 */
async function requestAiWithFailover({
    providers = [],
    prompt = '',
    content = '',
    validate = value => value,
    purpose = 'AI',
    timeout = 30 * 1000,
    retryCount = 1,
    failureThreshold = 3,
    circuitCooldown = 10 * 60 * 1000,
    transport = requestProvider,
    now = Date.now,
} = {}) {
    const ordered = orderProvidersForRequest(providers);
    for (const { provider, originalIndex: index } of ordered.entries) {
        if (!provider?.url) continue;
        const name = getProviderName(provider, index);
        const state = getProviderState(provider, index);
        if (state.openUntil > now()) {
            if (!state.openWarningLogged) {
                log.warn(`${purpose}主备`, `${name}熔断中，直接尝试下一智谱账号`);
                state.openWarningLogged = true;
            }
            continue;
        }
        state.openWarningLogged = false;

        if (!getApiKey(provider)) {
            const warningKey = `${purpose}:${name}:${provider.api_key_env || 'AI_API_KEY'}`;
            if (!warnedMissingKeys.has(warningKey)) {
                warnedMissingKeys.add(warningKey);
                log.warn(`${purpose}主备`, `${name}缺少${provider.api_key_env || 'AI_API_KEY'}，已跳过`);
            }
            continue;
        }

        let rateLimited = false;
        for (let attempt = 0; attempt <= retryCount; attempt++) {
            const response = await transport(provider, { prompt, content, timeout });
            if (response?.ok && response.content) {
                let parsed = null;
                try {
                    parsed = validate(response.content);
                } catch (_) {
                    parsed = null;
                }
                if (parsed) {
                    markSuccess(state);
                    advanceProviderPool(ordered.poolKey, index + 1, providers.length);
                    return { content: response.content, parsed, provider: name };
                }
            }

            const reason = response?.error || '响应格式校验失败';
            rateLimited = /(?:HTTP状态码:\s*429|\b1302\b|rate.?limit|速率限制|请求过于频繁)/i.test(reason);
            log.warn(
                `${purpose}主备`,
                `${name}第${attempt + 1}次失败${attempt < retryCount && !rateLimited ? '，准备重试' : ''}: ${reason}`
            );
            if (rateLimited) break;
        }

        markFailure(state, { failureThreshold, circuitCooldown, now, forceOpen: rateLimited });
        if (state.openUntil > now()) {
            log.warn(`${purpose}主备`, `${name}连续失败，熔断${circuitCooldown / 60000}分钟`);
            state.openWarningLogged = true;
        }
    }
    advanceProviderPool(ordered.poolKey, (ordered.start || 0) + 1, providers.length);
    return null;
}

function resetAiProviderState() {
    providerStates.clear();
    providerPoolCursors.clear();
    warnedMissingKeys.clear();
}

module.exports = {
    requestAiWithFailover,
    normalizeAiProviders,
    getNumberedZhipuCredentials,
    getAiProviderAvailability,
    _expandProviderCredentials: expandProviderCredentials,
    _orderProvidersForRequest: orderProvidersForRequest,
    _resetAiProviderState: resetAiProviderState,
    _parseResponseBody: parseResponseBody,
};
