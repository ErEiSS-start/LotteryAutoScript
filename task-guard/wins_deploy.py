#!/usr/bin/env python3
"""Install only fixed winner resolvers and the existing viewer's release entry."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys

def atomic(path, content, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp=path.with_name(path.name+'.wins-new');temp.write_text(content);temp.chmod(mode);os.replace(temp,path)

def run(args): subprocess.run(args,check=True,capture_output=True,text=True,timeout=45,env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1'))

def resolver(mode):
    return ('#!/usr/bin/env python3\nimport sys,runpy\nfrom pathlib import Path\nsys.dont_write_bytecode=True\n'
      'root=Path(__file__).resolve().parent\nscript=(root/"current").resolve()/"tools/wins.py"\n'
      'if not script.exists(): raise SystemExit('+('0' if mode=='hub' else '64')+')\n'
      'sys.path.insert(0,str(script.parent))\nsys.argv=[str(script),'+repr(mode)+',"--root",str(root)]\n'
      'runpy.run_path(str(script),run_name="__main__")\n')

def main():
    p=argparse.ArgumentParser();p.add_argument('mode',choices=['enable','restore']);p.add_argument('--data',required=True);p.add_argument('--backup',required=True)
    a=p.parse_args();data=Path(a.data);root=data/'task-guard';backup=Path(a.backup)/'winner-runtime'
    override=Path('/etc/systemd/system/qinglong-log-viewer.service.d/unified-wins.conf')
    gateway=Path('/etc/systemd/system/qinglong-wins-web.service');unit=Path('/etc/systemd/system/qinglong-wins-hub.service');timer=unit.with_suffix('.timer')
    entry=Path('/opt/qinglong-log-viewer/release-entry.cjs')
    runtime_hashes=root/'wins/runtime-hashes.json'
    paths=[override,gateway,unit,timer,entry,runtime_hashes]
    if a.mode=='restore':
        previous=json.loads((backup/'files.json').read_text())
        if not previous.get(str(timer)):
            subprocess.run(['systemctl','disable','--now',timer.name],capture_output=True)
        if not previous.get(str(gateway)):
            subprocess.run(['systemctl','disable','--now',gateway.name],capture_output=True)
        for index,path in enumerate(paths):
            if previous.get(str(path)): shutil.copy2(backup/str(index),path)
            elif path.exists(): path.unlink()
        run(['systemctl','daemon-reload'])
        if previous.get(str(gateway)):
            run(['systemctl','enable','--now',gateway.name]);run(['systemctl','restart',gateway.name])
        if previous.get(str(timer)):run(['systemctl','enable','--now',timer.name])
        if entry.parent.exists(): run(['systemctl','restart','qinglong-log-viewer.service'])
        return
    if not (root/'wins/config.json').is_file(): raise ValueError('Private winner configuration must be prepared before release')
    settings=json.loads((root/'wins/config.json').read_text())
    backup.mkdir(mode=0o700)
    previous={}
    for index,path in enumerate(paths):
        previous[str(path)]=path.exists()
        if path.exists():shutil.copy2(path,backup/str(index))
    atomic(backup/'files.json',json.dumps(previous),0o600)
    # Record original winning documents and their permissions; never restore old
    # documents over progress on rollback.
    business=data/'scripts/LotteryAutoScript'
    originals=list((business/'lottery_info').glob('pending_wins_*.json'))+list((business/'web_state').glob('*.json'))
    ledger_backup=backup/'ledgers';ledger_backup.mkdir(mode=0o700)
    for source in originals:shutil.copy2(source,ledger_backup/source.name)
    for name,mode in [('wins_agent.py','agent'),('wins_web.py','serve'),('wins_hub.py','hub')]:atomic(root/name,resolver(mode))
    atomic(root/'wins/compat_notify.cjs',((root/'current').resolve()/'tools/wins_compat.cjs').read_text())
    # Seed existing normalized records without dispatching notifications or calling platform APIs.
    run([sys.executable,(root/'current').resolve()/'tools/wins.py','collect','--root',root])
    try:viewer=pwd.getpwnam('qinglong-log-viewer')
    except KeyError:viewer=None
    if viewer:
        current=(root/'current').resolve()
        for directory in [root,root/'unified-releases',current]:
            os.chown(directory,0,viewer.pw_gid);directory.chmod(0o710)
        for path in [current/'viewer',*list((current/'viewer').rglob('*'))]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        launch=('const fs=require("fs"),path=require("path");\n'
          'const release=fs.realpathSync('+json.dumps(str(root/'current'))+');\n'
          'const next=path.join(release,"viewer/server.js");\n'
          'if(fs.existsSync(next)){require(next).startFromEnvironment();}\n'
          'else { const child=require("child_process").spawn(process.execPath,['+json.dumps(str(entry.parent/'server.js'))+'],{stdio:"inherit"});\n'
          'for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>child.kill(signal));\n'
          'child.on("exit",code=>process.exit(code===null?1:code)); }\n')
        # The server exports a start function so require() preserves its original CLI behavior.
        atomic(entry,launch)
        content='[Service]\nExecStart=\nExecStart=/usr/bin/node '+str(entry)+'\n'
        if settings.get('hub'):
            content+='Environment=WINS_GATEWAY_SOCKET=/run/qinglong-wins/gateway.sock\n'
            atomic(gateway,'[Unit]\nDescription=Local constrained winner gateway\n[Service]\nUser=root\nGroup=qinglong-log-viewer\nType=simple\nExecStart=/usr/bin/python3 '+str(root/'wins_web.py')+'\nRuntimeDirectory=qinglong-wins\nRuntimeDirectoryMode=0750\nUMask=0077\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths='+str(root)+' '+str(business/'web_state')+'\nMemoryMax=128M\nTasksMax=32\n[Install]\nWantedBy=multi-user.target\n')
        else:
            content+='Environment=WINS_CANONICAL_URL=https://zj.niichi.me/winner-reminders/\n'
        atomic(override,content)
    if settings.get('hub'):
        atomic(unit,'[Unit]\nDescription=Synchronize normalized winner records\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/python3 '+str(root/'wins_hub.py')+'\nTimeoutStartSec=45\n')
        atomic(timer,'[Unit]\nDescription=Synchronize winner records each minute\n[Timer]\nOnBootSec=30\nOnUnitActiveSec=60\nAccuracySec=1\n[Install]\nWantedBy=timers.target\n')
    run(['systemctl','daemon-reload'])
    if settings.get('hub'):
        run(['systemctl','enable','--now',gateway.name]);run(['systemctl','restart',gateway.name])
    if settings.get('hub'):run(['systemctl','enable','--now',timer.name])
    if viewer:run(['systemctl','restart','qinglong-log-viewer.service'])
    managed=[root/name for name in ['wins_agent.py','wins_web.py','wins_hub.py']]
    managed.append(root/'wins/compat_notify.cjs')
    managed += [p for p in [override,gateway,unit,timer,entry] if p.exists()]
    atomic(runtime_hashes,json.dumps({str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in managed},indent=2),0o600)

if __name__=='__main__':
    os.umask(0o077)
    main()
