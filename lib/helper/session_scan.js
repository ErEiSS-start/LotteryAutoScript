function buildSessionQuery(scope, cursor = '') {
    const type = String(scope);
    if (!['1', '2'].includes(type)) throw new Error('Unsupported private-message scope');
    return { session_type: type === '1' ? 9 : 2, group_fold: 1, unfollow_fold: 0,
        sort_rule: 2, size: 20, end_ts: cursor };
}

async function scanUnreadSessions({ expectedUnread, maxPages = 64, getPage, onSession,
    wait = async () => {}, delayMs = 3000 }) {
    const expected = Math.max(0, Number(expectedUnread) || 0);
    const limit = Math.max(1, Math.floor(Number(maxPages) || 64));
    let cursor = '', covered = 0, pages = 0;
    const seen = new Set();
    const outcome = (complete, reason) => ({ complete, reason, covered, expected, pages });
    if (!expected) return outcome(true, 'no_unread');
    while (pages < limit) {
        const page = await getPage(cursor);
        if (!page || page.errorCode || page.has_more == null || ![0, 1].includes(Number(page.has_more))
            || !Array.isArray(page.data)) return outcome(false, 'page_failed');
        pages += 1;
        const times = [];
        for (const session of page.data) {
            if (!session || typeof session !== 'object') return outcome(false, 'page_failed');
            if (!session.top_ts && /^[1-9]\d*$/.test(String(session.session_ts || ''))) {
                times.push(String(session.session_ts));
            }
            if (Number(session.session_type || 1) !== 1) continue;
            if (!/^[1-9]\d*$/.test(String(session.talker_id || ''))) return outcome(false, 'page_failed');
            const key = String(session.talker_id);
            if (seen.has(key)) continue;
            seen.add(key);
            if (Number(session.unread_count) > 0) {
                await onSession(session);
                covered += Number(session.unread_count);
            }
        }
        if (covered >= expected) return outcome(true, 'covered');
        if (!Number(page.has_more)) return outcome(true, 'exhausted');
        if (pages >= limit) return outcome(false, 'page_limit');
        const next = times.reduce((min, t) => !min || BigInt(t) < BigInt(min) ? t : min, '');
        if (!next || (cursor && BigInt(next) >= BigInt(cursor))) return outcome(false, 'cursor_stalled');
        cursor = next;
        await wait(delayMs);
    }
    return outcome(false, 'page_limit');
}
module.exports = { buildSessionQuery, scanUnreadSessions };
