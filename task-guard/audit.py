#!/usr/bin/env python3
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tarfile
import time

data=Path(sys.argv[1])
root=data/'task-guard'
backup=data/'backup/task-guard-20261030-v1'
lottery=data/'scripts/LotteryAutoScript'
cfg=json.loads((root/'config.json').read_text())
c=sqlite3.connect('file:'+str(data/'db/database.sqlite')+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
crons={r['id']:dict(r) for r in c.execute('select * from Crontabs')}
old={r['id']:r for r in json.loads((backup/'crons.json').read_text())}
for task,spec in cfg['tasks'].items():
    before,after=old[spec['cron_id']],crons[spec['cron_id']]
    for field in ['schedule','isDisabled','task_before','task_after','extra_schedules','allow_multiple_instances']:
        assert before.get(field)==after.get(field),(task,field)
envs=[dict(r) for r in c.execute('select name,value,status from Envs order by id')]
env_digest=hashlib.sha256(json.dumps(envs,sort_keys=True).encode()).hexdigest()
files={}
with tarfile.open(backup/'business-state-preserved.tar.gz','w:gz') as archive:
    for name in ['env.js','my_config.js','dyids','lottery_info','comment_history','web_state']:
        base=lottery/name
        for p in sorted(base.rglob('*')) if base.is_dir() else [base]:
            if p.is_file():
                value=p.read_bytes()
                rel=str(p.relative_to(lottery))
                files[rel]=hashlib.sha256(value).hexdigest()
                info=tarfile.TarInfo(rel)
                info.size=len(value)
                info.mode=0o600
                archive.addfile(info,io.BytesIO(value))
release=root/'releases/20261030-v1'
code={str(p.relative_to(release)):hashlib.sha256(p.read_bytes()).hexdigest()
      for folder in ['lottery','bili'] for p in (release/folder).rglob('*')
      if p.is_file() and p.suffix in ('.js','.dll','.json')}
report=dict(server=cfg['server'],verified_at=time.time(),schedules_preserved=True,
            env_digest=env_digest,business_files=files,release_code=code,
            production_runs=c.execute('select count(*) from RunningInstances where cron_id in (%s) and started_at>=?' % ','.join('?' for _ in cfg['tasks']),
                (*[s['cron_id'] for s in cfg['tasks'].values()],cfg['installed_at'])).fetchone()[0])
(root/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({k:v for k,v in report.items() if k not in ('business_files','release_code')},ensure_ascii=False))
