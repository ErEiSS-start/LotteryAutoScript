#!/usr/bin/env python3
"""Check deployment invariants without triggering business actions or notifications."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time

os.umask(0o077)
data=Path(sys.argv[1])
root=data/'task-guard'
backup=data/'backup/participation-20261030-v1'
before=json.loads((backup/'before-business.json').read_text())
manifest=json.loads((root/'metrics-deployment.json').read_text())
cfg=json.loads((root/'config.json').read_text())
checks={}
for name in ['env.js','my_config.js']:
    checks[name+'_unchanged']=hashlib.sha256((data/'scripts/LotteryAutoScript'/name).read_bytes()).hexdigest()==before[name]
with sqlite3.connect('file:'+str(data/'db/database.sqlite')+'?mode=ro',uri=True) as c:
    checks['enabled_envs_unchanged']=hashlib.sha256(json.dumps(c.execute('select name,value,status from Envs order by id').fetchall()).encode()).hexdigest()==before['enabled-env-digest']
    checks['cron_configuration_unchanged']=hashlib.sha256(json.dumps(c.execute('select id,name,command,schedule,isDisabled,task_before,task_after from Crontabs order by id').fetchall()).encode()).hexdigest()==before['cron-config-digest']
checks['business_snapshot_unchanged_at_deploy']=not manifest['business_files_changed']
checks['original_failure_timer_active']=subprocess.run(['systemctl','is-active','--quiet','qinglong-task-guard.timer']).returncode==0
checks['new_collector_timer_active']=subprocess.run(['systemctl','is-active','--quiet','qinglong-participation-collect.timer']).returncode==0
checks['metrics_enabled']=cfg.get('metrics_enabled') is True
with sqlite3.connect('file:'+str(root/'metrics/local.sqlite')+'?mode=ro',uri=True) as c:
    collected=json.loads(c.execute("select value from meta where key='collected_at'").fetchone()[0])
    checks['collector_fresh']=time.time()-collected<180
    bad=c.execute("select value from meta where key='bad_journals'").fetchone()
    checks['journal_integrity']=not (bad and json.loads(bad[0]))
source=json.loads((root/'metrics-source-hashes.json').read_text())
checks['release_has_metrics_entry']='20261030-metrics-v1/lottery/main.js' in (data/'scripts/LotteryAutoScript_start.sh').read_text()
report=dict(server=cfg['server'],checks=checks,
            source_digest=hashlib.sha256(json.dumps(source,sort_keys=True).encode()).hexdigest(),
            passed=all(checks.values()))
(root/'metrics-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False))
if not report['passed']:raise SystemExit(1)
