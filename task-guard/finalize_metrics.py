#!/usr/bin/env python3
"""Atomically publish verified telemetry files; retain live interpreter processes."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

os.umask(0o077)
server=sys.argv[1]
container={'usa':'1Panel-qinglong-Hcsb','singapore':'1Panel-qinglong-Ql2'}.get(server)
data=Path('/opt/1panel/apps/qinglong/qinglong/data' if container else '/root/ql-runtime/data')
root=data/'task-guard'
source=Path(__file__).resolve().parent.parent
release=root/'releases/20261030-metrics-v1/lottery'
for name in ['guard.py','metrics.py','metrics_hub_setup.py','test_metrics.py','test_metrics.cjs',
             'test_lottery.cjs','test_guard.py','METRICS.md','rollback_metrics.py']:
    target=root/name
    temp=target.with_name(target.name+'.verified-new')
    shutil.copy2(source/'task-guard'/name,temp)
    os.replace(temp,target)
target=release/'lib/helper/participation_metrics.js'
temp=target.with_name(target.name+'.verified-new')
shutil.copy2(source/'lib/helper/participation_metrics.js',temp)
os.replace(temp,target)
subprocess.run(['systemctl','start','qinglong-participation-collect.service'],check=True)
subprocess.run(['systemctl','start','qinglong-task-guard.service'],check=True)
files={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['guard.py','metrics.py']}
for p in [release/'main.js',*sorted((release/'lib').rglob('*.js'))]:
    files[str(p.relative_to(release))]=hashlib.sha256(p.read_bytes()).hexdigest()
(root/'metrics-source-hashes.json').write_text(json.dumps(files,indent=2))
print(json.dumps(dict(server=server,files=len(files),digest=hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest())))
