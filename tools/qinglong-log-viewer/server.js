'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');
const readline = require('readline');
const { createWinReminderStore } = require('./win-reminders');

const DEFAULT_LOG_ROOT = '/opt/1panel/apps/qinglong/qinglong/data/log';
const DEFAULT_TOKEN_FILE = '/var/lib/qinglong-log-viewer/token';
const DEFAULT_PROC_ROOT = '/proc';
const DEFAULT_LOTTERY_ROOT = '/opt/1panel/apps/qinglong/qinglong/data/scripts/LotteryAutoScript';
const PUBLIC_DIR = path.join(__dirname, 'public');
// eslint-disable-next-line no-control-regex, no-useless-escape
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const RUNTIME_TASKS = Object.freeze([
    'LotteryAutoScript_start',
    'LotteryAutoScript_check',
]);

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
};

function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

async function readJsonBody(req, maxBytes = 4096) {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        throw Object.assign(new Error('请求必须使用 application/json'), { statusCode: 415 });
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (_) {
        throw Object.assign(new Error('JSON 格式无效'), { statusCode: 400 });
    }
}

function isSameSecret(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseBasicAuth(header = '') {
    if (!header.startsWith('Basic ')) return null;
    try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        if (separator < 0) return null;
        return {
            username: decoded.slice(0, separator),
            password: decoded.slice(separator + 1),
        };
    } catch (_) {
        return null;
    }
}

function createRuntimeDetector(procRoot = DEFAULT_PROC_ROOT, cacheMs = 2000) {
    let cached = Object.fromEntries(RUNTIME_TASKS.map(task => [task, 0]));
    let expiresAt = 0;
    let inFlight = null;

    async function scan() {
        const counts = Object.fromEntries(RUNTIME_TASKS.map(task => [task, 0]));
        const entries = await fsp.readdir(procRoot, { withFileTypes: true });
        const cmdlines = await Promise.all(entries
            .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map(async entry => {
                try {
                    return await fsp.readFile(path.join(procRoot, entry.name, 'cmdline'));
                } catch (_) {
                    return null;
                }
            }));

        cmdlines.forEach(raw => {
            if (!raw || !raw.length) return;
            const args = raw.toString('utf8').split('\0').filter(Boolean);
            const usesTaskRunner = args.some(argument => argument === '/usr/local/bin/task');
            if (!usesTaskRunner) return;
            RUNTIME_TASKS.forEach(task => {
                if (args.some(argument => path.basename(argument) === `${task}.sh`)) counts[task] += 1;
            });
        });
        return counts;
    }

    return async function detectRuntime() {
        const now = Date.now();
        if (now < expiresAt) return cached;
        if (inFlight) return inFlight;
        inFlight = scan().catch(() => Object.fromEntries(RUNTIME_TASKS.map(task => [task, 0])))
            .then(result => {
                cached = result;
                expiresAt = Date.now() + cacheMs;
                inFlight = null;
                return cached;
            });
        return inFlight;
    };
}

function createPathResolver(logRoot) {
    const root = fs.realpathSync(logRoot);
    const rootPrefix = `${root}${path.sep}`;

    return function resolveLogPath(relativePath = '', expectedType = '') {
        if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
            throw Object.assign(new Error('路径无效'), { statusCode: 400 });
        }
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const candidate = path.resolve(root, normalized);
        if (candidate !== root && !candidate.startsWith(rootPrefix)) {
            throw Object.assign(new Error('禁止访问日志目录之外的路径'), { statusCode: 403 });
        }

        let real;
        try {
            real = fs.realpathSync(candidate);
        } catch (error) {
            if (error.code === 'ENOENT') {
                throw Object.assign(new Error('文件不存在'), { statusCode: 404 });
            }
            throw error;
        }
        if (real !== root && !real.startsWith(rootPrefix)) {
            throw Object.assign(new Error('禁止通过链接访问日志目录之外的路径'), { statusCode: 403 });
        }
        const stat = fs.statSync(real);
        if (expectedType === 'file' && !stat.isFile()) {
            throw Object.assign(new Error('目标不是文件'), { statusCode: 400 });
        }
        if (expectedType === 'directory' && !stat.isDirectory()) {
            throw Object.assign(new Error('目标不是目录'), { statusCode: 400 });
        }
        return { absolute: real, relative: path.relative(root, real).split(path.sep).join('/'), stat };
    };
}

