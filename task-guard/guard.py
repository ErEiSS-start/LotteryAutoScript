#!/usr/bin/env python3
"""Structured QingLong task supervision. No business actions are retried here."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
import pathlib
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

VERSION = 1
RETRY = (300, 900, 3600)
MESSAGES = {
    'NO_ACCOUNTS': '没有可用账号', 'CONFIG_INVALID': '启动配置错误',
    'LOGIN_FAILED': '账号登录检查失败', 'COOKIE_INVALID': '账号登录已失效',
    'ACCOUNT_EXCEPTION': '账号执行异常', 'ACCOUNT_STOPPED': '账号异常停止',
    'DISCOVERY_INCOMPLETE': '采集未生成完整有效快照',
    'CHECK_INCOMPLETE': '中奖扫描未完整完成',
    'FOLLOW_LIST_INCOMPLETE': '关注列表未完整读取',
    'COMMENT_REQUEST_REJECTED': '评论请求被拒绝（-412）',
    'COMMENT_ACCOUNT_UNVERIFIED': '账号未转正（-107）',
    'COMMENT_LIMIT': '达到评论发送上限，候选保留到下次任务',
    'CLEAR_FAILED': '清理请求重试耗尽', 'DAILY_FAILED': '每日升级关键步骤失败',
    'WATCH_FAILED': '观看视频失败', 'DONATE_FAILED': '投币接口异常',
    'RESULT_MISSING': '任务结束但没有可靠执行结果',
    'PROCESS_EXIT': '任务进程非正常退出', 'PROCESS_LOST': '执行进程异常消失',
    'EXECUTOR_STOPPED': '执行容器已停止', 'OOM_KILLED': '有证据表明进程被内存不足终止',
    'UNCAUGHT_EXCEPTION': '未处理的程序异常', 'START_FAILED': '任务启动失败',
    'METRICS_SYNC_FAILED': '统计同步连续三次失败',
    'PARTICIPATION_LOW': '参与量连续零参与或明显下降',
    'WINS_IMPORT_FAILED': '中奖记录导入未完成，已保留原始记录',
    'METRICS_INCOMPLETE': '参与量统计记录不完整',
}


def atomic(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(value, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def read(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def ticks(pid):
    try:
        fields = pathlib.Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] if fields[0] not in ('Z', 'X') else None
    except (OSError, IndexError):
        return None


def ql_instance(data, cron_id, instance_id=None):
    try:
        c = sqlite3.connect('file:' + str(data / 'db/database.sqlite') + '?mode=ro', uri=True)
        c.row_factory = sqlite3.Row
        if instance_id:
            row = c.execute('select * from RunningInstances where id=? and cron_id=?', (instance_id, cron_id)).fetchone()
        else:
            row = c.execute('select * from RunningInstances where cron_id=? order by id desc limit 1', (cron_id,)).fetchone()
        c.close()
        return dict(row) if row else None
    except sqlite3.Error:
        return None


def issue(code, stage='runtime', account='global', number=None):
    return dict(code=code, stage=stage, account=str(account), number=number, status='failed')


def sanitize_result(value):
    if not isinstance(value, dict) or value.get('version') != VERSION or not isinstance(value.get('accounts'), list):
        return None
    accounts = []
    for row in value['accounts']:
        if not isinstance(row, dict):
            return None
        account = str(row.get('account', 'global'))
        if account != 'global' and not account.isdecimal():
            account = 'global'
        records = []
        for item in row.get('issues', []):
            if item.get('code') in MESSAGES:
                records.append(issue(item['code'], str(item.get('stage', 'runtime'))[:40], account, row.get('number')))
        if row.get('status') == 'failed' and not records:
            records.append(issue('ACCOUNT_EXCEPTION', 'runtime', account, row.get('number')))
        accounts.append(dict(account=account, number=row.get('number'),
                             status='failed' if records else 'success', issues=records,
                             warnings=[str(w)[:60] for w in row.get('warnings', []) if str(w).replace('_', '').isalnum()],
                             passed=[str(s)[:40] for s in row.get('passed', [])]))
    global_passed = value.get('passed', [])
    if isinstance(global_passed, list) and 'discovery' in global_passed:
        accounts.append(dict(account='global', number=None, status='success', issues=[], passed=['discovery'], warnings=[]))
    for item in value.get('issues', []):
        if item.get('code') in MESSAGES:
            accounts.append(dict(account='global', number=None, status='failed',
                                 issues=[issue(item['code'], str(item.get('stage', 'runtime'))[:40])], passed=[], warnings=[]))
    return dict(version=VERSION, accounts=accounts, complete=bool(value.get('complete')))


def summarize(result, exit_code):
    if result is None or not result.get('complete'):
        code = 'RESULT_MISSING' if exit_code == 0 else 'PROCESS_EXIT'
        return 'failed', [issue(code)], []
    failures = [i for a in result['accounts'] for i in a['issues']]
    successes = [a for a in result['accounts'] if a['status'] == 'success' and a['account'] != 'global']
    if exit_code not in (0, 1, 2) and not failures:
        failures.append(issue('PROCESS_EXIT'))
    if failures:
        return ('partial' if successes and not any(i['account'] == 'global' for i in failures) else 'failed'), failures, result['accounts']
    if not successes:
        return 'failed', [issue('NO_ACCOUNTS', 'startup')], result['accounts']
    if exit_code:
        return 'failed', [issue('PROCESS_EXIT')], result['accounts']
    return 'success', [], result['accounts']


def run_task(root, cfg, task, command):
    if task not in cfg['tasks'] or not command:
        return 1
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = open(root / (task + '.lock'), 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('[任务跳过] 同一任务仍在运行；没有启动重复进程', flush=True)
        inst = ql_instance(root.parent, cfg['tasks'][task]['cron_id']) or {}
        run_id = uuid.uuid4().hex
        atomic(root / 'runs' / (run_id + '.json'), dict(version=1, run_id=run_id, task=task,
               server=cfg['server'], cron_id=cfg['tasks'][task]['cron_id'], instance_id=inst.get('id'),
               log_path=inst.get('log_path', ''), status='cancelled', started_at=time.time(),
               finished_at=time.time(), cancellation='already_running', accounts=[], issues=[], exit_code=0))
        return 0
    run_id = uuid.uuid4().hex
    data = root.parent
    cron_id = cfg['tasks'][task]['cron_id']
    instance = ql_instance(data, cron_id)
    state = dict(version=VERSION, run_id=run_id, task=task, server=cfg['server'],
                 cron_id=cron_id, instance_id=instance.get('id') if instance else None,
                 log_path=instance.get('log_path', '') if instance else '',
                 started_at=time.time(), heartbeat=time.time(), status='running',
                 supervisor_pid=os.getpid(), supervisor_ticks=ticks(os.getpid()))
    state_path = root / 'runs' / (run_id + '.json')
    result_path = root / 'results' / (run_id + '.json')
    result_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    atomic(state_path, state)
    env = os.environ.copy()
    env.update(TASK_GUARD_RESULT_PATH=str(result_path), TASK_GUARD_RUN_ID=run_id, TASK_GUARD_TASK_KEY=task)
    if cfg.get('wins_enabled') and task == 'check':
        env.update(TASK_WINS_FILE=str(root / 'wins/journal' / (run_id + '.jsonl')),
                   TASK_WINS_ACTIVE=str(root / 'wins/active.json'), TASK_WINS_CONFIG=str(root / 'wins/config.json'))
    if cfg.get('metrics_enabled') and task == 'start':
        state['metrics_enabled'] = True
        atomic(state_path, state)
        env.update(TASK_METRICS_FILE=str(root / 'metrics' / 'journal' / (run_id + '.jsonl')),
                   TASK_METRICS_SERVER=cfg['server'])
    received = []
    child = None
    def forward(sig, _frame):
        received.append(sig)
        if child is not None and child.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, sig)
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, forward)
    try:
        child = subprocess.Popen(command, env=env, start_new_session=True)
        state.update(child_pid=child.pid, child_ticks=ticks(child.pid))
        atomic(state_path, state)
        next_beat = time.monotonic() + 30
        while child.poll() is None:
            if time.monotonic() >= next_beat:
                state['heartbeat'] = time.time()
                atomic(state_path, state)
                next_beat = time.monotonic() + 30
            time.sleep(0.25)
        raw = child.returncode
        exit_code = raw if raw >= 0 else 128 - raw
        result = sanitize_result(read(result_path))
        status, failures, accounts = summarize(result, exit_code)
        if received or raw < 0 or exit_code in (130, 137, 143):
            state['interrupted'] = True
        if raw >= 0 and raw in (0, 1, 2):
            exit_code = {'success': 0, 'partial': 2, 'failed': 1}[status]
    except OSError:
        exit_code, status, failures, accounts = 1, 'failed', [issue('START_FAILED', 'startup')], []
    state.update(status=status, issues=failures, accounts=accounts, exit_code=exit_code,
                 finished_at=time.time(), heartbeat=time.time())
    for row in accounts:
        row.update(started_at=state['started_at'], finished_at=state['finished_at'])
    atomic(state_path, state)
    for failure in failures:
        print('[任务失败原因] 账号%s / %s / %s (%s)' % (failure.get('number') or failure['account'],
              failure['stage'], MESSAGES.get(failure['code'], '任务异常'), failure['code']), flush=True)
    print('[任务结果] ' + json.dumps(dict(status=status, exit_code=exit_code,
          failed_accounts=sorted(set(i['account'] for i in failures)), run_id=run_id), ensure_ascii=False), flush=True)
    return exit_code


def open_store(root):
    c = sqlite3.connect(root / 'monitor.sqlite', timeout=30)
    c.row_factory = sqlite3.Row
    c.executescript('''
      create table if not exists processed(run_id text primary key);
      create table if not exists faults(task text,account text,stage text,code text,number integer,
        notified integer default 0, active integer default 1, primary key(task,account,stage,code));
      create table if not exists outbox(id text primary key,kind text,task text,payload text,
        created real,due real,attempts integer default 0,sent real);
    ''')
    return c


def ingest(c, state, now):
    if state['status'] == 'running':
        return
    if c.execute('select 1 from processed where run_id=?', (state['run_id'],)).fetchone():
        return
    if state['status'] == 'cancelled':
        c.execute('insert into processed values(?)', (state['run_id'],))
        c.commit()
        return
    task = state['task']
    fresh = []
    current = {(i['account'], i['stage'], i['code']) for i in state.get('issues', [])}
    for i in state.get('issues', []):
        key = (task, i['account'], i['stage'], i['code'])
        row = c.execute('select * from faults where task=? and account=? and stage=? and code=?', key).fetchone()
        if not row or not row['active']:
            fresh.append(i)
            c.execute('insert or replace into faults values(?,?,?,?,?,0,1)', (*key, i.get('number')))
    recovered = []
    account_results = {a['account']: a for a in state.get('accounts', [])}
    for row in c.execute('select * from faults where task=? and active=1', (task,)).fetchall():
        key = (row['account'], row['stage'], row['code'])
        if key in current:
            continue
        account = account_results.get(row['account'])
        passed = bool(account and (account['status'] == 'success' or row['stage'] in account.get('passed', [])))
        if row['stage'] == 'comment':
            passed = bool(account and 'comment' in account.get('passed', []))
        if row['account'] == 'global':
            stage_passed = ('global', row['stage']) in {
                (a['account'], s) for a in state.get('accounts', []) for s in a.get('passed', [])}
            passed = stage_passed or (row['code'] != 'DISCOVERY_INCOMPLETE' and state['status'] == 'success')
        specific_comment_failure = row['code'] == 'ACCOUNT_STOPPED' and any(
            account == row['account'] and stage == 'comment' for account, stage, _ in current)
        if specific_comment_failure:
            passed = False
        changed = specific_comment_failure or any(i['account'] == row['account'] and i['stage'] == row['stage'] for i in fresh)
        if not passed and not changed:
            continue
        c.execute('update faults set active=0 where task=? and account=? and stage=? and code=?',
                  (task, *key))
        if passed and row['notified']:
            recovered.append(dict(row))
    for kind, items in [('failure', fresh), ('recovery', recovered)]:
        if not items:
            continue
        event_id = state['run_id'] + ':' + kind
        payload = dict(items=items, log_path=state.get('log_path', ''), server=state.get('server', ''),
                       task=task, run_id=state['run_id'])
        c.execute('insert or ignore into outbox(id,kind,task,payload,created,due) values(?,?,?,?,?,?)',
                  (event_id, kind, task, json.dumps(payload), now, now))
    c.execute('insert into processed values(?)', (state['run_id'],))
    c.commit()


def push_config(data):
    c = sqlite3.connect('file:' + str(data / 'db/database.sqlite') + '?mode=ro', uri=True)
    rows = c.execute("select name,value from Envs where status=0 and name in ('PUSH_PLUS_TOKEN','PUSH_PLUS_USER')").fetchall()
    c.close()
    return dict(rows)


def push(data, title, body):
    settings = push_config(data)
    token = settings.get('PUSH_PLUS_TOKEN', '').strip()
    if not token:
        return False
    payload = dict(token=token, title=title, content=body, template='txt')
    if settings.get('PUSH_PLUS_USER'):
        payload['topic'] = settings['PUSH_PLUS_USER']
    req = urllib.request.Request('https://www.pushplus.plus/send', data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response).get('code') == 200


def drain(c, data, now, sender=push):
    for row in c.execute("select * from outbox where sent is null and due<=? order by case when kind in ('failure','recovery') then 0 else 1 end,created limit 10", (now,)).fetchall():
        p = json.loads(row['payload'])
        if row['kind'] == 'wins':
            import wins
            eligibility = wins.before_send(c, p, now)
            if eligibility == 'defer':
                c.execute('update outbox set due=? where id=?',(now+60,row['id']));c.commit();continue
            if not eligibility:
                c.execute('update outbox set sent=?,kind=? where id=?', (now, 'wins_cancelled', row['id']))
                c.commit(); continue
            p=wins.notice(wins.get(c,p['winner_key']))
            c.execute('update outbox set payload=? where id=?',(json.dumps(p,ensure_ascii=False),row['id']))
            c.commit()
        # Do not send a delayed failure after it has already disappeared.
        if row['kind'] == 'failure':
            p['items'] = [i for i in p['items'] if c.execute(
                'select 1 from faults where task=? and account=? and stage=? and code=? and active=1',
                (row['task'], i['account'], i['stage'], i['code'])).fetchone()]
        if not p.get('title') and not p['items']:
            c.execute('update outbox set sent=? where id=?', (now, row['id']))
            c.commit()
            continue
        from zoneinfo import ZoneInfo
        stamp = datetime.datetime.fromtimestamp(row['created'], ZoneInfo('America/New_York')).strftime('%Y-%m-%d %H:%M:%S %Z')
        title = '[' + p['server'] + '] ' + p['task'] + (' 失败告警' if row['kind'] == 'failure' else ' 已恢复')
        details = []
        for i in p['items']:
            label = '全局' if i['account'] == 'global' else '账号' + str(i.get('number') or i['account'])
            details.append(label + ' / ' + i['stage'] + ' / ' + MESSAGES.get(i['code'], '任务异常')
                           + (' / ' + i['summary'] if i.get('summary') else ''))
        body = '\n'.join([stamp, *details, '日志：' + p['log_path'], '运行编号：' + p['run_id']])
        if p.get('title'):
            title, body = p['title'], p['body']
        try:
            sent = sender(data, title, body)
        except Exception:
            sent = False
        if sent:
            c.execute('update outbox set sent=? where id=?', (now, row['id']))
            if row['kind'] == 'wins': wins.delivered(c, p, now)
            if row['kind'] == 'failure':
                for i in p['items']:
                    c.execute('update faults set notified=1 where task=? and account=? and stage=? and code=?',
                              (row['task'], i['account'], i['stage'], i['code']))
        else:
            attempt = row['attempts']
            c.execute('update outbox set attempts=attempts+1,due=? where id=?',
                      (now + RETRY[min(attempt, 2)], row['id']))
        c.commit()


def process_alive(cfg, pid, born):
    if not pid or not born:
        return False
    if not cfg.get('container'):
        return ticks(pid) == born
    code = "import pathlib; p=pathlib.Path('/proc/%d/stat'); f=p.read_text().rsplit(')',1)[1].split() if p.exists() else []; print(f[19] if f and f[0] not in ('Z','X') else '')" % pid
    try:
        p = subprocess.run(['docker', 'exec', cfg['container'], 'python3', '-c', code],
                           capture_output=True, text=True, timeout=10)
        return p.stdout.strip() == born if p.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def container_state(cfg):
    if not cfg.get('container'):
        return None
    try:
        p = subprocess.run(['docker', 'inspect', cfg['container'], '--format', '{{json .State}}'],
                           capture_output=True, text=True, timeout=10)
        return json.loads(p.stdout) if p.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def repair_ql(data, cfg, state):
    """Use QingLong's status API; never edit its database directly."""
    inst = ql_instance(data, state['cron_id'], state.get('instance_id'))
    if not inst or inst['status'] != 0 or state.get('child_still_running'):
        return
    token = read(data / 'config/token.json', {}).get('value')
    if not token:
        return
    payload = dict(ids=[state['cron_id']], status='1', pid=str(inst.get('pid') or ''),
                   log_path=inst.get('log_path', ''), exit_code=state.get('exit_code', 1),
                   last_running_time=max(1, int(state['finished_at'] - state['started_at'])),
                   last_execution_time=int(inst['started_at']))
    req = urllib.request.Request(cfg['ql_url'] + '/open/crons/status', method='PUT',
          data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            if json.load(response).get('code') == 200:
                state['ql_repaired'] = True
    except Exception:
        pass


def missing_runs(root, cfg, now):
    """Catch executor death before the launcher had time to create its record."""
    known = {s.get('instance_id') for p in (root / 'runs').glob('*.json') if (s := read(p))}
    try:
        c = sqlite3.connect('file:' + str(root.parent / 'db/database.sqlite') + '?mode=ro', uri=True)
        c.row_factory = sqlite3.Row
        for task, spec in cfg['tasks'].items():
            for inst in c.execute('select * from RunningInstances where cron_id=? and started_at>=?',
                                  (spec['cron_id'], cfg['installed_at'])).fetchall():
                if inst['id'] in known or now - inst['started_at'] <= 120:
                    continue
                # Native and container PIDs live in different namespaces.
                pid = inst['pid']
                if cfg.get('container'):
                    try:
                        probe = subprocess.run(['docker', 'exec', cfg['container'], 'sh', '-c',
                                                'test -d /proc/' + str(int(pid or 0))], timeout=5, capture_output=True)
                        alive = probe.returncode == 0
                    except (OSError, subprocess.TimeoutExpired):
                        continue
                else:
                    alive = bool(pid and ticks(pid))
                if inst['status'] == 0 and alive:
                    continue
                if inst['status'] == 1 and not inst['exit_code']:
                    code = 'RESULT_MISSING'
                else:
                    code = 'PROCESS_LOST'
                state = dict(version=1, run_id='ql-' + str(inst['id']), instance_id=inst['id'],
                             cron_id=spec['cron_id'], task=task, server=cfg['server'], started_at=inst['started_at'],
                             heartbeat=inst['started_at'], finished_at=inst['finished_at'] or now,
                             log_path=inst['log_path'] or '', status='cancelled' if inst['status'] == 2 else 'failed',
                             issues=[issue(code)], accounts=[], exit_code=inst['exit_code'] or 1)
                atomic(root / 'runs' / (state['run_id'] + '.json'), state)
        c.close()
    except sqlite3.Error:
        return


def resolve_external(root, cfg, state, now):
    inst = ql_instance(root.parent, state['cron_id'], state.get('instance_id'))
    # QingLong: running=0, finished=1, stopped=2, error=3.
    if inst and inst.get('status') == 2:
        state.update(status='cancelled', finished_at=inst.get('finished_at') or now)
        return state
    stale = now - state.get('heartbeat', state['started_at']) > 120
    if state['status'] != 'running':
        if state.get('interrupted') and now - state.get('finished_at', now) < 10:
            return None
        return state
    if not stale:
        return None
    container = container_state(cfg)
    stopped = bool(container and not container.get('Running'))
    parent_alive = False if stopped else process_alive(cfg, state.get('supervisor_pid'), state.get('supervisor_ticks'))
    child_alive = (False if stopped else process_alive(cfg, state.get('child_pid'), state.get('child_ticks'))
                   if state.get('child_pid') else None)
    if not stopped and parent_alive is not False and child_alive is not False:
        return None
    # An orphaned child must never be marked idle or restarted automatically.
    reason = 'EXECUTOR_STOPPED' if stopped else 'PROCESS_LOST'
    if stopped and container.get('OOMKilled'):
        reason = 'OOM_KILLED'
    state.update(status='failed', issues=[issue(reason)], accounts=[], finished_at=now,
                 child_still_running=child_alive is True, exit_code=137 if reason == 'OOM_KILLED' else 1)
    return state


def watch(root, cfg, now=None, sender=push):
    now = time.time() if now is None else now
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    with open(root / 'watch.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        c = open_store(root)
        missing_runs(root, cfg, now)
        for path in sorted((root / 'runs').glob('*.json')):
            state = read(path)
            if not state or state.get('started_at', 0) < cfg['installed_at']:
                continue
            if (state.get('status') == 'failed' and not state.get('ql_repaired')
                    and not state.get('child_still_running')
                    and (not state.get('interrupted') or now - state.get('finished_at', now) >= 10)):
                repair_ql(root.parent, cfg, state)
            if c.execute('select 1 from processed where run_id=?', (state['run_id'],)).fetchone():
                continue
            outcome = resolve_external(root, cfg, state, now)
            if outcome:
                if outcome['status'] == 'failed':
                    repair_ql(root.parent, cfg, outcome)
                if state['status'] != 'running':
                    atomic(path, outcome)
                ingest(c, outcome, now)
            elif state['task'] == 'start' and state['status'] == 'running':
                result = read(root / 'results' / (state['run_id'] + '.json'), {})
                if (isinstance(result, dict) and result.get('run_id') == state['run_id'] and isinstance(result.get('passed'), list)
                        and 'discovery' in result['passed']):
                    # Process the committed snapshot separately from the eventual participation result.
                    ingest(c, dict(state, run_id=state['run_id'] + ':discovery', status='partial',
                                   issues=[], accounts=[dict(account='global', status='success', passed=['discovery'])]), now)
        if cfg.get('wins_enabled'):
            try:
                import wins
                imported=wins.tick(root, cfg, c, now)
                if imported and c.execute("select 1 from faults where task='wins_collection' and active=1").fetchone():
                    ingest(c, dict(run_id='wins-import-ok-' + str(int(now)), task='wins_collection', status='success',
                           server=cfg['server'], issues=[], accounts=[]), now)
            except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
                c.rollback()
                c.execute('insert or replace into winner_sync values(?,?,?)',(cfg['server'],now,'导入未完成'))
                ingest(c, dict(run_id='wins-import-' + str(int(now)), task='wins_collection', status='failed',
                       server=cfg['server'], issues=[issue('WINS_IMPORT_FAILED', 'collection')], accounts=[]), now)
        drain(c, root.parent, now, sender)
        c.close()


def main():
    os.umask(0o077)
    p = argparse.ArgumentParser()
    p.add_argument('mode', choices=['run', 'watch'])
    p.add_argument('--root', default=str(pathlib.Path(__file__).resolve().parent))
    p.add_argument('--task')
    # Split the child command explicitly: REMAINDER otherwise swallows --task.
    argv = sys.argv[1:]
    child_args = []
    if '--' in argv:
        split = argv.index('--')
        child_args, argv = argv[split + 1:], argv[:split]
    args = p.parse_args(argv)
    root = pathlib.Path(args.root)
    cfg = read(root / 'config.json')
    if not cfg:
        print('[任务失败] 监测配置不存在', file=sys.stderr)
        return 1
    if args.mode == 'watch':
        watch(root, cfg)
        return 0
    command = child_args
    if command and command[0] == '--':
        command = command[1:]
    return run_task(root, cfg, args.task, command)


if __name__ == '__main__':
    sys.exit(main())
