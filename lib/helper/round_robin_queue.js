const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lottery_info_dir, shuffle } = require('../utils');

const QUEUE_VERSION = 1;
const FILTER_SIGNATURE_KEYS = [
    'key_words', 'blockword', 'blacklist', 'model', 'chatmodel',
    'block_dynamic_type', 'max_create_time', 'disable_reserve_lottery',
    'is_not_relay_reserve_lottery', 'sneaktower', 'only_followed',
    'minfollower', 'check_if_duplicated', 'ai_judge_parm',
];

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalize(value) {
    if (value === undefined) return '"__undefined__"';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function getSnapshotPath(filename, directory = lottery_info_dir) {
    const basename = path.basename(String(filename || 'lottery_info_1.json'));
    return path.join(directory, basename);
}

function getQueuePath(account, directory = lottery_info_dir) {
    return path.join(directory, `lottery_queue_${Number(account)}.json`);
}

function getFilterSignature(config = {}) {
    return hash(canonicalize(Object.fromEntries(
        FILTER_SIGNATURE_KEYS.map(key => [key, config[key]])
    )));
}

function getSnapshotSignature(filename, directory = lottery_info_dir) {
    const filePath = getSnapshotPath(filename, directory);
    return hash(fs.readFileSync(filePath));
}

function isQueueState(value) {
    return value
        && value.version === QUEUE_VERSION
        && Number.isSafeInteger(Number(value.account))
        && value.snapshot
        && typeof value.snapshot.sha256 === 'string'
        && typeof value.filter_signature === 'string'
        && Array.isArray(value.pending)
        && value.stats
        && typeof value.stats === 'object';
}

class RoundRobinQueue {
    constructor({ account, directory = lottery_info_dir, now = Date.now } = {}) {
        this.account = Number(account);
        this.directory = directory;
        this.now = now;
        this.state = null;
    }

    filepath() {
        return getQueuePath(this.account, this.directory);
    }

    atomicWrite() {
        fs.mkdirSync(this.directory, { recursive: true });
        this.state.updated_at = this.now();
        const target = this.filepath();
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.state));
        fs.renameSync(temporary, target);
    }

    preserveInvalid(reason = 'stale') {
        const target = this.filepath();
        if (!fs.existsSync(target)) return '';
        const backup = `${target}.${reason}-${this.now()}`;
        fs.renameSync(target, backup);
        return backup;
    }

    read() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filepath(), 'utf8'));
            return isQueueState(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    async loadOrCreate({ snapshotFilename, config, createCandidates }) {
        const snapshotSha256 = getSnapshotSignature(snapshotFilename, this.directory);
        const filterSignature = getFilterSignature(config);
        const existingFile = fs.existsSync(this.filepath());
        const existing = this.read();
        if (existing
            && Number(existing.account) === this.account
            && existing.snapshot.filename === path.basename(snapshotFilename)
            && existing.snapshot.sha256 === snapshotSha256
            && existing.filter_signature === filterSignature) {
            this.state = existing;
            return { created: false, pending: this.state.pending };
        }

        if (existingFile) this.preserveInvalid(existing ? 'stale' : 'corrupt');
        const candidates = await createCandidates();
        const timestamp = this.now();
        this.state = {
            version: QUEUE_VERSION,
            account: this.account,
            snapshot: {
                filename: path.basename(snapshotFilename),
                sha256: snapshotSha256,
            },
            filter_signature: filterSignature,
            created_at: timestamp,
            updated_at: timestamp,
            pending: shuffle([...candidates]),
            stats: {
                initial: candidates.length,
                successful: 0,
                skipped: 0,
                deferred: 0,
            },
        };
        this.atomicWrite();
        return { created: true, pending: this.state.pending };
    }

    get pending() {
        return this.state?.pending || [];
    }

    get remaining() {
        return this.pending.length;
    }

    findIndex(dyid) {
        return this.pending.findIndex(item => String(item?.dyid) === String(dyid));
    }

    complete(dyid, outcome = 'skipped') {
        const index = this.findIndex(dyid);
        if (index < 0) return false;
        this.pending.splice(index, 1);
        if (outcome === 'successful') this.state.stats.successful += 1;
        else this.state.stats.skipped += 1;
        this.atomicWrite();
        return true;
    }

    defer(dyid) {
        const index = this.findIndex(dyid);
        if (index < 0) return false;
        const [item] = this.pending.splice(index, 1);
        this.pending.push(item);
        this.state.stats.deferred += 1;
        this.atomicWrite();
        return true;
    }

    summary() {
        return {
            account: this.account,
            remaining: this.remaining,
            ...this.state.stats,
        };
    }
}

module.exports = {
    QUEUE_VERSION,
    RoundRobinQueue,
    getFilterSignature,
    getQueuePath,
    getSnapshotSignature,
};
