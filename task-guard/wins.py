#!/usr/bin/env python3
"""Durable winner state, constrained host gateway and three-host aggregation."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import socket
import socketserver
import struct
import subprocess
import sys
import time
import uuid
import guard

LIMIT = 8 * 1024 * 1024
CATEGORIES = {'winner', 'review', 'reservation', 'ignored'}

def settings(root): return guard.read(root / 'wins/config.json', {})
def key(row): return str(row['accountUid']) + ':' + str(row['id'])
def fingerprint(value): return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()

def schema(c):
    c.executescript('''
      create table if not exists winner_records(key text primary key,payload text not null,updated real not null);
      create table if not exists winner_seen(id text primary key);
      create table if not exists winner_operations(id text primary key,payload text not null);
      create table if not exists winner_sync(server text primary key,at real,error text);
      create table if not exists winner_sources(path text primary key,digest text);
      create table if not exists winner_rosters(server text primary key,payload text);
    ''')

def records(c): return [json.loads(row[0]) for row in c.execute('select payload from winner_records')]
def get(c, identifier):
    row = c.execute('select payload from winner_records where key=?', (identifier,)).fetchone()
    return json.loads(row[0]) if row else None
def put(c, row, now):
    c.execute('insert or replace into winner_records values(?,?,?)', (key(row), json.dumps(row, ensure_ascii=False), now))

def roster(root):
    document = guard.read(root.parent / 'scripts/LotteryAutoScript/web_state/local-accounts.json', {})
    return [str(row['uid']) for row in document.get('accounts', []) if re.fullmatch(r'[1-9]\d*', str(row.get('uid', '')))]

def classify(root, rows):
    if not rows: return []
    script = root / 'current/lottery/lib/helper/winner_classifier.js'
    result = subprocess.run(['node', str(script)], input=json.dumps(rows, ensure_ascii=False),
                            capture_output=True, text=True, timeout=15)
    if result.returncode: raise ValueError('Winner classifier failed')
    parsed = json.loads(result.stdout)
    if len(parsed) != len(rows): raise ValueError('Invalid classification result')
    return parsed

def normalized(row, server, owner_map):
    uid, identifier = str(row.get('accountUid', '')), str(row.get('id', ''))
    if not re.fullmatch(r'[1-9]\d*', uid) or not re.fullmatch(r'[a-f0-9]{24}', identifier): raise ValueError('Invalid winner identity')
    source = row.get('source', 'private')
    if source not in ('private', 'at', 'reply'): raise ValueError('Invalid winner source')
    owner = owner_map.get(uid, {})
    fields = ['accountNumber', 'accountName', 'talkerId', 'senderUid', 'senderName', 'sourceMessageId',
              'messageSequence', 'messageTimestamp', 'content', 'link', 'mentions', 'category', 'reason', 'ruleVersion',
              'notifyCount', 'lastNotifiedAt', 'detectedAt', 'status', 'manual', 'dismissed', 'acknowledged',
              'generation', 'operationAt', 'operationId', 'sources']
    result = {k: row[k] for k in fields if k in row}
    result.update(id=identifier, accountUid=uid, source=source, server=server,
                  owner=owner.get('owner', '归属未设置'), accountName=row.get('accountName') or owner.get('name', ''))
    result['content'] = str(result.get('content', ''))[:65536]
    result['link'] = str(result.get('link', ''))
    if not re.match(r'^https?://', result['link']): result['link'] = ''
    result.setdefault('category', 'review'); result.setdefault('notifyCount', 0)
    result.setdefault('lastNotifiedAt', 0); result.setdefault('detectedAt', time.time() * 1000)
    result.setdefault('generation', 0)
    if result['category'] not in CATEGORIES:raise ValueError('Invalid winner category')
    for field in ['lastNotifiedAt','messageTimestamp','detectedAt','operationAt']:
        value=float(result.get(field,0) or 0)
        result[field]=max(0,value) if math.isfinite(value) else 0
    result['notifyCount']=max(0,int(result['notifyCount']));result['generation']=max(0,int(result['generation']))
    return result

def status_of(row):
    if row.get('dismissed'): return 'dismissed'
    if row.get('acknowledged'): return 'acknowledged'
    return {'winner': 'pending', 'review': 'review', 'reservation': 'reservation', 'ignored': 'ignored'}[row['category']]

def merge(c, incoming, now):
    existing = get(c, key(incoming))
    # Cross-source merge requires the same account, sender, activity and exact
    # normalized content. Merely sharing a prize or activity never merges records.
    activity = re.search(r'(?:opus/|t\.bilibili\.com/)(\d+)', incoming.get('link', ''))
    if not existing and activity:
        for candidate in records(c):
            other = re.search(r'(?:opus/|t\.bilibili\.com/)(\d+)', candidate.get('link', ''))
            if (candidate['accountUid'] == incoming['accountUid'] and candidate.get('senderUid') == incoming.get('senderUid')
                    and candidate.get('source') != incoming.get('source') and other and activity[1] == other[1]
                    and candidate.get('content', '').strip() == incoming.get('content', '').strip()):
                existing = candidate; incoming['id'] = candidate['id']; break
    if existing:
        if incoming.get('generation', 0) < existing.get('generation', 0):
            incoming['notifyCount'] = int(existing.get('notifyCount', 0))
            incoming['lastNotifiedAt'] = float(existing.get('lastNotifiedAt', 0))
        elif incoming.get('generation', 0) == existing.get('generation', 0):
            incoming['notifyCount'] = max(int(existing.get('notifyCount', 0)), int(incoming.get('notifyCount', 0)))
            incoming['lastNotifiedAt'] = max(float(existing.get('lastNotifiedAt', 0)), float(incoming.get('lastNotifiedAt', 0)))
        if existing.get('operationAt', 0) >= incoming.get('operationAt', 0):
            for name in ['manual', 'dismissed', 'operationAt', 'operationId', 'generation']:
                if name in existing: incoming[name] = existing[name]
        if incoming.get('manual') == 'confirmed': incoming.update(category='winner', reason='人工确认为中奖')
        incoming['acknowledged'] = bool(existing.get('acknowledged') or incoming.get('acknowledged'))
        incoming['sources'] = sorted(set(existing.get('sources', [existing['source']])) | set(incoming.get('sources', [incoming['source']])))
    incoming['status'] = status_of(incoming)
    put(c, incoming, now)
    return incoming

def reply(c, event, now):
    for row in records(c):
        if row['accountUid'] != str(event.get('accountUid')) or row.get('source') != 'private' or str(row.get('talkerId')) != str(event.get('talkerId')): continue
        old_seq, new_seq = str(row.get('messageSequence', '')), str(event.get('messageSequence', ''))
        after = int(new_seq) > int(old_seq) if old_seq.isdigit() and new_seq.isdigit() else float(event.get('messageTimestamp', 0)) > float(row.get('messageTimestamp', 0))
        if after:
            row.update(acknowledged=True, status='acknowledged'); put(c, row, now)

def compatible_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.stat() if path.exists() else None
    tmp = path.with_name(path.name + '.wins-new')
    with tmp.open('w') as f:
        json.dump(value, f, ensure_ascii=False); f.flush(); os.fsync(f.fileno())
    group = old.st_gid if old else path.parent.stat().st_gid
    if path.parent.name == 'lottery_info':
        state = path.parent.parent / 'web_state'
        if state.exists(): group = state.stat().st_gid
    os.chown(tmp, old.st_uid if old else os.getuid(), group); tmp.chmod(0o640); os.replace(tmp, path)

def compatibility_record(root, row):
    business = root.parent / 'scripts/LotteryAutoScript'
    p = business / 'lottery_info' / ('pending_wins_' + row['accountUid'] + '.json')
    document = guard.read(p, {'version': 1, 'accountUid': row['accountUid'], 'accountNumber': row.get('accountNumber', 1), 'records': []})
    if not any(str(r.get('id')) == row['id'] for r in document.get('records', [])):
        copy = dict(row, status='pending' if row['category'] == 'winner' else 'review' if row['category'] == 'review' else 'ignored')
        copy['talkerId'] = copy.get('talkerId') or copy.get('senderUid')
        document['records'].append(copy); compatible_write(p, document)

def collect(root, cfg, c, now):
    conf = settings(root); owner_map = conf.get('owners', {})
    business = root.parent / 'scripts/LotteryAutoScript'
    paths = list((business / 'lottery_info').glob('pending_wins_*.json'))
    dismissed = guard.read(business / 'web_state/dismissed-wins.json', {}).get('records', [])
    dismiss_keys = {str(row.get('accountUid')) + ':' + str(row.get('recordId')) for row in dismissed}
    candidates, replies = [], []
    local_uids = set(roster(root))
    for p in paths:
        if p.stat().st_size > 4 * 1024 * 1024: raise ValueError('Winner input exceeds size limit')
        document = json.loads(p.read_text())
        if not isinstance(document.get('records'), list): raise ValueError('Invalid legacy winner ledger')
        for record in document['records']:
            row = dict(record, accountUid=record.get('accountUid') or document.get('accountUid', ''))
            if str(row['accountUid']) not in local_uids: continue
            row['source'] = row.get('source', 'private')
            row['acknowledged'] = row.get('acknowledged') or row.get('status') == 'acknowledged'
            if row.get('status') == 'ignored': row['legacyIgnored'] = True
            if key(row) in dismiss_keys: row.update(dismissed=True)
            candidates.append(row)
    journal = root / 'wins/journal'
    for p in sorted(journal.glob('*.jsonl')):
        digest = hashlib.sha256(p.read_bytes()).hexdigest()
        old = c.execute('select digest from winner_sources where path=?', (p.name,)).fetchone()
        if old and old[0] == digest: continue
        with p.open() as f:
            for line in f:
                if not line.endswith('\n'): break
                event = json.loads(line); identity = fingerprint(event)
                if c.execute('select 1 from winner_seen where id=?', (identity,)).fetchone(): continue
                if event.get('kind') == 'reply': replies.append(event['record'])
                elif event.get('kind') == 'message': candidates.append(event['record'])
                else: raise ValueError('Invalid winner event')
                c.execute('insert into winner_seen values(?)', (identity,))
        c.execute('insert or replace into winner_sources values(?,?)', (p.name, digest))
    aliases={}
    for saved in records(c):aliases.setdefault(saved['accountUid'],set()).add(saved.get('accountName',''))
    for row in candidates:
        uid=str(row.get('accountUid',''));known=set(aliases.get(uid,set()))
        known.add(owner_map.get(uid,{}).get('name',''))
        row['aliases']=sorted(known|set(row.get('aliases',[])))
    classifications = classify(root, candidates)
    if not c.in_transaction:c.execute('begin immediate')
    for row, classification in zip(candidates, classifications):
        row.update(classification)
        if row.get('legacyIgnored') and row['category'] != 'reservation': row['category'] = 'ignored'
        n = normalized(row, cfg['server'], owner_map)
        merged = merge(c, n, now)
        compatibility_record(root, merged)
    for event in replies: reply(c, event, now)
    active = [dict(accountUid=row['accountUid'], talkerId=row.get('talkerId')) for row in records(c)
              if row.get('server') == cfg['server'] and row['status'] in ('pending', 'review') and row['source'] == 'private']
    guard.atomic(root / 'wins/active.json', active)
    c.execute('insert or replace into winner_rosters values(?,?)', (cfg['server'], json.dumps(roster(root))))
    c.execute('insert or replace into winner_sync values(?,?,null)', (cfg['server'],now))
    c.commit()

def eligible(row): return row and row['status'] in ('pending', 'review') and row['category'] in ('winner', 'review')

def notice(row):
    label = '明确中奖待处理' if row['category'] == 'winner' else '疑似中奖待确认'
    title = '[' + row['server'] + '] ' + row.get('owner', '归属未设置') + ' / ' + (row.get('accountName') or row['accountUid']) + ' / ' + label
    body = '\n\n'.join(['归属：' + row.get('owner', '归属未设置'),
        '账号：%s（UID %s）' % (row.get('accountName') or '昵称暂未获取', row['accountUid']),
        '来源：' + row['source'], '判定：' + row.get('reason', ''),
        '消息时间：' + time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(float(row.get('messageTimestamp', 0)))),
        row.get('content', ''), row.get('link', ''), '管理：https://zj.niichi.me'])
    return dict(title=title, body=body, items=[], server=row['server'], task='中奖通知', log_path='', run_id='', winner_key=key(row), generation=row.get('generation', 0))

def enqueue(c, root, now):
    if not settings(root).get('hub'): return
    active_uids = set()
    for item in c.execute('select payload from winner_rosters'): active_uids.update(json.loads(item[0]))
    for row in records(c):
        if not eligible(row) or row['accountUid'] not in active_uids: continue
        # A stale remote source never becomes a false zero or a fresh prize alert.
        sync = c.execute('select at,error from winner_sync where server=?', (row['server'],)).fetchone()
        if row['server'] != guard.read(root / 'config.json')['server'] and (not sync or sync[1] or now - sync[0] > 180): continue
        if row['category'] == 'review' and row.get('notifyCount', 0): continue
        if row.get('notifyCount', 0) and now * 1000 - row.get('lastNotifiedAt', 0) < 7200000: continue
        identifier = 'wins:' + key(row) + ':' + str(row.get('generation', 0)) + ':' + str(row.get('notifyCount', 0))
        pending = c.execute("select 1 from outbox where kind='wins' and sent is null and json_extract(payload,'$.winner_key')=?", (key(row),)).fetchone()
        if pending: continue
        c.execute('insert or ignore into outbox(id,kind,task,payload,created,due) values(?,?,?,?,?,?)',
                  (identifier, 'wins', 'wins', json.dumps(notice(row), ensure_ascii=False), now, now))
    c.commit()

def before_send(c, payload, now=None):
    schema(c)
    row = get(c, payload.get('winner_key', ''))
    active=set()
    for item in c.execute('select payload from winner_rosters'):active.update(json.loads(item[0]))
    valid=eligible(row) and row['accountUid'] in active and row.get('generation', 0) == payload.get('generation', 0)
    if not valid:return False
    sync=c.execute('select at,error from winner_sync where server=?',(row['server'],)).fetchone()
    if not sync or sync[1] or (now if now is not None else time.time())-sync[0]>180:return 'defer'
    return True

def delivered(c, payload, now):
    row = get(c, payload['winner_key'])
    if not row: return
    row['notifyCount'] = int(row.get('notifyCount', 0)) + 1
    row['lastNotifiedAt'] = now * 1000
    put(c, row, now)

def tick(root, cfg, c, now):
    with (root / 'wins.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return False
        schema(c); collect(root, cfg, c, now)
    # The separate hub unit performs network synchronization; supervision never waits on SSH.
    if settings(root).get('hub'): enqueue(c, root, now)
    return True

def ssh(peer, command, body=None):
    args = ['ssh', '-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
            '-o', 'UserKnownHostsFile=' + peer['known_hosts'], '-i', peer['key'],
            'root@' + peer['host'], command]
    if peer.get('bind_interface'): args[1:1] = ['-B', peer['bind_interface']]
    result = subprocess.run(args, input='' if body is None else json.dumps(body), capture_output=True, text=True, timeout=12)
    if result.returncode or len(result.stdout) > LIMIT: raise ValueError('Remote winner gateway unavailable')
    return json.loads(result.stdout)

def export(root, cfg, c, now):
    local = set(roster(root))
    state=c.execute('select at,error from winner_sync where server=?',(cfg['server'],)).fetchone()
    return dict(version=1, server=cfg['server'], at=state[0] if state else 0, complete=bool(state and not state[1]), roster=sorted(local),
                records=[row for row in records(c) if row['server'] == cfg['server'] and row['accountUid'] in local])

def sync(root, cfg, c, now, transport=ssh):
    for peer in settings(root).get('peers', []):
        try:
            payload = transport(peer, 'export')
            if payload.get('version') != 1 or payload.get('complete') is not True or payload.get('server') != peer['server'] or not isinstance(payload.get('records'), list): raise ValueError('Invalid winner export')
            if abs(float(payload['at']) - now) > 180: raise ValueError('Stale winner export')
            if not isinstance(payload.get('roster'),list) or not all(re.fullmatch(r'[1-9]\d*',str(uid)) for uid in payload['roster']):raise ValueError('Invalid winner roster')
            rows=[normalized(row,peer['server'],settings(root).get('owners',{})) for row in payload['records']]
            if any(row['accountUid'] not in payload['roster'] for row in rows):raise ValueError('Winner account outside roster')
            if not c.in_transaction:c.execute('begin immediate')
            for row in rows: merge(c,row,now)
            c.execute('insert or replace into winner_rosters values(?,?)', (peer['server'], json.dumps(payload['roster'])))
            c.execute('insert or replace into winner_sync values(?,?,null)', (peer['server'], now))
        except (ValueError, KeyError, OSError, subprocess.SubprocessError):
            c.rollback()
            c.execute('insert into winner_sync values(?,0,?) on conflict(server) do update set error=excluded.error', (peer['server'], '同步失败，保留上次数据'))
        c.commit()

def snapshot(root, cfg, c, request, now):
    if request.get('status', 'pending') not in ('pending', 'review', 'reservation', 'dismissed', 'acknowledged', 'ignored', 'all'): raise ValueError('Invalid status')
    all_rows = records(c); active_uids = set()
    for item in c.execute('select payload from winner_rosters'): active_uids.update(json.loads(item[0]))
    all_rows = [row for row in all_rows if row['accountUid'] in active_uids]
    filters = {'owner', 'server', 'accountUid', 'category'}
    for field in filters:
        if request.get(field): all_rows = [row for row in all_rows if str(row.get(field)) == str(request[field])]
    counts = {state: sum(row['status'] == state for row in all_rows) for state in ['pending', 'review', 'reservation', 'dismissed', 'acknowledged', 'ignored']}
    counts['dismissed'] += counts['acknowledged'] + counts['ignored']
    desired = request.get('status', 'pending')
    rows = all_rows if desired == 'all' else [row for row in all_rows if row['status'] in (('dismissed', 'acknowledged', 'ignored') if desired == 'dismissed' else (desired,))]
    warnings, servers = [], []
    for peer in settings(root).get('peers', []):
        item = c.execute('select at,error from winner_sync where server=?', (peer['server'],)).fetchone()
        stale = not item or bool(item[1]) or now - item[0] > 180
        servers.append(dict(server=peer['server'], syncedAt=item[0] if item else 0, stale=stale))
        if stale: warnings.append(peer['server'] + '数据未及时同步，当前显示上次缓存；该服务器操作暂不可用')
    rows=[dict(row, recordId=row['id'], sourceStatus='review' if row['category']=='review' else 'pending') for row in rows]
    owners=settings(root).get('owners',{})
    options={field: sorted({str(row.get(field, '')) for row in records(c) if row.get(field)}) for field in filters}
    options['accountUid']=sorted(active_uids,key=int)
    options['owner']=sorted({owners.get(uid,{}).get('owner','归属未设置') for uid in active_uids})
    options['server']=sorted({cfg['server']}|{p['server'] for p in settings(root).get('peers',[])})
    return dict(records=sorted(rows, key=lambda row: float(row.get('messageTimestamp', 0)), reverse=True), counts=counts, warnings=warnings,
                servers=servers, syncedAt=now, options=options, accountLabels={uid:owners.get(uid,{}).get('name',uid)+' · UID '+uid for uid in active_uids})

def action(root, cfg, c, request, now):
    with (root/'wins-operation.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return apply_action(root,cfg,c,request,now)

def apply_action(root, cfg, c, request, now):
    if set(request) != {'accountUid', 'recordId', 'operationId', 'action'}: raise ValueError('Invalid action fields')
    uid, identifier = str(request.get('accountUid', '')), str(request.get('recordId', ''))
    operation = str(request.get('operationId', ''))
    if not re.fullmatch(r'[1-9]\d*', uid) or not re.fullmatch(r'[a-f0-9]{24}', identifier) or not re.fullmatch(r'[a-zA-Z0-9-]{16,64}', operation): raise ValueError('Invalid action identity')
    method = request.get('action')
    if method not in ('confirm', 'dismiss', 'restore'): raise ValueError('Invalid action')
    previous = c.execute('select payload from winner_operations where id=?', (operation,)).fetchone()
    if previous:
        saved = json.loads(previous[0])
        if saved['request'] != request: raise ValueError('Operation ID reused with different action')
        return saved['response']
    row = get(c, uid + ':' + identifier)
    if not row: raise ValueError('Record not found')
    if row['server'] != cfg['server']:
        peer = next((p for p in settings(root).get('peers', []) if p['server'] == row['server']), None)
        if not peer: raise ValueError('Record source unavailable')
        state = c.execute('select at,error from winner_sync where server=?', (row['server'],)).fetchone()
        if not state or state[1] or now - state[0] > 180: raise ValueError('Record source is offline')
        response = ssh(peer, 'action', request)
        if response.get('ok') is not True: raise ValueError('Remote action not committed')
        if not c.in_transaction:c.execute('begin immediate')
        row = merge(c, normalized(response['record'], row['server'], settings(root).get('owners', {})), now)
    else:
        if not c.in_transaction:c.execute('begin immediate')
        row=get(c,uid+':'+identifier)
        if uid not in roster(root) and uid not in settings(root).get('owners', {}): raise ValueError('Unknown account')
        if method == 'confirm':
            if row['category'] != 'review' and row.get('manual') != 'confirmed': raise ValueError('Only suspected records can be confirmed')
            if row.get('manual') != 'confirmed': row.update(category='winner', manual='confirmed', reason='人工确认为中奖', generation=row.get('generation', 0) + 1, notifyCount=0, lastNotifiedAt=0, dismissed=False)
        elif method == 'dismiss': row['dismissed'] = True
        else:
            if row.get('dismissed'): row['generation'] = row.get('generation', 0) + 1
            row['dismissed'] = False
        row.update(operationAt=now, operationId=operation); row['status'] = status_of(row)
        # Commit the compatible dismissal ledger first. Failed writes never report success.
        ledger = root.parent / 'scripts/LotteryAutoScript/web_state/dismissed-wins.json'
        with (root / 'wins-action.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            document = guard.read(ledger, {'version': 1, 'records': []})
            entries = [entry for entry in document['records'] if str(entry.get('accountUid')) + ':' + str(entry.get('recordId')) != key(row)]
            if row.get('dismissed'): entries.append(dict(accountUid=uid, recordId=identifier, dismissedAt=now * 1000, reason='manual'))
            document['records'] = entries; compatible_write(ledger, document)
        put(c, row, now)
    response = dict(ok=True, record=row)
    c.execute('insert into winner_operations values(?,?)', (operation, json.dumps(dict(request=request, response=response), ensure_ascii=False)))
    c.commit(); return response

def serve(root):
    import pwd
    viewer=pwd.getpwnam('qinglong-log-viewer')
    address='/run/qinglong-wins/gateway.sock'
    if os.path.exists(address):os.unlink(address)
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            connection=None
            try:
                _,uid,_=struct.unpack('3i',self.request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                if uid not in (0,viewer.pw_uid):raise ValueError('Unexpected local caller')
                raw=self.rfile.readline(16385)
                if len(raw)>16384 or not raw.endswith(b'\n'):raise ValueError('Invalid request size')
                request=json.loads(raw);cfg=guard.read(root/'config.json');now=time.time()
                if not isinstance(request,dict):raise ValueError('Invalid local request')
                connection=guard.open_store(root);schema(connection)
                if request.get('method')=='list':
                    if set(request)-{'method','status','owner','server','accountUid','category'}:raise ValueError('Invalid filter fields')
                    output=snapshot(root,cfg,connection,request,now)
                elif request.get('method')=='action':
                    request.pop('method');output=action(root,cfg,connection,request,now)
                else:raise ValueError('Invalid local operation')
                encoded=json.dumps(output,ensure_ascii=False).encode()
                if len(encoded)>LIMIT:raise ValueError('Winner response limit')
            except (ValueError,KeyError,OSError,sqlite3.Error,subprocess.SubprocessError):
                encoded=json.dumps({'error':'中奖操作未完成，请刷新后重试'},ensure_ascii=False).encode()
            finally:
                if connection:connection.close()
            self.wfile.write(encoded+b'\n')
    class Server(socketserver.ThreadingUnixStreamServer):daemon_threads=True
    with Server(address,Handler) as server:
        os.chown(address,0,viewer.pw_gid);os.chmod(address,0o660)
        server.serve_forever()

def main():
    p = argparse.ArgumentParser(); p.add_argument('mode', choices=['agent', 'gateway', 'hub', 'collect','serve'])
    p.add_argument('--root', required=True); a = p.parse_args(); root = Path(a.root)
    cfg = guard.read(root / 'config.json'); now = time.time()
    (root / 'wins').mkdir(mode=0o700, exist_ok=True)
    if a.mode=='serve':serve(root);return
    with (root / 'wins.lock').open('a') as lock:
        c = guard.open_store(root); schema(c)
        if a.mode in ('hub', 'collect'):
            fcntl.flock(lock, fcntl.LOCK_EX)
            collect(root, cfg, c, now); fcntl.flock(lock, fcntl.LOCK_UN)
            if a.mode == 'hub': sync(root, cfg, c, now); enqueue(c, root, now)
            c.close(); return
        if a.mode == 'agent':
            command = os.environ.get('SSH_ORIGINAL_COMMAND', '')
            if command not in ('export', 'action'): raise ValueError('Only fixed winner commands are supported')
            if command == 'export': output = export(root, cfg, c, now)
            else: output = action(root, cfg, c, json.loads(sys.stdin.read(16385)), now)
        else:
            request = json.loads(sys.stdin.read(16385))
            if request.get('method') == 'list': output = snapshot(root, cfg, c, request, now)
            elif request.get('method') == 'action':
                request.pop('method'); output = action(root, cfg, c, request, now)
            else: raise ValueError('Invalid gateway operation')
        print(json.dumps(output, ensure_ascii=False)); c.close()

if __name__ == '__main__':
    os.umask(0o077); sys.dont_write_bytecode = True
    try: main()
    except (ValueError, KeyError, OSError, sqlite3.Error, subprocess.SubprocessError):
        print(json.dumps({'error': '中奖记录操作未完成，请刷新后重试'}), file=sys.stderr); raise SystemExit(64)
