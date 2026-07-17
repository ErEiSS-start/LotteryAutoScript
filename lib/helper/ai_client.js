const { send } = require('../net/http');
const { log } = require('../utils');

const providerStates = new Map();
const warnedMissingKeys = new Set();

function getProviderName(provider, index) {
    return String(provider?.name || provider?.body?.model || `provider-${index + 1}`);
}

function getProviderState(name) {
    if (!providerStates.has(name)) {
        providerStates.set(name, {
            consecutiveFailures: 0,
            openUntil: 0,
        });
    }
    return providerStates.get(name);
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

function normalizeAiProviders(parm = {}, { responseFormat = { type: 'text' } } = {}) {
    if (Array.isArray(parm.providers) && parm.providers.length) return parm.providers;
    if (!parm.url) return [];
    return [{
        name: parm.body?.model || 'legacy-ai',
        url: parm.url,
        api_key_env: 'AI_API_KEY',
        body: parm.body || {},
        response_format: responseFormat,
    }];
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
}

function markFailure(state, { failureThreshold, circuitCooldown, now, forceOpen = false }) {
    state.consecutiveFailures += 1;
    if (forceOpen || state.consecutiveFailures >= failureThreshold) {
        state.openUntil = now() + circuitCooldown;
        state.consecutiveFailures = 0;
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
    for (const [index, provider] of providers.entries()) {
        if (!provider?.url) continue;
        const name = getProviderName(provider, index);
        const state = getProviderState(name);
        if (state.openUntil > now()) {
            log.warn(`${purpose}主备`, `${name}熔断中，直接尝试下一供应商`);
            continue;
        }

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
                    if (index > 0) log.warn(`${purpose}主备`, `已使用备用供应商${name}`);
                    return { content: response.content, parsed, provider: name };
                }
            }

            const reason = response?.error || '响应格式校验失败';
            rateLimited = /(?:HTTP状态码:\s*429|rate.?limit|速率限制|请求过于频繁)/i.test(reason);
            log.warn(
                `${purpose}主备`,
                `${name}第${attempt + 1}次失败${attempt < retryCount && !rateLimited ? '，准备重试' : ''}: ${reason}`
            );
            if (rateLimited) break;
        }

        markFailure(state, { failureThreshold, circuitCooldown, now, forceOpen: rateLimited });
        if (state.openUntil > now()) {
            log.warn(`${purpose}主备`, `${name}连续失败，熔断${circuitCooldown / 60000}分钟`);
        }
    }
    return null;
}

function resetAiProviderState() {
    providerStates.clear();
    warnedMissingKeys.clear();
}

module.exports = {
    requestAiWithFailover,
    normalizeAiProviders,
    _resetAiProviderState: resetAiProviderState,
    _parseResponseBody: parseResponseBody,
};
