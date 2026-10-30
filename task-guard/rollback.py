#!/usr/bin/env python3
"""Restore only entry points. Never rewind cookies, queues or running jobs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request

os.umask(0o077)
data=Path(sys.argv[1])
backup=data/'backup/task-guard-20261030-v1'
original=json.loads((backup/'crons.json').read_text())
token=json.loads((data/'config/token.json').read_text())['value']
cfg=json.loads((data/'task-guard/config.json').read_text())
daily=next(c for c in original if c['id']==cfg['tasks']['daily']['cron_id'])
request=urllib.request.Request('http://127.0.0.1:5700/open/crons',method='PUT',
    headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'},
    data=json.dumps({k:daily[k] for k in ['id','name','command','schedule']}).encode())
with urllib.request.urlopen(request,timeout=15) as response:
    assert json.load(response)['code']==200
with tarfile.open(backup/'original-code-and-config.tar.gz') as archive:
    for member in archive.getmembers():
        if member.name.startswith('scripts/LotteryAutoScript_') and member.name.endswith('.sh'):
            target=data/member.name
            temp=target.with_suffix('.rollback-tmp')
            temp.write_bytes(archive.extractfile(member).read())
            temp.chmod(member.mode)
            os.replace(temp,target)
subprocess.run(['systemctl','disable','--now','qinglong-task-guard.timer'],check=True)
print('Original task entry points restored. Running jobs, progress and evidence retained.')
