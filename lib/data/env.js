const { env_file } = require('../utils');

const RAY_COOKIE_PATTERN = /^Ray_BiliBiliCookies__(\d+)$/;

function mergeEnvValues(current = {}, incoming = {}) {
    const merged = { ...current };
    for (const [key, value] of Object.entries(incoming)) {
        const incomingIsEmpty = value === '' || value === null || value === undefined;
        const currentHasValue = merged[key] !== '' && merged[key] !== null && merged[key] !== undefined;
        if (incomingIsEmpty && currentHasValue) continue;
        merged[key] = value;
    }
    return merged;
}

function getCookieUid(cookie) {
    const match = String(cookie || '').match(/(?:^|;\s*)DedeUserID=([^;]+)/);
    return match ? match[1].trim() : '';
}

function isValidBiliCookie(cookie) {
    const text = String(cookie || '').trim();
    const uid = getCookieUid(text);
    return Boolean(
        text
        && /(?:^|;\s*)SESSDATA=[^;]+/.test(text)
        && /(?:^|;\s*)bili_jct=[^;]+/.test(text)
        && /^[1-9]\d*$/.test(uid)
    );
}

function buildRayCookieAccounts(processEnv = {}, templates = []) {
    const accountTemplates = Array.isArray(templates) ? templates : [];
    const defaultTemplate = accountTemplates[0] || {};
    const templateByNumber = new Map(
        accountTemplates.map(template => [Number(template?.NUMBER), template])
    );
    const candidates = Object.entries(processEnv)
        .map(([name, value]) => {
            const match = name.match(RAY_COOKIE_PATTERN);
            return match ? { name, suffix: Number(match[1]), cookie: String(value || '').trim() } : null;
        })
        .filter(Boolean)
        .filter(candidate => Number.isSafeInteger(candidate.suffix) && candidate.suffix >= 0)
        .sort((left, right) => left.suffix - right.suffix);
    const accounts = [];
    const importedVariables = [];
    const invalidVariables = [];
    const duplicateVariables = [];
    const seenUids = new Set();

    for (const candidate of candidates) {
        if (!isValidBiliCookie(candidate.cookie)) {
            invalidVariables.push(candidate.name);
            continue;
        }
        const uid = getCookieUid(candidate.cookie);
        if (seenUids.has(uid)) {
            duplicateVariables.push(candidate.name);
            continue;
        }
        seenUids.add(uid);
        const number = candidate.suffix + 1;
        const template = templateByNumber.get(number) || defaultTemplate;
        accounts.push({
            ...template,
            COOKIE: candidate.cookie,
            NUMBER: number,
        });
        importedVariables.push(candidate.name);
    }

    return {
        accounts,
        summary: {
            enabled: true,
            importedVariables,
            invalidVariables,
            duplicateVariables,
            accountNumbers: accounts.map(account => Number(account.NUMBER)),
        },
    };
}

const env = {
    accountImportSummary: { enabled: false },
    /**
     * 原始环境
     * @returns {Object}
     */
    raw_env() {
        delete require.cache[env_file];
        return require(env_file);
    },
    init() {
        const raw_env = this.raw_env();
        this.setEnv({
            ...raw_env['account_parm'],
            ...raw_env['push_parm'],
            ...raw_env['ai_parm']
        });
    },
    /**
     * @returns {Object[]}
     */
    get_multiple_account() {
        const rawEnv = this.raw_env();
        if (!rawEnv['AUTO_IMPORT_RAY_BILIBILI_COOKIES']) {
            this.accountImportSummary = { enabled: false };
            return rawEnv['multiple_account_parm'];
        }
        const result = buildRayCookieAccounts(
            process.env,
            rawEnv['multiple_account_parm']
        );
        this.accountImportSummary = result.summary;
        return result.accounts;
    },
    get_account_import_summary() {
        return this.accountImportSummary;
    },
    setEnv(o) {
        process.env = mergeEnvValues(process.env, o);
    }
};


module.exports = env;
module.exports.buildRayCookieAccounts = buildRayCookieAccounts;
module.exports.getCookieUid = getCookieUid;
module.exports.isValidBiliCookie = isValidBiliCookie;
module.exports.mergeEnvValues = mergeEnvValues;
