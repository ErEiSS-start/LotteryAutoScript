#!/usr/bin/env python3
"""Install an isolated telemetry release without stopping any business job."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time

os.umask(0o077)
server = sys.argv[1]
container = {'usa':'1Panel-qinglong-Hcsb','singapore':'1Panel-qinglong-Ql2'}.get(server)
data = Path('/opt/1panel/apps/qinglong/qinglong/data' if container else '/root/ql-runtime/data')
runtime = '/ql/data' if container else str(data)
root = data/'task-guard'
source = Path(__file__).resolve().parent.parent
backup = data/'backup/participation-20261030-v1'
release = root/'releases/20261030-metrics-v1/lottery'
runtime_release = runtime+'/task-guard/releases/20261030-metrics-v1/lottery'

def atomic(path, text, mode=0o600):
    tmp=path.with_name(path.name+'.metrics-new')
    tmp.write_text(text)
    tmp.chmod(mode)
    os.replace(tmp,path)

def business():
    lottery=data/'scripts/LotteryAutoScript'
    result={}
    for name in ['env.js','my_config.js','dyids','lottery_info','comment_history','web_state']:
        base=lottery/name
        for p in sorted(base.rglob('*')) if base.is_dir() else [base]:
            if p.is_file():result[str(p.relative_to(lottery))]=hashlib.sha256(p.read_bytes()).hexdigest()
    with sqlite3.connect('file:'+str(data/'db/database.sqlite')+'?mode=ro',uri=True) as c:
        result['enabled-env-digest']=hashlib.sha256(json.dumps(c.execute('select name,value,status from Envs order by id').fetchall()).encode()).hexdigest()
        result['cron-config-digest']=hashlib.sha256(json.dumps(c.execute('select id,name,command,schedule,isDisabled,task_before,task_after from Crontabs order by id').fetchall()).encode()).hexdigest()
    return result

if backup.exists():raise RuntimeError('Deployment backup exists; inspect before retrying')
before=business()
backup.mkdir(parents=True,mode=0o700)
config=json.loads((root/'config.json').read_text())
(backup/'before-business.json').write_text(json.dumps(before))
for filename in ['guard.py','config.json']:
    shutil.copy2(root/filename,backup/filename)
shutil.copy2(data/'scripts/LotteryAutoScript_start.sh',backup/'LotteryAutoScript_start.sh')
for name in ['qinglong-task-guard.service','qinglong-task-guard.timer']:
    p=Path('/etc/systemd/system')/name
    if p.exists():shutil.copy2(p,backup/name)
with tarfile.open(backup/'previous-source.tar.gz','w:gz') as archive:
    archive.add(root/'releases/20261030-v1/lottery',arcname='lottery',recursive=True,
                filter=lambda t: None if '/node_modules' in t.name else t)
release.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'releases/20261030-v1/lottery',release,symlinks=True)
shutil.copytree(source/'lib',release/'lib',dirs_exist_ok=True)
shutil.copy2(source/'main.js',release/'main.js')
for name in ['guard.py','metrics.py','test_metrics.py','test_metrics.cjs','test_guard.py','test_lottery.cjs',
             'rollback_metrics.py','METRICS.md']:
    atomic(root/name,(source/'task-guard'/name).read_text())
config.update(metrics_enabled=True,metrics_installed_at=time.time())
atomic(root/'config.json',json.dumps(config,ensure_ascii=False,indent=2))
old=(data/'scripts/LotteryAutoScript_start.sh').read_text()
old_path=runtime+'/task-guard/releases/20261030-v1/lottery/main.js'
if old_path not in old:raise RuntimeError('Unexpected original entry point; inspect before switching')
atomic(data/'scripts/LotteryAutoScript_start.sh',old.replace(old_path,runtime_release+'/main.js'),0o755)
prefix=['docker','exec',container] if container else []
subprocess.run(prefix+['node','--check',runtime_release+'/main.js'],check=True)
subprocess.run(['/usr/bin/python3','-m','py_compile',str(root/'guard.py'),str(root/'metrics.py')],check=True)
service='[Unit]\nDescription=Collect local QingLong participation telemetry\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/python3 '+str(root)+'/metrics.py collect --root '+str(root)+'\nTimeoutStartSec=50\n'
timer='[Unit]\nDescription=Collect participation telemetry each minute\n[Timer]\nOnBootSec=20\nOnCalendar=*-*-* *:*:00\nAccuracySec=1\n[Install]\nWantedBy=timers.target\n'
atomic(Path('/etc/systemd/system/qinglong-participation-collect.service'),service,0o644)
atomic(Path('/etc/systemd/system/qinglong-participation-collect.timer'),timer,0o644)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','qinglong-participation-collect.timer'],check=True,capture_output=True)
subprocess.run(['systemctl','start','qinglong-participation-collect.service'],check=True)
after=business()
changed=[p for p in sorted(set(before)|set(after)) if before.get(p)!=after.get(p)]
manifest=dict(server=config['server'],installed_at=config['metrics_installed_at'],release=str(release),
              backup=str(backup),business_files_changed=changed,roster_count=None)
with sqlite3.connect(root/'metrics/local.sqlite') as c:
    row=c.execute("select data from events where type='roster' order by seq desc limit 1").fetchone()
    manifest['roster_count']=len(json.loads(row[0])['accounts'])
atomic(root/'metrics-deployment.json',json.dumps(manifest,ensure_ascii=False,indent=2))
(backup/'after-business.json').write_text(json.dumps(after))
print(json.dumps(manifest,ensure_ascii=False))
