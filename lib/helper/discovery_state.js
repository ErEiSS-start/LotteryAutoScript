const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lottery_info_dir, isValidDynamicId } = require('../utils');

const STATE_VERSION = 1;
const LOTTERY_ORDER_MAP = new Map([
    [0, 'UIDs'],
    [1, 'TAGs'],
    [2, 'Articles'],
    [3, 'APIs'],
    [4, 'TxT'],
    [5, 'CollectionUIDs'],
]);
const DISCOVERY_SETTING_KEYS = [
    'article_scan_page',
    'article_create_time',
    'not_check_article',
    'uid_scan_page',
    'tag_scan_page',
    'collection_uid_scan_page',
    'collection_dynamic_max_age_hours',
    'collection_dynamic_keywords',
    'collection_uid_page_352_cooldowns',
    'max_create_time',
    'check_if_duplicated',
];

function canonicalize(value) {
    if (value === undefined) return '"__undefined__"';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function hash(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeDiscoveryMode(value) {
    if (value === undefined || value === null || String(value).trim() === '') return 'collect';
    const mode = String(value).trim().toLowerCase();
    if (!['collect', 'reuse', 'resume'].includes(mode)) {
        throw new Error(`lottery_discovery_mode配置无效(${value})，仅支持collect、reuse、resume`);
    }
    return mode;
}

function buildDiscoveryPlan(config = {}) {
    const entries = [];
    for (const order of Array.isArray(config.LotteryOrder) ? config.LotteryOrder : []) {
        const type = LOTTERY_ORDER_MAP.get(Number(order));
        if (!type) continue;
        const values = Array.isArray(config[type]) ? config[type] : [];
        for (const value of values) {
            const index = entries.length;
            const valueHash = hash(canonicalize(value)).slice(0, 16);
            entries.push({
                id: `${String(index).padStart(4, '0')}:${type}:${valueHash}`,
                type,
                value,
                index,
            });
        }
    }

    const settings = Object.fromEntries(
        DISCOVERY_SETTING_KEYS.map(key => [key, config[key]])
    );
    const signature = hash(canonicalize({
        sources: entries.map(({ id, type }) => ({ id, type })),
        settings,
    }));
    return { signature, entries };
}

class DiscoveryStateManager {
    constructor({ directory = lottery_info_dir, number = 1, now = Date.now } = {}) {
        this.directory = directory;
        this.number = Number(number) || 1;
        this.now = now;
        this.active = null;
    }

    filenames() {
        const prefix = `lottery_info_${this.number}`;
        return {
            final: `${prefix}.json`,
            next: `${prefix}.next.json`,
            backup: `${prefix}.last-good.json`,
            state: `${prefix}.discovery-state.json`,
        };
    }

    filepath(filename) {
        return path.join(this.directory, filename);
    }

    atomicWrite(filename, value) {
        fs.mkdirSync(this.directory, { recursive: true });
        const target = this.filepath(filename);
        const temporary = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, typeof value === 'string' ? value : JSON.stringify(value));
        fs.renameSync(temporary, target);
    }

    readObject(filename) {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filepath(filename), 'utf8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch (_) {
            return null;
        }
    }

    startFresh(config) {
        const plan = buildDiscoveryPlan(config);
        const timestamp = this.now();
        const state = {
            version: STATE_VERSION,
            account: this.number,
            plan_signature: plan.signature,
            source_count: plan.entries.length,
            completed_source_ids: [],
            created_at: timestamp,
            updated_at: timestamp,
        };
        const names = this.filenames();
        this.atomicWrite(names.next, {});
        this.atomicWrite(names.state, state);
        this.active = { plan, state };
        return { plan, state, pending: [...plan.entries] };
    }

    prepareResume(config) {
        const plan = buildDiscoveryPlan(config);
        const names = this.filenames();
        const state = this.readObject(names.state);
        if (!state) return { ok: false, error: `断点文件${names.state}缺失或损坏` };
        if (state.version !== STATE_VERSION || Number(state.account) !== this.number) {
            return { ok: false, error: '断点版本或帐号不匹配' };
        }
        if (state.plan_signature !== plan.signature) {
            return { ok: false, error: '采集配置已变化，断点签名不匹配' };
        }
        if (Number(state.source_count) !== plan.entries.length
            || !Array.isArray(state.completed_source_ids)) {
            return { ok: false, error: '断点来源进度格式无效' };
        }
        const nextObject = this.readObject(names.next);
        if (!nextObject || !Object.values(nextObject).every(Array.isArray)) {
            return { ok: false, error: `临时快照${names.next}缺失或损坏` };
        }

        const knownIds = new Set(plan.entries.map(entry => entry.id));
        if (state.completed_source_ids.some(id => !knownIds.has(id))) {
            return { ok: false, error: '断点包含未知来源，无法安全续采' };
        }
        const completed = [...new Set(state.completed_source_ids)];
        if (completed.some(id => !Object.prototype.hasOwnProperty.call(nextObject, id))) {
            return { ok: false, error: '临时快照缺少已完成来源的数据，无法安全续采' };
        }
        state.completed_source_ids = completed;
        this.active = { plan, state };
        const completedSet = new Set(completed);
        return {
            ok: true,
            plan,
            state,
            pending: plan.entries.filter(entry => !completedSet.has(entry.id)),
        };
    }

    getPendingEntries(config) {
        if (!this.active || this.active.plan.signature !== buildDiscoveryPlan(config).signature) {
            return buildDiscoveryPlan(config).entries;
        }
        const completed = new Set(this.active.state.completed_source_ids || []);
        return this.active.plan.entries.filter(entry => !completed.has(entry.id));
    }

    markCompleted(sourceId) {
        if (!this.active || !sourceId) return false;
        const validIds = new Set(this.active.plan.entries.map(entry => entry.id));
        if (!validIds.has(sourceId)) return false;
        const completed = new Set(this.active.state.completed_source_ids || []);
        if (completed.has(sourceId)) return true;
        completed.add(sourceId);
        this.active.state.completed_source_ids = [...completed];
        this.active.state.updated_at = this.now();
        this.atomicWrite(this.filenames().state, this.active.state);
        return true;
    }

    getProgress() {
        if (!this.active) return { completed: 0, total: 0 };
        return {
            completed: this.active.state.completed_source_ids?.length || 0,
            total: this.active.state.source_count || 0,
        };
    }

    finish() {
        const statePath = this.filepath(this.filenames().state);
        if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
        this.active = null;
    }

    validateSnapshot(filename) {
        const snapshot = this.readObject(filename);
        if (!snapshot || !Object.values(snapshot).every(Array.isArray)) {
            return { valid: false, count: 0, invalidCount: 0, filename };
        }
        const items = Object.values(snapshot).flat().filter(item => item && typeof item === 'object');
        const validItems = items.filter(item => isValidDynamicId(item.dyid));
        return {
            valid: validItems.length > 0,
            count: validItems.length,
            invalidCount: items.length - validItems.length,
            filename,
        };
    }

    selectReusableSnapshot() {
        const names = this.filenames();
        const final = this.validateSnapshot(names.final);
        if (final.valid) return final;
        const backup = this.validateSnapshot(names.backup);
        if (backup.valid) return { ...backup, fallback: true };
        return {
            valid: false,
            count: 0,
            invalidCount: final.invalidCount + backup.invalidCount,
            filename: '',
        };
    }
}

const discoveryState = new DiscoveryStateManager();

module.exports = {
    STATE_VERSION,
    DiscoveryStateManager,
    buildDiscoveryPlan,
    normalizeDiscoveryMode,
    discoveryState,
};
