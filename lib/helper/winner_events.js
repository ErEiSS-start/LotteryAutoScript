const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify } = require('./winner_classifier');
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex').slice(0, 24); }
function append(event) {
    const file = process.env.TASK_WINS_FILE;
    if (!file) throw new Error('Missing durable winner journal');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(file, 'a', 0o600);
    try { fs.writeSync(descriptor, JSON.stringify({ version: 1, ...event }) + '\n'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
}
function message(record) {
    const classification = classify(record);
    const id = record.id || (record.source === 'private'
        ? hash([record.talkerId, record.messageSequence || '', Number(record.messageTimestamp) || 0, record.content].join('\n'))
        : hash([record.source, record.sourceMessageId || '', record.senderUid, record.messageTimestamp, record.content].join('\n')));
    const event = { kind: 'message', record: { ...record, id, ...classification } };
    append(event);
    return event.record;
}
function reply(record) { append({ kind: 'reply', record }); }
module.exports = { message, reply, hash };
