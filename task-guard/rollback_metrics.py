#!/usr/bin/env python3
"""Disable only participation telemetry. Keep failure monitoring and progress."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import sqlite3
import time

os.umask(0o077)
data=Path(sys.argv[1])
root=data/'task-guard'
backup=data/'backup/participation-20261030-v1'
for unit in ['qinglong-participation-collect.timer','qinglong-participation-hub.timer']:
    subprocess.run(['systemctl','disable','--now',unit],capture_output=True)
# Keep the compatible guard.py: it can still deliver any previously queued metrics notices.
cfg=json.loads((root/'config.json').read_text())
peers=cfg.get('metrics_peers',[])
cfg['metrics_enabled']=False
cfg.pop('metrics_peers',None)
tmp=root/'config.json.rollback'
tmp.write_text(json.dumps(cfg,ensure_ascii=False,indent=2))
os.replace(tmp,root/'config.json')
tmp=data/'scripts/LotteryAutoScript_start.sh.rollback'
shutil.copy2(backup/'LotteryAutoScript_start.sh',tmp)
os.replace(tmp,data/'scripts/LotteryAutoScript_start.sh')
for peer in peers:
    for field in ['key','known_hosts']:
        if peer.get(field):
            p=Path(peer[field]).resolve()
            if p.is_relative_to((root/'metrics').resolve()) and p.is_file():
                p.unlink()
with sqlite3.connect(root/'monitor.sqlite') as c:
    c.execute("update outbox set sent=? where sent is null and task in ('participation','metrics_sync','metrics_quality')",(time.time(),))
    c.execute("update faults set active=0 where task in ('participation','metrics_sync','metrics_quality')")
authorized=Path('/root/.ssh/authorized_keys')
if authorized.exists():
    text=authorized.read_text()
    keep=''.join(line for line in text.splitlines(True) if 'qinglong-participation-20261030-' not in line)
    if keep!=text:
        temp=authorized.with_name('authorized_keys.metrics-rollback')
        temp.write_text(keep)
        temp.chmod(0o600)
        os.replace(temp,authorized)
print('Participation entry points disabled; failure monitor, running jobs and business progress retained.')
