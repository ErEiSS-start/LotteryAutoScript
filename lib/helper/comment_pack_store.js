const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isValidEntry(entry) {
    return entry
        && /^[1-9]\d*$/.test(String(entry.dyid || ''))
        && typeof entry.signature === 'string'
        && entry.signature
        && Array.isArray(entry.accounts)
        && Array.isArray(entry.comments)
        && entry.accounts.length === entry.comments.length
        && entry.comments.every(comment => String(comment || '').trim())
        && Number.isFinite(Number(entry.createdAt));
}

class CommentPackStore {
    constructor({ filePath, retentionDays = 30, now = () => Date.now(), logger = log } = {}) {
        this.filePath = filePath || path.join(process.cwd(), 'comment_history', 'ai_comment_packs.json');
        this.retentionDays = positiveNumber(retentionDays, 30);
        this.now = now;
        this.logger = logger;
        this.loaded = false;
        this.entries = [];
    }

    load() {
        if (this.loaded) return this.entries;
        this.loaded = true;
        try {
            if (fs.existsSync(this.filePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                this.entries = Number(parsed?.version) === VERSION && Array.isArray(parsed?.entries)
                    ? parsed.entries.filter(isValidEntry)
                    : [];
            }
        } catch (error) {
            this.entries = [];
            this.logger.warn('AI评论包', `缓存读取失败，将重新生成: ${error.message}`);
        }
        this.prune();
        return this.entries;
    }

    prune() {
        const cutoff = this.now() - this.retentionDays * DAY_MS;
        this.entries = this.entries.filter(entry => Number(entry.createdAt) >= cutoff);
        return this.entries;
    }

    get(dyid, signature) {
        this.load();
        this.prune();
        const expectedDyid = String(dyid);
        return this.entries.find(entry =>
            entry.dyid === expectedDyid
            && entry.signature === signature
        ) || null;
    }

    remember(entry) {
        this.load();
        const normalized = {
            dyid: String(entry?.dyid || ''),
            signature: String(entry?.signature || ''),
            accounts: Array.isArray(entry?.accounts) ? entry.accounts.map(String) : [],
            comments: Array.isArray(entry?.comments) ? entry.comments.map(comment => String(comment || '').trim()) : [],
            hasExplicitRequirement: entry?.hasExplicitRequirement === true,
            provider: String(entry?.provider || 'local'),
            aiCount: Math.max(0, Number(entry?.aiCount) || 0),
            localCount: Math.max(0, Number(entry?.localCount) || 0),
            createdAt: this.now(),
        };
        if (!isValidEntry(normalized)) return false;
        this.entries = this.entries.filter(item => item.dyid !== normalized.dyid);
        this.entries.push(normalized);
        this.prune();
        return this.save();
    }

    save() {
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${process.pid}.next`;
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(
                temporaryPath,
                JSON.stringify({ version: VERSION, entries: this.entries }),
                'utf8'
            );
            fs.renameSync(temporaryPath, this.filePath);
            return true;
        } catch (error) {
            this.logger.warn('AI评论包', `缓存保存失败，不影响本次参与: ${error.message}`);
            try {
                if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            } catch (_) {
                // 清理失败不影响主任务。
            }
            return false;
        }
    }
}

module.exports = { VERSION, CommentPackStore };
