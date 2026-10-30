const fs = require('fs');
const path = require('path');
const rows = new Map();
const issues = [];
let current;
const active = Boolean(process.env.TASK_GUARD_RESULT_PATH);
function save(complete = false) {
    if (!active) return;
    const filename = process.env.TASK_GUARD_RESULT_PATH;
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename + '.tmp', JSON.stringify({ version: 1, complete,
        run_id: process.env.TASK_GUARD_RUN_ID, accounts: [...rows.values()], issues }), { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
}
function account(value) {
    const uid = /(?:^|;\s*)DedeUserID=(\d+)/.exec(value.COOKIE || '');
    const key = uid ? uid[1] : '0';
    if (!rows.has(key)) rows.set(key, { account: key, number: value.NUMBER,
        status: 'success', issues: [], passed: [], warnings: [] });
    current = rows.get(key);
    save();
}
function fail(code, stage, global = false) {
    const target = global || !current ? issues : current.issues;
    if (!target.some(i => i.code === code && i.stage === stage)) target.push({ code, stage });
    if (target !== issues) current.status = 'failed';
    save();
}
function passed(stage) {
    if (current && !current.issues.some(i => i.stage === stage) && !current.passed.includes(stage)) current.passed.push(stage);
    save();
}
function warning(code) { if (current && !current.warnings.includes(code)) current.warnings.push(code); save(); }
function hasFailures() { return issues.length > 0 || [...rows.values()].some(r => r.issues.length); }
function finish() {
    save(true);
    if (issues.length || !rows.size) return 1;
    const failed = [...rows.values()].filter(r => r.issues.length).length;
    return failed ? failed === rows.size ? 1 : 2 : 0;
}
function currentStatus() { return current?.status || 'failed'; }
module.exports = { active, account, fail, passed, warning, hasFailures, finish, currentStatus };
