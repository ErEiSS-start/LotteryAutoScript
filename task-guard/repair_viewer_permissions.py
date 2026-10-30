#!/usr/bin/env python3
"""Repair only viewer input document access; preserve file contents and jobs."""
import hashlib
import json
import os
import pwd
import shutil
import sys
import time
from pathlib import Path

data = Path(sys.argv[1])
source = Path(sys.argv[2])
root = data / 'task-guard'
backup = data / 'backup' / ('viewer-permissions-' + str(time.time_ns()))
backup.mkdir(parents=True, mode=0o700)
names = ['local_account_registry.js', 'pending_win_store.js', 'shared_state_permission.js']
targets = [data / 'scripts/LotteryAutoScript']
targets.extend(sorted((root / 'releases').glob('*/lottery')))
for index, target in enumerate(targets):
    for name in names:
        dest = target / 'lib/helper' / name
        if dest.exists():
            saved = backup / str(index) / name
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, saved)
        temp = dest.with_name(name + '.permission-new')
        shutil.copy2(source / 'lib/helper' / name, temp)
        temp.chmod(0o644)
        os.replace(temp, dest)

changed = []
try:
    viewer = pwd.getpwnam('qinglong-log-viewer')
except KeyError:
    viewer = None
if viewer:
    business = data / 'scripts/LotteryAutoScript'
    paths = [business / 'web_state/local-accounts.json']
    paths.extend(sorted((business / 'lottery_info').glob('pending_wins_*.json')))
    for p in paths:
        if not p.is_file():
            continue
        before = p.read_bytes()
        stat = p.stat()
        changed.append(dict(path=str(p.relative_to(business)), mode=stat.st_mode & 0o777,
                            uid=stat.st_uid, gid=stat.st_gid,
                            sha256=hashlib.sha256(before).hexdigest()))
        os.chown(p, stat.st_uid, viewer.pw_gid)
        p.chmod(0o640)
        assert p.read_bytes() == before, 'Unexpected content change'

cfg = json.loads((root / 'config.json').read_text())
release = Path(cfg['lottery_release'].replace('/ql/data', str(data), 1))
code = {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
        for name in ['guard.py', 'metrics.py']}
for p in [release / 'main.js', *sorted((release / 'lib').rglob('*.js'))]:
    code[str(p.relative_to(release))] = hashlib.sha256(p.read_bytes()).hexdigest()
shutil.copy2(root / 'metrics-source-hashes.json', backup / 'metrics-source-hashes.json')
temp = root / 'metrics-source-hashes.json.permission-new'
temp.write_text(json.dumps(code, indent=2))
temp.chmod(0o600)
os.replace(temp, root / 'metrics-source-hashes.json')
(backup / 'permissions-before.json').write_text(json.dumps(changed, indent=2))
print(json.dumps(dict(server=cfg['server'], repaired_documents=len(changed),
                      contents_unchanged=True, backup=str(backup),
                      business_jobs_started=False, business_jobs_stopped=False,
                      source_digest=hashlib.sha256(json.dumps(code, sort_keys=True).encode()).hexdigest()), ensure_ascii=False))
