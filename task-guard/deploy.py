#!/usr/bin/env python3
"""Deploy only opt-in wrappers and isolated releases; leave running jobs untouched."""
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
import urllib.request

os.umask(0o077)
SERVER = sys.argv[1]
CONTAINERS = {'usa':'1Panel-qinglong-Hcsb','singapore':'1Panel-qinglong-Ql2'}
CONTAINER = CONTAINERS.get(SERVER)
DATA = Path('/opt/1panel/apps/qinglong/qinglong/data' if CONTAINER else '/root/ql-runtime/data')
RDATA = '/ql/data' if CONTAINER else str(DATA)
STAGE = Path(__file__).resolve().parent.parent
ROOT = DATA / 'task-guard'
RELEASE = ROOT / 'releases/20261030-v1'
RROOT = RDATA + '/task-guard'
RRELEASE = RROOT + '/releases/20261030-v1'
BACKUP = DATA / 'backup/task-guard-20261030-v1'
LOTTERY = DATA / 'scripts/LotteryAutoScript'
LABEL = {'usa':'美国','singapore':'新加坡','wuhan':'武汉'}[SERVER]
BILI = DATA / 'repo/RayWangQvQ_BiliBiliToolPro/src/Ray.BiliBiliTool.Console' if CONTAINER else Path('/root/ql-runtime/bilitool/app')
RBILI = RDATA + '/repo/RayWangQvQ_BiliBiliToolPro/src/Ray.BiliBiliTool.Console' if CONTAINER else str(BILI)

def api(method, path, value=None):
    token = json.loads((DATA / 'config/token.json').read_text())['value']
    request = urllib.request.Request('http://127.0.0.1:5700/open' + path, method=method,
              headers={'Authorization':'Bearer ' + token,'Content-Type':'application/json'},
              data=json.dumps(value).encode() if value is not None else None)
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.load(response)
    if result.get('code') != 200:
        raise RuntimeError('QingLong API rejected ' + method + ' ' + path)
    return result['data']

def hashes():
    result = {}
    for item in ['env.js','my_config.js','dyids','lottery_info','comment_history','web_state']:
        base = LOTTERY / item
        for p in sorted(base.rglob('*')) if base.is_dir() else [base]:
            if p.is_file(): result[str(p.relative_to(LOTTERY))] = hashlib.sha256(p.read_bytes()).hexdigest()
    return result

