'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    createLoginLimiter,
    createLogServer,
    createSessionValue,
    validSessionValue,
} = require('../server');

let sessionCookie = '';

async function request(baseUrl, pathname, authenticated = true, options = {}) {
    return fetch(`${baseUrl}${pathname}`, {
        ...options,
        headers: {
            ...(authenticated && sessionCookie ? { Cookie: sessionCookie } : {}),
            ...(options.headers || {}),
        },
    });
}

function winAction(baseUrl, action, body, actionHeader = true) {
    return request(baseUrl, `/api/wins/${action}`, true, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(actionHeader ? { 'X-QLV-Action': '1' } : {}),
        },
        body: JSON.stringify(body),
    });
}

(async () => {
    const fixedSession = createSessionValue('secret', 2000, () => Buffer.alloc(18, 1));
    assert.strictEqual(validSessionValue(fixedSession, 'secret', 1000), true);
    assert.strictEqual(validSessionValue(fixedSession, 'secret', 2001), false);
    assert.strictEqual(validSessionValue(`${fixedSession}x`, 'secret', 1000), false);
    let limiterNow = 1000;
    const limiter = createLoginLimiter({ now: () => limiterNow, maxFailures: 2, blockMs: 5000 });
    assert.strictEqual(limiter.allowed('client'), true);
    limiter.fail('client');
    limiter.fail('client');
    assert.strictEqual(limiter.allowed('client'), false);
    limiterNow += 5001;
    assert.strictEqual(limiter.allowed('client'), true);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-log-viewer-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-log-outside-'));
    const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-log-proc-'));
    const lotteryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-lottery-'));
    const lotteryInfo = path.join(lotteryRoot, 'lottery_info');
    const winStateFile = path.join(lotteryRoot, 'web_state', 'dismissed-wins.json');
    fs.mkdirSync(lotteryInfo);
    const winRecord = {
        id: '0123456789abcdef01234567',
        accountUid: '1090063081',
        accountNumber: 1,
        talkerId: '12076317',
        senderUid: '12076317',
        messageSequence: '9001',
        messageTimestamp: 1722470400,
        content: '【有奖调研】请填写问卷，后续发放奖品。完整私信正文。',
        link: 'https://message.bilibili.com/#/whisper/mid12076317',
        status: 'pending',
        detectedAt: 1785540000000,
        lastNotifiedAt: 1785541800000,
        notifyCount: 5,
    };
    fs.writeFileSync(path.join(lotteryInfo, 'pending_wins_1090063081.json'), JSON.stringify({
        version: 1,
        accountUid: '1090063081',
        accountNumber: 1,
        records: [winRecord],
    }));
    fs.mkdirSync(path.join(root, 'task'));
    fs.writeFileSync(
        path.join(root, 'task', 'large.log'),
        `${'普通日志\n'.repeat(5000)}[Warn] 412 风控\n最后一行\n`,
    );
    fs.writeFileSync(path.join(outside, 'secret.log'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.log'), path.join(root, 'escape.log'));

    const startDirectory = path.join(root, 'LotteryAutoScript_start');
    const checkDirectory = path.join(root, 'LotteryAutoScript_check');
    fs.mkdirSync(startDirectory);
    fs.mkdirSync(checkDirectory);
    ['old.log', 'current-a.log', 'current-b.log'].forEach((name, index) => {
        const filename = path.join(startDirectory, name);
        fs.writeFileSync(filename, name);
        fs.utimesSync(filename, 1000 + index, 1000 + index);
    });
    fs.writeFileSync(path.join(checkDirectory, 'current.log'), 'checking');

    function addProcess(pid, task) {
        const processDirectory = path.join(procRoot, String(pid));
        fs.mkdirSync(processDirectory);
        fs.writeFileSync(
            path.join(processDirectory, 'cmdline'),
            Buffer.from(`bash\0/usr/local/bin/task\0${task}.sh\0`),
        );
    }
    addProcess(41001, 'LotteryAutoScript_start');
    addProcess(41002, 'LotteryAutoScript_start');
    addProcess(41003, 'LotteryAutoScript_check');

    const server = createLogServer({
        logRoot: root,
        token: 'test-token',
        procRoot,
        runtimeCacheMs: 0,
        lotteryRoot,
        winStateFile,
        viewerInstance: '测试服务器',
        peerViewerUrl: 'https://peer.example/log-viewer/',
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    let response = await request(baseUrl, '/api/list', false);
    assert.strictEqual(response.status, 401);

    response = await request(baseUrl, '/', false);
    assert.strictEqual(response.status, 200);
    assert.match(await response.text(), /登录日志查看器/);

    response = await request(baseUrl, '/api/list', false, {
        headers: { Authorization: `Basic ${Buffer.from('logs:test-token').toString('base64')}` },
    });
    assert.strictEqual(response.status, 401, '旧 Basic Auth 不应绕过新登录页');

    response = await request(baseUrl, '/api/login', false, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'logs', password: 'wrong-token' }),
    });
    assert.strictEqual(response.status, 401);

    response = await request(baseUrl, '/api/login', false, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'logs', password: 'test-token' }),
    });
    assert.strictEqual(response.status, 200);
    const setCookie = response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/log-viewer/);
    assert.match(setCookie, /Path=\/log-viewer-2/);
    sessionCookie = `qlv_session=${setCookie.match(/qlv_session=([^;]+)/)[1]}`;

    response = await request(baseUrl, '/api/list');
    let payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.ok(payload.entries.some(entry => entry.name === 'task'));
    assert.strictEqual(payload.entries.find(entry => entry.name === 'LotteryAutoScript_start').running, true);
    assert.strictEqual(payload.entries.find(entry => entry.name === 'LotteryAutoScript_check').running, true);

    response = await request(baseUrl, '/api/list?path=LotteryAutoScript_start');
    payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(
        payload.entries.filter(entry => entry.running).map(entry => entry.name),
        ['current-b.log', 'current-a.log'],
    );

    fs.rmSync(path.join(procRoot, '41001'), { recursive: true, force: true });
    fs.rmSync(path.join(procRoot, '41002'), { recursive: true, force: true });
    response = await request(baseUrl, '/api/list');
    payload = await response.json();
    assert.strictEqual(payload.entries.find(entry => entry.name === 'LotteryAutoScript_start').running, false);
    assert.strictEqual(payload.entries.find(entry => entry.name === 'LotteryAutoScript_check').running, true);

    response = await request(baseUrl, '/api/chunk?path=task%2Flarge.log&limit=16384');
    payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.ok(payload.start > 0);
    assert.ok(payload.text.includes('最后一行'));
    assert.ok(Buffer.byteLength(payload.text) < fs.statSync(path.join(root, 'task', 'large.log')).size);

    response = await request(baseUrl, '/api/search?path=task%2Flarge.log&q=412');
    payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.matches.length, 1);
    assert.match(payload.matches[0].text, /风控/);

    response = await request(baseUrl, '/api/search?path=task%2Flarge.log&q=%E6%99%AE%E9%80%9A%E6%97%A5%E5%BF%97&limit=10');
    payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.matches.length, 10);
    assert.strictEqual(payload.limited, true);

    response = await request(baseUrl, '/api/wins?status=pending');
    payload = await response.json();
    assert.strictEqual(response.status, 200);
    assert.strictEqual(payload.instance, '测试服务器');
    assert.strictEqual(payload.peerViewerUrl, 'https://peer.example/log-viewer/');
    assert.strictEqual(payload.counts.pending, 1);
    assert.strictEqual(payload.records[0].content, winRecord.content, '登录后应返回完整私信正文');

    response = await winAction(baseUrl, 'dismiss', {
        accountUid: winRecord.accountUid,
        recordId: winRecord.id,
    }, false);
    assert.strictEqual(response.status, 403, '写操作必须带显式操作标头');

    response = await winAction(baseUrl, 'dismiss', {
        accountUid: winRecord.accountUid,
        recordId: winRecord.id,
    });
    assert.strictEqual(response.status, 200);
    const ledger = JSON.parse(fs.readFileSync(winStateFile, 'utf8'));
    assert.strictEqual(ledger.records.length, 1);
    assert.strictEqual(ledger.records[0].accountUid, winRecord.accountUid);

    response = await request(baseUrl, '/api/wins?status=pending');
    payload = await response.json();
    assert.strictEqual(payload.counts.pending, 0);
    assert.strictEqual(payload.counts.dismissed, 1);
    assert.strictEqual(payload.records.length, 0);

    response = await request(baseUrl, '/api/wins?status=dismissed');
    payload = await response.json();
    assert.strictEqual(payload.records[0].status, 'dismissed');

    response = await winAction(baseUrl, 'restore', {
        accountUid: winRecord.accountUid,
        recordId: winRecord.id,
    });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(winStateFile, 'utf8')).records, []);

    response = await winAction(baseUrl, 'dismiss', {
        accountUid: '../../etc',
        recordId: winRecord.id,
    });
    assert.strictEqual(response.status, 400);

    response = await request(baseUrl, '/api/meta?path=..%2Fsecret.log');
    assert.strictEqual(response.status, 403);

    response = await request(baseUrl, '/api/meta?path=escape.log');
    assert.strictEqual(response.status, 403);

    response = await request(baseUrl, '/api/logout', true, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);

    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    fs.rmSync(procRoot, { recursive: true, force: true });
    fs.rmSync(lotteryRoot, { recursive: true, force: true });
    console.log('server tests passed');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
