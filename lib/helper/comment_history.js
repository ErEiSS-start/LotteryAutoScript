const fs = require('fs');
const path = require('path');
const { log } = require('../utils');

const DAY_MS = 24 * 60 * 60 * 1000;

function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isValidEntry(entry) {
    return entry
        && /^[1-9]\d*$/.test(String(entry.dyid || ''))
        && String(entry.comment || '').trim()
        && Number.isFinite(Number(entry.createdAt));
}

class CommentHistoryStore {
    constructor({ filePath, retentionDays = 30, now = () => Date.now(), logger = log } = {}) {
        this.filePath = filePath || path.join(process.cwd(), 'comment_history', 'successful_comments.json');
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
                this.entries = Array.isArray(parsed?.entries)
                    ? parsed.entries.filter(isValidEntry)
                    : [];
            }
        } catch (error) {
            this.entries = [];
            this.logger.warn('AI评论历史', `读取失败，将从空历史继续: ${error.message}`);
        }
        this.prune();
        return this.entries;
    }

    prune() {
        const cutoff = this.now() - this.retentionDays * DAY_MS;
        this.entries = this.entries.filter(entry => Number(entry.createdAt) >= cutoff);
        return this.entries;
    }

    getByDyid(dyid) {
        this.load();
        const expected = String(dyid);
        return this.entries.filter(entry => entry.dyid === expected);
    }

    getRecent(limit = 0) {
        this.load();
        const size = Number(limit);
        return Number.isFinite(size) && size > 0
            ? this.entries.slice(-Math.floor(size))
            : [...this.entries];
    }

    remember(dyid, comment, accountNumber) {
        this.load();
        const entry = {
            dyid: String(dyid),
            account: Math.max(1, Number(accountNumber) || 1),
            comment: String(comment || '').trim(),
            createdAt: this.now(),
        };
        if (!isValidEntry(entry)) return false;
        this.entries.push(entry);
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
                JSON.stringify({ version: 1, entries: this.entries }),
                'utf8'
            );
            fs.renameSync(temporaryPath, this.filePath);
            return true;
        } catch (error) {
            this.logger.warn('AI评论历史', `保存失败，不影响本次参与: ${error.message}`);
            try {
                if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
            } catch (_) {
                // 清理失败不影响主任务。
            }
            return false;
        }
    }
}

module.exports = { CommentHistoryStore };