def write(path, value, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(value)
    os.chmod(temp, mode)
    os.replace(temp, path)

def run_runtime(args):
    cmd = ['docker','exec',CONTAINER] + args if CONTAINER else args
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stdout.strip()

def main():
    if BACKUP.exists(): raise RuntimeError('Backup already exists; inspect existing deployment instead of overwriting')
    crons = api('GET','/crons')
    if isinstance(crons, dict): crons = crons['data']
    tasks = {}
    for key, marker in [('start','自动抽奖'),('check','中奖检查'),('clear','清理动态和关注'),('daily','bili每日任务')]:
        matches = [c for c in crons if marker in c['name'] or (key != 'daily' and c['command'].endswith('LotteryAutoScript_'+key+'.sh'))]
        if len(matches) != 1: raise RuntimeError('Ambiguous task: ' + key)
        tasks[key] = {'cron_id': matches[0]['id'], 'name':matches[0]['name']}
    BACKUP.mkdir(parents=True, mode=0o700)
    (BACKUP / 'crons.json').write_text(json.dumps(crons,ensure_ascii=False,indent=2))
    before = hashes()
    (BACKUP / 'business-before.json').write_text(json.dumps(before,indent=2))
    with tarfile.open(BACKUP / 'original-code-and-config.tar.gz','w:gz') as archive:
        for item in ['main.js','lib','package.json','package-lock.json','env.js','my_config.js']:
            archive.add(LOTTERY / item,arcname='LotteryAutoScript/' + item)
        for pattern in ['LotteryAutoScript_*.sh','BiliBiliTool_*.sh','TaskGuard_*.sh']:
            for p in (DATA/'scripts').glob(pattern): archive.add(p,arcname='scripts/'+p.name)
        for p in (DATA/'config').glob('*'):
            if p.is_file(): archive.add(p,arcname='config/'+p.name)
    with tarfile.open(BACKUP / 'original-bili-package.tar.gz','w:gz') as archive:
        source = BILI / 'bin/Debug/net10.0' if CONTAINER else BILI
        archive.add(source,arcname='bili-package')
    RELEASE.mkdir(parents=True, mode=0o700)
    shutil.copytree(STAGE / 'lottery', RELEASE / 'lottery')
    (RELEASE/'lottery/node_modules').symlink_to(RDATA+'/scripts/LotteryAutoScript/node_modules',target_is_directory=True)
    with tarfile.open(STAGE / 'bili-publish.tar.gz') as archive:
        archive.extractall(RELEASE / 'bili')
    if (STAGE / 'bili-final-delta.tar.gz').exists():
        with tarfile.open(STAGE / 'bili-final-delta.tar.gz') as archive:
            archive.extractall(RELEASE / 'bili')
    for name in ['guard.py','test_guard.py','test_lottery.cjs','fixture.py','ql_acceptance.py']:
        shutil.copy2(STAGE/'task-guard'/name, ROOT/name)
    cfg = dict(version=1,server=LABEL,container=CONTAINER,ql_url='http://127.0.0.1:5700',
               installed_at=time.time(),tasks=tasks,release=RRELEASE)
    write(ROOT/'config.json',json.dumps(cfg,ensure_ascii=False,indent=2))
    # Validate programs before changing any task command.
    run_runtime(['python3','-m','py_compile',RROOT+'/guard.py'])
    run_runtime(['node','--check',RRELEASE+'/lottery/main.js'])
    dotnet = 'dotnet' if CONTAINER else '/root/ql-runtime/bilitool/dotnet/dotnet'
    version = run_runtime([dotnet,'--list-runtimes'])
    if 'Microsoft.NETCore.App 10.' not in version: raise RuntimeError('Required runtime unavailable')
    wrapper_paths = []
    for key in ['start','check','clear']:
        script = '#!/usr/bin/env bash\nset -e\ncd '+RDATA+'/scripts/LotteryAutoScript\nexec python3 '+RROOT+'/guard.py run --root '+RROOT+' --task '+key+' -- node '+RRELEASE+'/lottery/main.js '+key+'\n'
        target = DATA/'scripts'/('LotteryAutoScript_'+key+'.sh')
        # QingLong sources .sh files. Isolate errexit and exec in a child shell.
        script = "#!/usr/bin/env bash\nbash -c '" + script.split('\n',1)[1].rstrip() + "'\n"
        write(target,script,0o755)
        wrapper_paths.append(str(target))
    preload = '/ql/shell/preload/env.sh' if CONTAINER else '/usr/local/lib/node_modules/@whyour/qinglong/shell/preload/env.sh'
    daily = '#!/usr/bin/env bash\nset -e\nsource '+preload+'\n'
    if not CONTAINER: daily += 'export DOTNET_ROOT=/root/ql-runtime/bilitool/dotnet\n'
    daily += 'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1\nexport Ray_PlatformType=QingLong\nexport Ray_RunTasks=Daily\ncd '+RBILI+'\nexec python3 '+RROOT+'/guard.py run --root '+RROOT+' --task daily -- '+dotnet+' '+RRELEASE+'/bili/Ray.BiliBiliTool.Console.dll --ENVIRONMENT=Production\n'
    daily = "#!/usr/bin/env bash\nbash -c '" + daily.split('\n',1)[1].rstrip() + "'\n"
    write(DATA/'scripts/TaskGuard_daily.sh',daily,0o755)
    cron = next(c for c in crons if c['id'] == tasks['daily']['cron_id'])
    api('PUT','/crons',dict(id=cron['id'],name=cron['name'],command='TaskGuard_daily.sh',schedule=cron['schedule']))
    service = '[Unit]\nDescription=QingLong structured task watcher\nAfter=network-online.target\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/python3 '+str(ROOT)+'/guard.py watch --root '+str(ROOT)+'\nTimeoutStartSec=50\n'
    timer = '[Unit]\nDescription=Check QingLong task outcomes each minute\n[Timer]\nOnBootSec=30\nOnUnitActiveSec=60\nAccuracySec=1\n[Install]\nWantedBy=timers.target\n'
    write(Path('/etc/systemd/system/qinglong-task-guard.service'),service,0o644)
    write(Path('/etc/systemd/system/qinglong-task-guard.timer'),timer,0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','qinglong-task-guard.timer'],check=True,capture_output=True)
    subprocess.run(['systemctl','start','qinglong-task-guard.service'],check=True)
    after = hashes()
    changes = [p for p in sorted(set(before)|set(after)) if before.get(p) != after.get(p)]
    (BACKUP/'business-after.json').write_text(json.dumps(after,indent=2))
    # A concurrently running original task may advance its own progress; never restore it.
    manifest = dict(server=LABEL,release=str(RELEASE),backup=str(BACKUP),tasks=tasks,
                    business_files_changed=changes,wrappers=wrapper_paths,installed_at=cfg['installed_at'])
    write(ROOT/'deployment.json',json.dumps(manifest,ensure_ascii=False,indent=2))
    print(json.dumps(manifest,ensure_ascii=False))

if __name__ == '__main__': main()
