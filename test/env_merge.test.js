const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildRayCookieAccounts,
    getCookieUid,
    isValidBiliCookie,
    mergeEnvValues,
} = require('../lib/data/env');
const {
    normalizeAccounts,
    writeLocalAccountRegistry,
} = require('../lib/helper/local_account_registry');

assert.deepStrictEqual(
    mergeEnvValues(
        {
            PUSH_PLUS_TOKEN: 'qinglong-token',
            COOKIE: 'qinglong-cookie',
            EMPTY: '',
        },
        {
            PUSH_PLUS_TOKEN: '',
            COOKIE: 'local-cookie',
            EMPTY: '',
            ENABLE_AI_JUDGE: false,
        }
    ),
    {
        PUSH_PLUS_TOKEN: 'qinglong-token',
        COOKIE: 'local-cookie',
        EMPTY: '',
        ENABLE_AI_JUDGE: false,
    }
);

function cookie(uid, suffix = '') {
    return `SESSDATA=session-${uid}${suffix}; bili_jct=csrf-${uid}; DedeUserID=${uid};`;
}

assert.strictEqual(getCookieUid(cookie('10001')), '10001');
assert.strictEqual(isValidBiliCookie(cookie('10001')), true);
assert.strictEqual(isValidBiliCookie('SESSDATA=only-one-field'), false);
assert.strictEqual(isValidBiliCookie(cookie('not-a-uid')), false);

const imported = buildRayCookieAccounts(
    {
        Ray_BiliBiliCookies__7: cookie('10008'),
        Ray_BiliBiliCookies__0: cookie('10001'),
        Ray_BiliBiliCookies__2: cookie('10003'),
        Ray_BiliBiliCookies__3: '',
        Ray_BiliBiliCookies__4: cookie('10003', '-duplicate'),
        Ray_BiliBiliCookies__bad: cookie('99999'),
        UNRELATED: cookie('88888'),
    },
    [
        { NUMBER: 1, WAIT: 120000, ACCOUNT_UA: 'default-UA', COOKIE: 'ignored-1' },
        { NUMBER: 3, WAIT: 300000, ACCOUNT_UA: 'account-3-UA', COOKIE: 'ignored-3' },
    ]
);

assert.deepStrictEqual(
    imported.accounts.map(account => ({
        NUMBER: account.NUMBER,
        WAIT: account.WAIT,
        ACCOUNT_UA: account.ACCOUNT_UA,
        UID: getCookieUid(account.COOKIE),
    })),
    [
        { NUMBER: 1, WAIT: 120000, ACCOUNT_UA: 'default-UA', UID: '10001' },
        { NUMBER: 3, WAIT: 300000, ACCOUNT_UA: 'account-3-UA', UID: '10003' },
        { NUMBER: 8, WAIT: 120000, ACCOUNT_UA: 'default-UA', UID: '10008' },
    ]
);
assert.deepStrictEqual(imported.summary.importedVariables, [
    'Ray_BiliBiliCookies__0',
    'Ray_BiliBiliCookies__2',
    'Ray_BiliBiliCookies__7',
]);
assert.deepStrictEqual(imported.summary.invalidVariables, ['Ray_BiliBiliCookies__3']);
assert.deepStrictEqual(imported.summary.duplicateVariables, ['Ray_BiliBiliCookies__4']);
assert.deepStrictEqual(imported.summary.accountNumbers, [1, 3, 8]);

assert.deepStrictEqual(normalizeAccounts(imported.accounts), [
    { uid: '10001', number: 1 },
    { uid: '10003', number: 3 },
    { uid: '10008', number: 8 },
]);
const registryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'lottery-accounts-'));
const registryFile = path.join(registryDirectory, 'local-accounts.json');
writeLocalAccountRegistry(imported.accounts, { filePath: registryFile, now: () => 1234 });
const registryText = fs.readFileSync(registryFile, 'utf8');
const registry = JSON.parse(registryText);
assert.strictEqual(registry.updatedAt, 1234);
assert.deepStrictEqual(registry.accounts, [
    { uid: '10001', number: 1 },
    { uid: '10003', number: 3 },
    { uid: '10008', number: 8 },
]);
assert.strictEqual(registryText.includes('SESSDATA'), false, '本机帐号清单不得保存Cookie');
assert.throws(
    () => writeLocalAccountRegistry([], { filePath: registryFile, now: () => 5678 }),
    /未找到可登记的有效帐号UID/
);
assert.strictEqual(fs.readFileSync(registryFile, 'utf8'), registryText, '帐号配置异常时应保留上一份有效清单');
fs.rmSync(registryDirectory, { recursive: true, force: true });
