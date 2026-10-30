#!/usr/bin/env python3
"""Temporary QingLong crons, fake accounts and a fake notification sender only."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.request

os.umask(0o077)
DATA = Path(sys.argv[1])
RDATA = sys.argv[2]
ROOT = DATA / 'task-guard'
TEST = DATA / 'task-guard-acceptance'
RTEST = RDATA + '/task-guard-acceptance'
spec = importlib.util.spec_from_file_location('guard', ROOT/'guard.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
TEST.mkdir(mode=0o700,exist_ok=True)
token = g.read(DATA/'config/token.json')['value']
def api(method,path,payload):
    req = urllib.request.Request('http://127.0.0.1:5700/open'+path,method=method,
          headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},data=json.dumps(payload).encode())
    with urllib.request.urlopen(req,timeout=10) as response: value=json.load(response)
    assert value['code']==200,(method,path,value.get('code'))
    return value.get('data')
def latest(cron): return g.ql_instance(DATA,cron)
def wait_for(predicate,timeout=30):
    until=time.monotonic()+timeout
    while time.monotonic()<until:
        value=predicate()
        if value: return value
        time.sleep(.5)
    raise AssertionError('Fixture timed out')
def write_wrapper(mode):
    p=DATA/'scripts/TaskGuard_fixture.sh'
    p.write_text('#!/usr/bin/env bash\npython3 '+RDATA+'/task-guard/guard.py run --root '+RTEST+' --task check -- python3 '+RDATA+'/task-guard/fixture.py '+mode+'\n')
    p.chmod(0o755)

cron=None
try:
    write_wrapper('fail')
    cron=api('POST','/crons',dict(name='TaskGuard offline acceptance fixture',command='TaskGuard_fixture.sh',schedule='0 0 1 1 *'))['id']
    cfg=dict(server='OFFLINE TEST',installed_at=time.time(),container=g.read(ROOT/'config.json').get('container'),ql_url='http://127.0.0.1:5700',tasks={'check':{'cron_id':cron}})
    g.atomic(TEST/'config.json',cfg)
    sent=[]
    sender=lambda *args: sent.append(args) or True
    report=[]
    for mode,code in [('fail',1),('fail',1),('partial',2),('success',0),('success',0),('kill',137)]:
        write_wrapper(mode)
        old=(latest(cron) or {}).get('id',0)
        api('PUT','/crons/run',[cron])
        inst=wait_for(lambda: (i if (i:=latest(cron)) and i['id']>old and i['status']!=0 else None))
        assert inst['exit_code']==code,inst
        assert inst['status']==(1 if code==0 else 3),inst
        # Interrupted jobs wait for QingLong's manual-stop record to settle.
        g.watch(TEST,cfg,now=time.time()+11,sender=sender)
        report.append(dict(mode=mode,ql_status=inst['status'],exit_code=inst['exit_code'],notifications=len(sent)))
    assert [r['notifications'] for r in report[:5]]==[1,1,1,2,2],report
    write_wrapper('sleep')
    old=latest(cron)['id']
    api('PUT','/crons/run',[cron])
    wait_for(lambda: (i if (i:=latest(cron)) and i['id']>old and i['status']==0 else None))
    # Wait until launcher has written its running record before stopping the fake job.
    wait_for(lambda:any(g.read(p,{}).get('status')=='running' for p in (TEST/'runs').glob('*.json')))
    api('PUT','/crons/stop',[cron])
    wait_for(lambda:latest(cron)['status']==2)
    before=len(sent)
    g.watch(TEST,cfg,now=time.time()+130,sender=sender)
    assert len(sent)==before
    report.append(dict(mode='manual-stop',ql_status=2,notifications=len(sent)))
    # Kill only the fake launcher. Use real elapsed time for the 3-minute check.
    write_wrapper('lost')
    old=latest(cron)['id']
    started=time.time()
    api('PUT','/crons/run',[cron])
    wait_for(lambda: (i if (i:=latest(cron)) and i['id']>old and i['status']!=0 else None))
    detected=None
    while time.time()-started<179:
        g.watch(TEST,cfg,sender=sender)
        for p in (TEST/'runs').glob('*.json'):
            s=g.read(p,{})
            if s.get('instance_id')==latest(cron)['id'] and s.get('status')=='failed': detected=time.time()-started
        if detected is not None: break
        time.sleep(5)
    assert detected is not None, 'External death not identified within 3 minutes'
    report.append(dict(mode='launcher-SIGKILL',detected_seconds=round(detected,1)))
    g.atomic(TEST/'report.json',report)
    print(json.dumps(report,ensure_ascii=False),flush=True)
finally:
    if cron is not None:
        inst=latest(cron)
        if inst and inst['status']==0: api('PUT','/crons/stop',[cron])
        api('DELETE','/crons',[cron])
    (DATA/'scripts/TaskGuard_fixture.sh').unlink(missing_ok=True)
