#!/usr/bin/env python3
"""Restore read-path entry points while retaining telemetry and failure monitoring."""
import json,os,shutil,sys
from pathlib import Path
os.umask(0o077)
data=Path(sys.argv[1]);root=data/'task-guard';backup=data/'backup/reading-repair-20261030-v1'
for mode in ['start','check']:
    target=data/'scripts'/('LotteryAutoScript_'+mode+'.sh')
    temp=target.with_name(target.name+'.reading-rollback')
    shutil.copy2(backup/target.name,temp);os.replace(temp,target)
cfg=json.loads((root/'config.json').read_text())
previous=json.loads((backup/'config.json').read_text())
if previous.get('lottery_release'):cfg['lottery_release']=previous['lottery_release']
else:cfg.pop('lottery_release',None)
temp=root/'config.json.reading-rollback';temp.write_text(json.dumps(cfg,ensure_ascii=False,indent=2));os.replace(temp,root/'config.json')
shutil.copy2(backup/'metrics-source-hashes.json',root/'metrics-source-hashes.json')
print('Previous read-path entry points restored; active jobs, progress, metrics and failure monitoring retained.')
