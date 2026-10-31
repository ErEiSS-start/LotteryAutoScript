#!/usr/bin/env python3
"""Durable participation telemetry, restricted export and independent aggregation."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import statistics
import subprocess
import time
import uuid
from zoneinfo import ZoneInfo
import guard

NY = ZoneInfo('America/New_York')
KINDS = {'account_begin', 'account_end', 'snapshot', 'snapshot_reuse', 'candidates',
         'queue', 'disposition', 'interaction', 'run', 'roster', 'health'}
FIELDS = {'span', 'phase', 'status', 'raw', 'count', 'snapshot', 'ids', 'queue', 'resumed',
          'remaining', 'dyid', 'outcome', 'success', 'started_at', 'finished_at', 'issues',
          'accounts', 'number', 'uid', 'metrics_enabled', 'complete', 'log_path', 'code'}


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    c = sqlite3.connect(path, timeout=30)
    c.row_factory = sqlite3.Row
    c.execute('pragma journal_mode=WAL')
    c.executescript('''
      create table if not exists events(seq integer primary key autoincrement,event_id text unique,
        server text,at real,type text,run_id text,uid text,number integer,data text);
      create table if not exists meta(key text primary key,value text);
      create table if not exists imports(path text primary key,inode integer,offset integer);
      create table if not exists daily(day text primary key,payload text);
      create table if not exists anomalies(uid text primary key,baseline real);
      create index if not exists metrics_event_time on events(at);
      create index if not exists metrics_event_type_time on events(type,at);
      create index if not exists metrics_account_time on events(server,uid,at);
      create index if not exists metrics_run_id on events(run_id,type);
    ''')
    return c


def meta(c, key, default=None):
    row = c.execute('select value from meta where key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def setmeta(c, key, value):
    c.execute('insert or replace into meta values(?,?)', (key, json.dumps(value, ensure_ascii=False)))


def valid_event(e, server):
    if not isinstance(e, dict) or e.get('version') != 1 or e.get('server') != server:
        raise ValueError('invalid envelope')
    if e.get('type') not in KINDS or not isinstance(e.get('data'), dict):
        raise ValueError('invalid event kind')
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,180}', str(e.get('event_id', ''))):
        raise ValueError('invalid identity')
    uid = str(e.get('uid', ''))
    if uid not in ('', 'global') and not re.fullmatch(r'[1-9][0-9]{0,19}', uid):
        raise ValueError('invalid account')
    if not isinstance(e.get('at'), (int, float)) or not 0 < e['at'] < 4102444800:
        raise ValueError('invalid time')
    data = e['data']
    if set(data) - FIELDS:
        raise ValueError('unknown data fields')
    for key in ('ids',):
        if key in data and (not isinstance(data[key], list) or len(data[key]) > 500
                            or any(not re.fullmatch(r'[0-9]{1,30}', str(v)) for v in data[key])):
            raise ValueError('invalid candidate identifiers')
    if 'dyid' in data and not re.fullmatch(r'[0-9]{1,30}', str(data['dyid'])):
        raise ValueError('invalid dynamic identifier')
    # Export only this allow-listed schema, never arbitrary nested API responses.
    if 'accounts' in data:
        if not isinstance(data['accounts'], list) or len(data['accounts']) > 200:
            raise ValueError('invalid roster')
        for a in data['accounts']:
            allowed = {'uid', 'number', 'status', 'issues'} if e['type'] == 'run' else {'uid', 'number'}
            if set(a) - allowed or not re.fullmatch(r'[1-9][0-9]{0,19}', str(a.get('uid', ''))):
                raise ValueError('invalid roster account')
    if 'issues' in data and (not isinstance(data['issues'], list)
                            or any(not re.fullmatch(r'[A-Z_]{1,60}', str(i)) for i in data['issues'])):
        raise ValueError('invalid issue codes')
    return dict(version=1, event_id=e['event_id'], server=server, at=float(e['at']), type=e['type'],
                run_id=str(e.get('run_id', ''))[:80], uid=uid, number=e.get('number'), data=data)


def insert(c, e):
    c.execute('insert or ignore into events(event_id,server,at,type,run_id,uid,number,data) values(?,?,?,?,?,?,?,?)',
              (e['event_id'], e['server'], e['at'], e['type'], e['run_id'], e['uid'], e['number'],
               json.dumps(e['data'], ensure_ascii=False)))


def changed(c, server, key, kind, data, now, run_id=''):
    signature = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    if meta(c, 'fingerprint:' + key) == signature:
        return
    # Transitions back to a previous value must get a new event identity.
    generation = int(meta(c, 'generation:' + key, 0)) + 1
    setmeta(c, 'generation:' + key, generation)
    setmeta(c, 'fingerprint:' + key, signature)
    insert(c, dict(event_id='meta:' + hashlib.sha256(server.encode()).hexdigest()[:12] + ':'
                   + str(meta(c, 'epoch', 'legacy')) + ':' + key + ':' + str(generation), server=server, at=now,
                   type=kind, run_id=run_id, uid='global', number=None, data=data))


def roster(root):
    with sqlite3.connect('file:' + str(root.parent / 'db/database.sqlite') + '?mode=ro', uri=True) as c:
        rows = c.execute("select name,value from Envs where status=0 and name like 'Ray_BiliBiliCookies__%'").fetchall()
    accounts = {}
    for name, cookie in rows:
        suffix = re.fullmatch(r'Ray_BiliBiliCookies__([0-9]+)', name)
        uid = re.search(r'(?:^|;\s*)DedeUserID=([1-9][0-9]*)(?:;|$)', cookie)
        if suffix and uid:
            accounts[uid[1]] = dict(uid=uid[1], number=int(suffix[1]) + 1)
    return sorted(accounts.values(), key=lambda a: a['number'])


def collect(root, cfg, now=None):
    now = time.time() if now is None else now
    metrics = root / 'metrics'
    with connect(metrics / 'local.sqlite') as c:
        if not meta(c, 'epoch'):
            setmeta(c, 'epoch', uuid.uuid4().hex)
        health = set()
        tails = set()
        for path in sorted((metrics / 'journal').glob('*.jsonl')):
            st = path.stat()
            prev = c.execute('select inode,offset from imports where path=?', (path.name,)).fetchone()
            offset = prev['offset'] if prev and prev['inode'] == st.st_ino and prev['offset'] <= st.st_size else 0
            with open(path, 'rb') as f:
                f.seek(offset)
                while True:
                    line = f.readline(2 * 1024 * 1024 + 1)
                    if not line or not line.endswith(b'\n'):
                        if line: tails.add(path.stem)
                        break
                    offset = f.tell()
                    try:
                        event = valid_event(json.loads(line), cfg['server'])
                        if event['run_id'] != path.stem:
                            raise ValueError('journal mismatch')
                        insert(c, event)
                    except (ValueError, TypeError, KeyError):
                        health.add(path.stem)
            c.execute('insert or replace into imports values(?,?,?)', (path.name, st.st_ino, offset))
        previous_bad = set(meta(c, 'bad_journals', []))
        setmeta(c, 'bad_journals', sorted(previous_bad | health))
        changed(c, cfg['server'], 'roster', 'roster', {'accounts': roster(root)}, now)
        for path in (root / 'runs').glob('*.json'):
            state = guard.read(path, {})
            if state.get('task') != 'start' or not state.get('metrics_enabled'):
                continue
            if state.get('finished_at') and state['finished_at'] < now - 180 * 86400:
                continue
            issues = sorted({i['code'] for i in state.get('issues', []) if i['account'] == 'global'})
            warning = any('METRICS_INCOMPLETE' in a.get('warnings', []) for a in state.get('accounts', []))
            missing = (not (metrics / 'journal' / path.with_suffix('.jsonl').name).exists()
                       or path.stem in previous_bad | health or warning
                       or (path.stem in tails and state.get('status') != 'running')
                       or not c.execute('select 1 from events where run_id=? limit 1', (state['run_id'],)).fetchone())
            data = {k: state.get(k) for k in ['status', 'started_at', 'finished_at', 'log_path']}
            data.update(issues=issues, metrics_enabled=True, complete=not missing)
            data['accounts'] = [dict(uid=a['account'], number=a.get('number'), status=a['status'],
                                    issues=sorted({i['code'] for i in a['issues']}))
                                for a in state.get('accounts', []) if a['account'].isdecimal() and a['account'] != '0']
            changed(c, cfg['server'], 'run-' + path.stem, 'run', data, now, state['run_id'])
        setmeta(c, 'collected_at', now)
        setmeta(c, 'installed_at', cfg['metrics_installed_at'])
        prune(c, now)
        for path in (metrics / 'journal').glob('*.jsonl'):
            state = guard.read(root / 'runs' / (path.stem + '.json'), {})
            imported = c.execute('select offset from imports where path=?', (path.name,)).fetchone()
            if (state.get('finished_at', now) < now - 180 * 86400 and imported
                    and imported[0] == path.stat().st_size):
                path.unlink()


def prune(c, now):
    cutoff = now - 180 * 86400
    # Keep roster transitions needed to identify historical account assignments.
    deleted = c.execute("select max(seq) from events where at<? and type!='roster'", (cutoff,)).fetchone()[0]
    if deleted:
        setmeta(c, 'expired_through', max(deleted, meta(c, 'expired_through', 0)))
    c.execute("delete from events where at<? and type!='roster'", (cutoff,))
    year = now - 365 * 86400
    c.execute("delete from events where type='roster' and at<? and seq not in (select max(seq) from events where type='roster' and at<? group by server)", (year, year))
    c.execute('delete from daily where day<?', ((dt.datetime.fromtimestamp(now, NY).date() - dt.timedelta(days=365)).isoformat(),))


def export(root, cfg, cursor):
    with sqlite3.connect('file:' + str(root / 'metrics/local.sqlite') + '?mode=ro', uri=True) as c:
        c.row_factory = sqlite3.Row
        bounds = c.execute('select min(seq),max(seq) from events').fetchone()
        rows = c.execute('select * from events where seq>? order by seq limit 2000', (cursor,)).fetchall()
        events, used, last = [], 0, cursor
        for r in rows:
            event = dict(version=1, event_id=r['event_id'], server=r['server'], at=r['at'], type=r['type'],
                         run_id=r['run_id'], uid=r['uid'], number=r['number'], data=json.loads(r['data']))
            size = len(json.dumps(event, ensure_ascii=False).encode())
            if events and used + size > 4 * 1024 * 1024:
                break
            events.append(event)
            used += size
            last = r['seq']
        return dict(version=1, server=cfg['server'], cursor=last,
                    epoch=meta(c, 'epoch'), high_watermark=bounds[1] or 0,
                    more=bool(events and last < (bounds[1] or 0)),
                    gap=bool(cursor and cursor < meta(c, 'expired_through', 0)),
                    collected_at=meta(c, 'collected_at', 0), installed_at=meta(c, 'installed_at', 0), events=events)


def import_export(c, peer, payload, now):
    if payload.get('version') != 1 or payload.get('server') != peer:
        raise ValueError('export identity mismatch')
    if now - payload.get('collected_at', 0) > 180 or payload.get('collected_at', 0) > now + 60:
        raise ValueError('stale collector')
    cursor = int(meta(c, 'cursor:' + peer, 0))
    previous_epoch = meta(c, 'epoch:' + peer)
    epoch = payload.get('epoch')
    if ((previous_epoch and epoch != previous_epoch)
            or cursor > payload.get('high_watermark', cursor)):
        setmeta(c, 'cursor:' + peer, 0)
        setmeta(c, 'epoch:' + peer, epoch)
        setmeta(c, 'gap:' + peer, now)
        return False
    if not isinstance(payload.get('cursor'), int) or payload['cursor'] < cursor:
        raise ValueError('invalid cursor')
    if not isinstance(payload.get('events'), list) or len(payload['events']) > 2000:
        raise ValueError('invalid export size')
    events = [valid_event(e, peer) for e in payload['events']]
    for e in events:
        insert(c, e)
    if payload.get('gap'):
        setmeta(c, 'gap:' + peer, now)
    for event in events:
        affected = min(event['at'], event['data'].get('started_at') or event['at'])
        setmeta(c, 'dirty_from', min(affected, meta(c, 'dirty_from', now)))
    setmeta(c, 'cursor:' + peer, payload['cursor'])
    setmeta(c, 'epoch:' + peer, epoch)
    setmeta(c, 'peer:' + peer, dict(ok=True, failures=0, collected_at=payload['collected_at'],
                                  installed_at=payload['installed_at'], checked_at=now))
    return True


def remote(peer, cursor):
    # No shell is used, and server host keys are pinned by the deployment.
    args = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
                        '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
                        '-o', 'UserKnownHostsFile=' + peer['known_hosts'], '-i', peer['key'],
                        '-p', str(peer.get('port', 22)), 'root@' + peer['host'], 'since ' + str(cursor)]
    if peer.get('bind_interface'):
        args[1:1] = ['-B', peer['bind_interface']]
    p = subprocess.run(args, capture_output=True, timeout=20)
    if p.returncode or len(p.stdout) > 8 * 1024 * 1024:
        raise RuntimeError('statistics export unavailable')
    return json.loads(p.stdout)


def sync(c, root, cfg, now, fetch=remote):
    for peer in cfg['metrics_peers']:
        name = peer['server']
        try:
            for _ in range(20):
                cursor = int(meta(c, 'cursor:' + name, 0))
                payload = export(root, cfg, cursor) if peer.get('local') else fetch(peer, cursor)
                imported = import_export(c, name, payload, now)
                c.commit()
                if not imported:
                    continue
                if not payload.get('more'):
                    break
            else:
                raise RuntimeError('export backlog exceeds this poll')
        except Exception:
            state = meta(c, 'peer:' + name, {})
            state.update(ok=False, failures=state.get('failures', 0) + 1, checked_at=now)
            setmeta(c, 'peer:' + name, state)
            c.commit()


def events(c, since=None, until=None, metadata_only=False):
    def decode(rows): return [dict(r, data=json.loads(r['data'])) for r in rows]
    metadata = decode(c.execute("select * from events where type in ('run','roster') order by at,seq"))
    if metadata_only: return metadata
    if since is None:
        return decode(c.execute('select * from events order by at,seq'))
    selected = {e['event_id']: e for e in metadata}
    for e in decode(c.execute('select * from events where at>=? and at<?', (since, until))):
        selected[e['event_id']] = e
    latest = {}
    pairs = set()
    for e in metadata:
        if e['type'] == 'run': latest[(e['server'], e['run_id'])] = e
        else: pairs.update((e['server'], a['uid']) for a in e['data']['accounts'])
    for e in latest.values():
        d = e['data']
        if d['started_at'] < until and (d.get('finished_at') or until) >= since:
            for span in decode(c.execute("select * from events where server=? and run_id=? and type in ('account_begin','account_end')",
                                         (e['server'], e['run_id']))):
                selected[span['event_id']] = span
    for server, uid in pairs:
        previous = c.execute("select * from events where server=? and uid=? and at<? and type in ('queue','disposition') order by at desc,seq desc limit 1",
                             (server, uid, since)).fetchone()
        if previous:
            e = decode([previous])[0]
            selected[e['event_id']] = e
    return sorted(selected.values(), key=lambda e: (e['at'], e['seq']))


def day_bounds(day):
    date = dt.date.fromisoformat(day)
    return (dt.datetime.combine(date, dt.time(), NY).timestamp(),
            dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), NY).timestamp())


def summarize(c, cfg, day, now, cached_events=None):
    lo, hi = day_bounds(day)
    if hi < now - 180 * 86400:
        old = c.execute('select payload from daily where day=?', (day,)).fetchone()
        if old:
            return json.loads(old[0])
    all_events = cached_events if cached_events is not None else events(c, lo, hi)
    peers = {p['server']: meta(c, 'peer:' + p['server'], {}) for p in cfg['metrics_peers']}
    server_rows = {s: dict(raw=0, collected=0, reused=0, reused_count=0, seconds=0,
                           missing=not st.get('ok') or now - st.get('collected_at', 0) > 600 or hi < now - 180 * 86400,
                           runs=[], accounts=[]) for s, st in peers.items()}
    runs = {}
    spans = {}
    account_rows = {}
    memberships = {}
    latest_roster = {}
    # Build assignment periods from snapshots, not from today's numbering.
    for e in all_events:
        if e['type'] != 'roster' or e['at'] >= hi:
            continue
        s = e['server']
        previous = latest_roster.get(s, {})
        current = {a['uid']: a['number'] for a in e['data']['accounts']}
        for uid in previous.keys() - current.keys():
            memberships[(s, uid)][-1]['end'] = e['at']
        for uid in current:
            if uid not in previous or previous[uid] != current[uid]:
                if uid in previous:
                    memberships[(s, uid)][-1]['end'] = e['at']
                memberships.setdefault((s, uid), []).append(dict(start=e['at'], end=hi, number=current[uid]))
        latest_roster[s] = current
    for (server, uid), periods in memberships.items():
        if server not in server_rows:
            continue
        relevant = [p for p in periods if p['start'] < hi and p['end'] > lo]
        if not relevant:
            continue
        row = account_rows.setdefault((server, uid), dict(uid=uid, number=relevant[-1]['number'],
              candidates=set(), success=set(), skipped=set(), deferred=set(), remaining=None,
              observed_at=None, seconds=0, complete=True, observation=False, has_run=False, issues=set()))
        row['observation'] = any(p['start'] >= lo or p['end'] < hi for p in relevant)
    # A real event is authoritative even if the minute-based roster crosses midnight later.
    for e in all_events:
        if e['server'] in server_rows and lo <= e['at'] < hi and e['uid'].isdecimal() and (e['server'], e['uid']) not in account_rows:
            account_rows[(e['server'], e['uid'])] = dict(uid=e['uid'], number=e['number'], candidates=set(),
                success=set(), skipped=set(), deferred=set(), remaining=None, observed_at=None, seconds=0,
                complete=True, observation=True, has_run=False, issues=set())
    for e in all_events:
        s, data = e['server'], e['data']
        if s not in server_rows:
            continue
        if e['type'] == 'run':
            runs[(s, e['run_id'])] = e
        elif e['type'] == 'account_begin':
            spans[(s, e['run_id'], data['span'])] = [e, None]
        elif e['type'] == 'account_end':
            key = (s, e['run_id'], data['span'])
            if key in spans:
                spans[key][1] = e
        if e['at'] >= hi:
            continue
        row = account_rows.get((s, e['uid']))
        if row and ('remaining' in data):
            row.update(remaining=data['remaining'], observed_at=e['at'])
        if not lo <= e['at'] < hi:
            continue
        if e['type'] == 'snapshot':
            server_rows[s]['raw'] += data['raw']
            server_rows[s]['collected'] += data['count']
        elif e['type'] == 'snapshot_reuse':
            server_rows[s]['reused'] += 1
            server_rows[s]['reused_count'] += data['count']
        if not row:
            continue
        if e['type'] == 'account_begin' and data.get('phase') == 'participation':
            row['participation_seen'] = True
        if e['type'] == 'candidates':
            row['candidates'].update(map(str, data['ids']))
        elif e['type'] == 'interaction' and data.get('success') is True:
            row['success'].add(str(data['dyid']))
        elif e['type'] == 'disposition' and data['outcome'] in ('skipped', 'deferred'):
            row[data['outcome']].add(str(data['dyid']))
    for (s, run_id), e in runs.items():
        data = e['data']
        start = data['started_at']
        end = data.get('finished_at') or now
        if start >= hi or end <= lo:
            continue
        server_rows[s]['seconds'] += max(0, min(end, hi) - max(start, lo))
        server_rows[s]['runs'].append(dict(run_id=run_id, started_at=start, status=data['status'], issues=data.get('issues', [])))
        for (server, uid), row in account_rows.items():
            if server == s:
                if start >= row.get('run_started_at', 0):
                    row['run_started_at'], row['run_status'] = start, data['status']
                account = next((a for a in data.get('accounts', []) if a['uid'] == uid), None)
                row['has_run'] |= account is not None
                if not data['complete'] or data['status'] not in ('success', 'partial'):
                    row['complete'] = False
                if account and account['status'] != 'success':
                    row['complete'] = False
                if account:
                    row['issues'].update(account.get('issues', []))
                row['issues'].update(data.get('issues', []))
    for (s, run_id, _), (begin, end) in spans.items():
        row = account_rows.get((s, begin['uid']))
        if not row:
            continue
        run = runs.get((s, run_id), {}).get('data', {})
        stop = end['at'] if end else min(now, run.get('finished_at') or now)
        if begin['at'] >= hi or stop <= lo:
            continue
        row['seconds'] += max(0, min(stop, hi) - max(begin['at'], lo))
        if not end or end['data']['status'] != 'success':
            row['complete'] = False
        if begin['data'].get('phase') == 'participation':
            row['has_run'] = True
            row['participation_seen'] = True
    combined = {}
    for (server, uid), row in account_rows.items():
        row['server'] = server
        row['complete'] &= row['has_run'] and not server_rows[server]['missing']
        row['observation'] |= peers[server].get('installed_at', hi) >= lo
        merged = combined.setdefault(uid, dict(uid=uid, candidates=set(), success=set(), complete=True,
                                               observation=False, servers=set(), issues=set(), skipped=set()))
        for key in ('candidates', 'success', 'issues', 'skipped'):
            merged[key].update(row[key])
        merged['complete'] &= row['complete']
        merged['observation'] |= row['observation']
        merged['servers'].add(server)
        server_rows[server]['accounts'].append(row)
    for uid, row in combined.items():
        # Any assignment transition on this day makes the account an observation sample.
        row['observation'] |= len(row['servers']) > 1
        row['eligible'] = (row['complete'] and not row['observation']
                           and bool((row['candidates'] - row['skipped']) | row['success']) and not row['issues'])
    def serial(value):
        if isinstance(value, set): return sorted(value)
        if isinstance(value, dict): return {k: serial(v) for k, v in value.items()}
        if isinstance(value, list): return [serial(v) for v in value]
        return value
    gaps = [server for server in peers if meta(c, 'gap:' + server, 0) > now - 365 * 86400]
    result = serial(dict(day=day, timezone='America/New_York', servers=server_rows, accounts=combined, historical_gaps=gaps))
    c.execute('insert or replace into daily values(?,?)', (day, json.dumps(result, ensure_ascii=False)))
    return result


def evaluate(c, day, report):
    lo, _ = day_bounds(day)
    previous_day = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
    previous = c.execute('select payload from daily where day=?', (previous_day,)).fetchone()
    previous = json.loads(previous[0]) if previous else {}
    issues, outcomes = [], []
    for uid, row in report['accounts'].items():
        if not row['eligible']:
            outcomes.append(dict(account=uid, status='failed', passed=[]))
            continue
        successes = len(row['success'])
        history = []
        for old in c.execute('select payload from daily where day<? order by day desc', (day,)):
            account = json.loads(old[0])['accounts'].get(uid)
            if account and account['eligible']:
                history.append(len(account['success']))
            if len(history) == 7:
                break
        baseline = statistics.median(history) if len(history) == 7 else None
        yesterday = previous.get('accounts', {}).get(uid, {})
        zero = yesterday.get('eligible') and not yesterday['success'] and successes == 0
        low = bool(baseline is not None and baseline >= 10 and yesterday.get('eligible')
                   and len(yesterday['success']) < baseline * .5 and successes < baseline * .5)
        active = c.execute('select baseline from anomalies where uid=?', (uid,)).fetchone()
        recovered = bool(active and (successes >= active[0] * .5 if active[0] is not None else successes > 0))
        if active and recovered:
            c.execute('delete from anomalies where uid=?', (uid,))
            active = None
            outcomes.append(dict(account=uid, status='success', passed=['daily']))
            continue
        if zero or low or active:
            if not active:
                c.execute('insert into anomalies values(?,?)', (uid, baseline if baseline and baseline >= 10 else None))
            problem = guard.issue('PARTICIPATION_LOW', 'daily', uid)
            problem['summary'] = '纽约日期 %s；成功 %s；七日基线 %s' % (day, successes, baseline if baseline is not None else '积累中')
            issues.append(problem)
            outcomes.append(dict(account=uid, status='failed', passed=[]))
        else:
            outcomes.append(dict(account=uid, status='failed', passed=[]))
    return issues, outcomes


def report_duration(seconds):
    seconds = int(max(0, seconds))
    hours, minutes = seconds // 3600, seconds % 3600 // 60
    return ('%d小时%d分' % (hours, minutes)) if hours else ('%d分%d秒' % (minutes, seconds % 60))


def report_server_state(values):
    if values['missing']: return '数据缺失'
    if not values['runs']: return '统计未覆盖'
    latest = max(values['runs'], key=lambda run: run.get('started_at', 0))
    if latest['status'] == 'running': return '仍在运行'
    if latest['status'] == 'cancelled': return '手动取消'
    if 'DISCOVERY_INCOMPLETE' in latest.get('issues', []): return '采集失败'
    if latest['status'] == 'failed': return '任务失败'
    if latest['status'] == 'partial': return '部分失败'
    return '已完成'


def render(report, identities=None):
    identities = identities or {}
    total = len({(uid, dyid) for uid, a in report['accounts'].items() for dyid in a['success']})
    states = {s: report_server_state(v) for s, v in report['servers'].items()}
    incomplete = any(not a['complete'] for a in report['accounts'].values()) or any(s != '已完成' for s in states.values())
    lines = [report['day'] + ' 抽奖参与日报', '统计范围：纽约时间 00:00—24:00', '',
             '已确认参与：%d 次%s' % (total, '（已确认下限，非完整全天总量）' if incomplete else ''),
             '有成功记录：%d 个账号' % sum(bool(a['success']) for a in report['accounts'].values()),
             '｜'.join(s + '：' + state for s, state in states.items())]
    for server, values in report['servers'].items():
        state = states[server]
        lines.extend(['', '━━ %s · %s ━━' % (server, state)])
        if state == '采集失败':
            lines.append('未进入参与阶段；完整快照未提交，部分采集量未计入正式统计。')
        elif state == '统计未覆盖':
            lines.append('没有受监测的抽奖运行记录；不能据此判断未运行或零参与。')
        elif state == '数据缺失':
            lines.append('同步缺失或数据过期；下列已确认记录仅供参考。')
        if values['collected'] or values['raw'] or values['reused']:
            lines.append('共享采集：原始%d → 正式快照%d；复用%d次（%d条）' %
                         (values['raw'], values['collected'], values['reused'], values['reused_count']))
        elif state not in ('采集失败', '统计未覆盖', '数据缺失'):
            lines.append('共享采集：本日未记录新快照提交或复用事件。')
        if values['runs']: lines.append('任务耗时：' + report_duration(values['seconds']) + '（含冷却，按日切分）')
        server_issues = {i for run in values['runs'] for i in run.get('issues', [])}
        for code in sorted(server_issues): lines.append('共同原因：' + guard.MESSAGES.get(code, code))
        for a in sorted(values['accounts'], key=lambda x: x['number'] or 0):
            owner = identities.get(a['uid'], {})
            clean = lambda text: ' '.join(str(text).split())[:64]
            label = '%s号 %s（%s）' % (a['number'], clean(owner.get('name') or '昵称未设置'), clean(owner.get('owner') or '归属未设置'))
            participating = a.get('participation_seen', False) or bool(a['candidates'] or a['success'])
            if values['missing']: status = '数据缺失'
            elif not values['runs']: status = '统计未覆盖'
            elif not participating:
                status = '未参与（采集失败）' if state == '采集失败' else '待首轮参与' if a['observation'] and not a['has_run'] else '未观测到参与'
            elif a['complete']: status = '已完成'
            else: status = {'running':'运行中','cancelled':'手动取消','failed':'任务失败','partial':'部分失败'}.get(a.get('run_status'), '统计不完整')
            if participating and a['complete'] and not ((set(a['candidates']) - set(a['skipped'])) | set(a['success'])): status += '，无可参与内容'
            flags = (' · 观察期' if a['observation'] else '') + (' · 统计不完整' if participating and not a['complete'] else '')
            lines.extend(['', label + '｜' + status + flags])
            if not participating and not (a['candidates'] or a['success'] or a['skipped'] or a['deferred']):
                lines.append('  参与数据：—（未观测，不填零）' + ('｜采集耗时 ' + report_duration(a['seconds']) if a['seconds'] else ''))
                for code in sorted(set(a['issues']) - server_issues): lines.append('  原因：' + guard.MESSAGES.get(code, code))
                continue
            known_zero = participating and a['complete'] and not values['missing']
            count = lambda items: str(len(items)) if items or known_zero else '—'
            lines.append('  成功 %s / 候选 %s｜跳过 %s｜曾暂缓 %s' % tuple(count(a[k]) for k in ['success','candidates','skipped','deferred']))
            remaining = str(a['remaining']) if participating and a['remaining'] is not None else '—'
            detail = '  剩余队列 ' + remaining
            if participating and a['observed_at']:
                detail += '（观测 ' + dt.datetime.fromtimestamp(a['observed_at'], NY).strftime('%m-%d %H:%M') + '）'
            if a['seconds']:
                detail += '｜处理 ' + report_duration(a['seconds']) + ('（采集阶段）' if not participating else '')
            lines.append(detail)
            for code in sorted(set(a['issues']) - server_issues): lines.append('  原因：' + guard.MESSAGES.get(code, code))
    lines.extend(['', '说明：— 表示未观测/未知，不代表 0。成功按账号＋动态去重；共享采集不按账号重复累计。',
                  '观察期不做下降判断；曾暂缓是过程记录，可能随后成功，不与成功数相加。'])
    if report.get('historical_gaps'): lines.append('历史明细存在同步缺口：' + '、'.join(report['historical_gaps']))
    return '\n'.join(lines)


def enqueue_notice(monitor, key, title, body, now):
    payload = dict(title=title, body=body, items=[], server='三台汇总', task='参与量日报', log_path='', run_id=key)
    monitor.execute('insert or ignore into outbox(id,kind,task,payload,created,due) values(?,?,?,?,?,?)',
                    (key, 'notice', 'participation', json.dumps(payload, ensure_ascii=False), now, now))
    monitor.commit()


def hub(root, cfg, now=None, fetch=remote):
    now = time.time() if now is None else now
    with connect(root / 'metrics/hub.sqlite') as c, guard.open_store(root) as monitor:
        monitor.execute("delete from outbox where task='participation' and kind='notice' and sent is not null and created<?", (now - 365 * 86400,))
        monitor.commit()
        sync(c, root, cfg, now, fetch)
        sync_issues, passed = [], []
        for peer in cfg['metrics_peers']:
            name = peer['server']
            state = meta(c, 'peer:' + name, {})
            if not state.get('ok') and state.get('failures', 0) >= 3:
                sync_issues.append(guard.issue('METRICS_SYNC_FAILED', name))
            elif state.get('ok'):
                passed.append(name)
        guard.ingest(monitor, dict(run_id='metrics-sync-' + str(now), task='metrics_sync', server='三台汇总',
                     status='partial' if sync_issues else 'success', issues=sync_issues,
                     accounts=[dict(account='global', status='failed', passed=passed)]), now)
        quality, quality_passed = [], []
        latest = {}
        for event in events(c, metadata_only=True):
            if event['type'] == 'run' and event['data']['status'] in ('success', 'partial'):
                previous = latest.get(event['server'])
                if not previous or event['data']['started_at'] >= previous['data']['started_at']:
                    latest[event['server']] = event
        for name, event in latest.items():
            if not event['data']['complete']:
                quality.append(guard.issue('METRICS_INCOMPLETE', name))
            else:
                quality_passed.append(name)
        # Only an explicitly complete subsequent run can recover a coverage fault.
        guard.ingest(monitor, dict(run_id='metrics-quality-' + str(now), task='metrics_quality', server='三台汇总',
                     status='partial', issues=quality,
                     accounts=[dict(account='global', status='failed', passed=quality_passed)]), now)
        local = dt.datetime.fromtimestamp(now, NY)
        if local.hour >= 9:
            day = (local.date() - dt.timedelta(days=1)).isoformat()
            installed = [meta(c, 'peer:' + p['server'], {}).get('installed_at', now) for p in cfg['metrics_peers']]
            if day_bounds(day)[1] <= min(installed or [now]):
                prune(c, now)
                return
            # Recompute the recent history after late imports, but never enqueue old reports/alerts.
            first = min(dt.date.fromisoformat(day) - dt.timedelta(days=8),
                        dt.datetime.fromtimestamp(meta(c, 'dirty_from', now), NY).date())
            first = max(first, local.date() - dt.timedelta(days=180))
            while first <= dt.date.fromisoformat(day):
                summarize(c, cfg, first.isoformat(), now)
                first += dt.timedelta(days=1)
            setmeta(c, 'dirty_from', now)
            report = summarize(c, cfg, day, now)
            if meta(c, 'evaluated:' + day) is None:
                issues, outcomes = evaluate(c, day, report)
                guard.ingest(monitor, dict(run_id='participation-evaluate-' + day, task='participation', server='三台汇总',
                             status='partial' if issues else 'success', issues=issues, accounts=outcomes), now)
                setmeta(c, 'evaluated:' + day, True)
            enqueue_notice(monitor, 'participation:daily:' + day, '三台抽奖参与量日报 ' + day,
                           render(report, guard.read(root / 'wins/config.json', {}).get('owners', {})), now)
        prune(c, now)


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['collect', 'hub', 'export', 'report'])
    p.add_argument('--root', required=True)
    p.add_argument('--day')
    a = p.parse_args()
    root = Path(a.root)
    cfg = guard.read(root / 'config.json', {})
    if a.mode == 'export':
        command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
        match = re.fullmatch(r'since ([0-9]{1,18})', command)
        if not match:
            print('statistics export only', file=__import__('sys').stderr)
            return 64
        print(json.dumps(export(root, cfg, int(match[1])), ensure_ascii=False))
        return 0
    with open(root / ('metrics-' + a.mode + '.lock'), 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        if a.mode == 'collect': collect(root, cfg)
        elif a.mode == 'hub': hub(root, cfg)
        else:
            with connect(root / 'metrics/hub.sqlite') as c:
                print(render(summarize(c, cfg, a.day, time.time()), guard.read(root / 'wins/config.json', {}).get('owners', {})))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