async function readChunk(filePath, stat, offsetValue, limitValue) {
    const limit = clampInteger(limitValue, 128 * 1024, 16 * 1024, 1024 * 1024);
    const requestedOffset = offsetValue === null
        ? Math.max(0, stat.size - limit)
        : clampInteger(offsetValue, 0, 0, stat.size);
    const length = Math.min(limit, Math.max(0, stat.size - requestedOffset));
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    if (length) {
        const handle = await fsp.open(filePath, 'r');
        try {
            ({ bytesRead } = await handle.read(buffer, 0, length, requestedOffset));
        } finally {
            await handle.close();
        }
    }

    let start = requestedOffset;
    let content = buffer.subarray(0, bytesRead);
    if (requestedOffset > 0 && content.length) {
        const firstNewline = content.indexOf(0x0A);
        if (firstNewline >= 0 && firstNewline < content.length - 1) {
            start += firstNewline + 1;
            content = content.subarray(firstNewline + 1);
        }
    }

    return {
        start,
        end: requestedOffset + bytesRead,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        text: content.toString('utf8').replace(ANSI_PATTERN, ''),
    };
}

function loadOrCreateToken(tokenFile = DEFAULT_TOKEN_FILE) {
    if (process.env.LOG_VIEWER_TOKEN) return process.env.LOG_VIEWER_TOKEN;
    try {
        const existing = fs.readFileSync(tokenFile, 'utf8').trim();
        if (existing) return existing;
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    const token = crypto.randomBytes(24).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    return token;
}

function createLogServer(options = {}) {
    const logRoot = options.logRoot || process.env.LOG_ROOT || DEFAULT_LOG_ROOT;
    const token = options.token || loadOrCreateToken(options.tokenFile || process.env.TOKEN_FILE);
    const resolveLogPath = createPathResolver(logRoot);
    const username = options.username || process.env.LOG_VIEWER_USER || 'logs';
    const lotteryRoot = options.lotteryRoot || process.env.LOTTERY_ROOT || DEFAULT_LOTTERY_ROOT;
    const winStateFile = options.winStateFile || process.env.WIN_STATE_FILE
        || path.join(lotteryRoot, 'web_state', 'dismissed-wins.json');
    const winReminders = options.winReminders || createWinReminderStore({
        lotteryRoot,
        stateFile: winStateFile,
    });
    const viewerInstance = options.viewerInstance || process.env.VIEWER_INSTANCE || '本服务器';
    const peerViewerUrl = options.peerViewerUrl || process.env.PEER_VIEWER_URL || '';
    const detectRuntime = options.detectRuntime || createRuntimeDetector(
        options.procRoot || process.env.PROC_ROOT || DEFAULT_PROC_ROOT,
        options.runtimeCacheMs === undefined ? 2000 : options.runtimeCacheMs,
    );

    return http.createServer(async (req, res) => {
        const startedAt = Date.now();
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', 'default-src \'self\'; style-src \'self\'; script-src \'self\'; img-src \'self\' data:; connect-src \'self\'; base-uri \'none\'; frame-ancestors \'self\'');

        const auth = parseBasicAuth(req.headers.authorization);
        if (!auth || auth.username !== username || !isSameSecret(auth.password, token)) {
            res.writeHead(401, {
                'WWW-Authenticate': 'Basic realm="QingLong Logs", charset="UTF-8"',
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end('需要日志查看器凭据');
            return;
        }

        try {
            const url = new URL(req.url, 'http://localhost');

            if (req.method === 'GET' && url.pathname === '/health') {
                return json(res, 200, { ok: true, responseMs: Date.now() - startedAt });
            }

            if (req.method === 'GET' && url.pathname === '/api/wins') {
                const result = await winReminders.list(url.searchParams.get('status') || 'pending');
                return json(res, 200, {
                    instance: viewerInstance,
                    peerViewerUrl,
                    ...result,
                });
            }

            if (req.method === 'POST' && ['/api/wins/dismiss', '/api/wins/restore'].includes(url.pathname)) {
                if (req.headers['x-qlv-action'] !== '1') {
                    return json(res, 403, { error: '缺少中奖提醒操作确认标头' });
                }
                const body = await readJsonBody(req);
                const result = url.pathname.endsWith('/dismiss')
                    ? await winReminders.dismiss(body.accountUid, body.recordId)
                    : await winReminders.restore(body.accountUid, body.recordId);
                return json(res, 200, { ok: true, ...result });
            }

            if (req.method === 'GET' && url.pathname === '/api/list') {
                const directory = resolveLogPath(url.searchParams.get('path') || '', 'directory');
                const offset = clampInteger(url.searchParams.get('offset'), 0, 0, 1_000_000);
                const limit = clampInteger(url.searchParams.get('limit'), 200, 20, 500);
                const dirents = await fsp.readdir(directory.absolute, { withFileTypes: true });
                const entries = (await Promise.all(dirents.map(async entry => {
                    if (!entry.isDirectory() && !entry.isFile()) return null;
                    const absolute = path.join(directory.absolute, entry.name);
                    const stat = await fsp.stat(absolute);
                    return {
                        name: entry.name,
                        path: directory.relative ? `${directory.relative}/${entry.name}` : entry.name,
                        type: entry.isDirectory() ? 'directory' : 'file',
                        size: stat.size,
                        mtimeMs: stat.mtimeMs,
                    };
                }))).filter(Boolean).sort((left, right) => {
                    if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
                    return right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name, 'zh-CN');
                });
                const runtimeCounts = await detectRuntime();
                const runningFiles = runtimeCounts[directory.relative] || 0;
                let markedFiles = 0;
                const entriesWithRuntime = entries.map(entry => {
                    let running = false;
                    if (!directory.relative && entry.type === 'directory') {
                        running = Boolean(runtimeCounts[entry.name]);
                    } else if (runningFiles && entry.type === 'file' && markedFiles < runningFiles) {
                        running = true;
                        markedFiles += 1;
                    }
                    return { ...entry, running };
                });
                return json(res, 200, {
                    path: directory.relative,
                    offset,
                    limit,
                    total: entriesWithRuntime.length,
                    entries: entriesWithRuntime.slice(offset, offset + limit),
                });
            }

            if (req.method === 'GET' && url.pathname === '/api/meta') {
                const file = resolveLogPath(url.searchParams.get('path') || '', 'file');
                return json(res, 200, {
                    path: file.relative,
                    size: file.stat.size,
                    mtimeMs: file.stat.mtimeMs,
                });
            }

            if (req.method === 'GET' && url.pathname === '/api/chunk') {
                const file = resolveLogPath(url.searchParams.get('path') || '', 'file');
                const rawOffset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
                const chunk = await readChunk(file.absolute, file.stat, rawOffset, url.searchParams.get('limit'));
                return json(res, 200, { path: file.relative, ...chunk });
            }

            if (req.method === 'GET' && url.pathname === '/api/search') {
                const file = resolveLogPath(url.searchParams.get('path') || '', 'file');
                const query = (url.searchParams.get('q') || '').trim();
                if (!query || query.length > 200) {
                    return json(res, 400, { error: '搜索词长度必须为1到200个字符' });
                }
                const resultLimit = clampInteger(url.searchParams.get('limit'), 100, 1, 200);
                const caseSensitive = url.searchParams.get('case') === '1';
                const needle = caseSensitive ? query : query.toLocaleLowerCase();
                const stream = fs.createReadStream(file.absolute, { encoding: 'utf8', highWaterMark: 256 * 1024 });
                const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
                const matches = [];
                let lineNumber = 0;
                let byteOffset = 0;
                for await (const line of lines) {
                    lineNumber += 1;
                    const haystack = caseSensitive ? line : line.toLocaleLowerCase();
                    if (haystack.includes(needle)) {
                        matches.push({
                            line: lineNumber,
                            offset: byteOffset,
                            text: line.replace(ANSI_PATTERN, '').slice(0, 1600),
                        });
                        if (matches.length >= resultLimit) {
                            break;
                        }
                    }
                    byteOffset += Buffer.byteLength(line, 'utf8') + 1;
                }
                return json(res, 200, {
                    path: file.relative,
                    query,
                    matches,
                    limited: matches.length >= resultLimit,
                    elapsedMs: Date.now() - startedAt,
                });
            }

            if (req.method === 'GET' && url.pathname === '/api/download') {
                const file = resolveLogPath(url.searchParams.get('path') || '', 'file');
                res.writeHead(200, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Length': file.stat.size,
                    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.absolute))}`,
                    'Cache-Control': 'no-store',
                });
                fs.createReadStream(file.absolute).pipe(res);
                return;
            }

            if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
                const content = await fsp.readFile(path.join(PUBLIC_DIR, 'index.html'));
                res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'], 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
                res.end(content);
                return;
            }

            if (req.method === 'GET' && /^\/[a-zA-Z0-9._-]+$/.test(url.pathname)) {
                const filePath = path.join(PUBLIC_DIR, path.basename(url.pathname));
                const extension = path.extname(filePath);
                if (!MIME_TYPES[extension]) return json(res, 404, { error: 'Not found' });
                const content = await fsp.readFile(filePath);
                res.writeHead(200, { 'Content-Type': MIME_TYPES[extension], 'Content-Length': content.length, 'Cache-Control': 'public, max-age=300' });
                res.end(content);
                return;
            }

            return json(res, 404, { error: 'Not found' });
        } catch (error) {
            const status = error.statusCode || (error.code === 'ENOENT' ? 404 : 500);
            if (status >= 500) console.error(error);
            return json(res, status, { error: status >= 500 ? '服务器读取日志失败' : error.message });
        }
    });
}

if (require.main === module) {
    const host = process.env.HOST || '127.0.0.1';
    const port = clampInteger(process.env.PORT, 5799, 1, 65535);
    const server = createLogServer();
    server.listen(port, host, () => {
        console.log(`QingLong Log Viewer listening on http://${host}:${port}`);
    });
}

module.exports = {
    createLogServer,
    createPathResolver,
    loadOrCreateToken,
    readJsonBody,
    readChunk,
};
