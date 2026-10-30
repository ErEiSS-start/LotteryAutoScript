#!/usr/bin/env python3
"""Publish corrected read paths without running or stopping business tasks."""
import hashlib,json,os,shutil,sqlite3,subprocess,sys,tarfile,time
from pathlib import Path

os.umask(0o077)
server=sys.argv[1]
container={'usa':'1Panel-qinglong-Hcsb','singapore':'1Panel-qinglong-Ql2'}.get(server)
data=Path('/opt/1panel/apps/qinglong/qinglong/data' if container else '/root/ql-runtime/data')
runtime='/ql/data' if container else str(data)
root=data/'task-guard'
source=Path(__file__).resolve().parent.parent
backup=data/'backup/reading-repair-20261030-v1'
release=root/'releases/20261030-reading-fix-v1/lottery'
rrelease=runtime+'/task-guard/releases/20261030-reading-fix-v1/lottery'
def hashes():
    result={}
    for item in ['env.js','my_config.js','dyids','lottery_info','comment_history','web_state']:
        base=data/'scripts/LotteryAutoScript'/item
        for p in sorted(base.rglob('*')) if base.is_dir() else [base]:
            if p.is_file():result[str(p.relative_to(data/'scripts/LotteryAutoScript'))]=hashlib.sha256(p.read_bytes()).hexdigest()
    with sqlite3.connect('file:'+str(data/'db/database.sqlite')+'?mode=ro',uri=True) as c:
        result['envs']=hashlib.sha256(json.dumps(c.execute('select name,value,status from Envs order by id').fetchall()).encode()).hexdigest()
        result['crons']=hashlib.sha256(json.dumps(c.execute('select id,command,schedule,isDisabled from Crontabs order by id').fetchall()).encode()).hexdigest()
    return result
def atomic(p,text,mode=0o600):
    temp=p.with_name(p.name+'.repair-new');temp.write_text(text);temp.chmod(mode);os.replace(temp,p)
if backup.exists():raise RuntimeError('Reading repair backup already exists; inspect instead of overwriting')
before=hashes()
backup.mkdir(parents=True,mode=0o700)
cfg=json.loads((root/'config.json').read_text())
for name in ['config.json','guard.py','metrics-source-hashes.json']:
    shutil.copy2(root/name,backup/name)
for mode in ['start','check']:
    shutil.copy2(data/'scripts'/('LotteryAutoScript_'+mode+'.sh'),backup/('LotteryAutoScript_'+mode+'.sh'))
(backup/'business-before.json').write_text(json.dumps(before))
with tarfile.open(backup/'previous-release.tar.gz','w:gz') as archive:
    archive.add(root/'releases/20261030-metrics-v1/lottery',arcname='lottery',
                filter=lambda t:None if '/node_modules' in t.name else t)
release.parent.mkdir(parents=True,exist_ok=True)
shutil.copytree(root/'releases/20261030-metrics-v1/lottery',release,symlinks=True)
shutil.copytree(source/'lib',release/'lib',dirs_exist_ok=True)
shutil.copy2(source/'main.js',release/'main.js')
prefix=['docker','exec',container] if container else []
for filename in ['main.js','lib/check.js','lib/net/bili.js','lib/helper/session_scan.js','lib/helper/opus_content.js']:
    subprocess.run(prefix+['node','--check',rrelease+'/'+filename],check=True)
for filename in ['guard.py','verify_metrics_deployment.py','rollback_metrics.py','rollback_reading_repair.py','READING-REPAIR.md']:
    atomic(root/filename,(source/'task-guard'/filename).read_text())
for mode in ['start','check']:
    target=data/'scripts'/('LotteryAutoScript_'+mode+'.sh')
    content=target.read_text()
    previous=runtime+'/task-guard/releases/'+('20261030-metrics-v1' if mode=='start' else '20261030-v1')+'/lottery/main.js'
    if previous not in content:raise RuntimeError('Unexpected '+mode+' wrapper; inspect before changing')
    atomic(target,content.replace(previous,rrelease+'/main.js'),0o755)
cfg['lottery_release']=rrelease
atomic(root/'config.json',json.dumps(cfg,ensure_ascii=False,indent=2))
code={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['guard.py','metrics.py']}
for p in [release/'main.js',*sorted((release/'lib').rglob('*.js'))]:code[str(p.relative_to(release))]=hashlib.sha256(p.read_bytes()).hexdigest()
atomic(root/'metrics-source-hashes.json',json.dumps(code,indent=2))
after=hashes()
changed=[p for p in sorted(set(before)|set(after)) if before.get(p)!=after.get(p)]
report=dict(server=cfg['server'],installed_at=time.time(),release=str(release),backup=str(backup),
            business_files_changed=changed,source_digest=hashlib.sha256(json.dumps(code,sort_keys=True).encode()).hexdigest(),
            business_tasks_started_by_deployment=False)
atomic(root/'reading-repair-deployment.json',json.dumps(report,ensure_ascii=False,indent=2))
(backup/'business-after.json').write_text(json.dumps(after))
print(json.dumps(report,ensure_ascii=False))
if any(p in changed for p in ['env.js','my_config.js','envs','crons']):raise RuntimeError('Unexpected business configuration change')
