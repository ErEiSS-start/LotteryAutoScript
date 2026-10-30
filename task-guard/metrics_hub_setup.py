#!/usr/bin/env python3
"""Prepare dedicated keys, pin already-verified host keys, and enable aggregation."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import guard
import metrics

os.umask(0o077)
p=argparse.ArgumentParser()
p.add_argument('mode',choices=['prepare','configure','verify','enable'])
p.add_argument('--root',required=True)
a=p.parse_args()
root=Path(a.root)
keys=root/'metrics/keys'
keys.mkdir(parents=True,exist_ok=True,mode=0o700)
cfg=guard.read(root/'config.json')
if a.mode=='prepare':
    result={}
    for name in ['usa','singapore']:
        path=keys/('export_'+name)
        if not path.exists():
            subprocess.run(['ssh-keygen','-q','-t','ed25519','-f',str(path),'-N','',
                            '-C','qinglong-participation-20261030-'+name],check=True,capture_output=True)
        result[name]=path.with_suffix('.pub').read_text().strip()
    print(json.dumps(result))
elif a.mode=='configure':
    supplied=json.load(sys.stdin)
    peers=[dict(server=cfg['server'],local=True)]
    known=[]
    routes=json.loads(subprocess.run(['ip','-j','-4','route','show','table','main','default'],check=True,capture_output=True,text=True).stdout)
    interface=routes[0]['dev']
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,30}',interface):raise SystemExit('Invalid physical interface')
    for name,label in [('usa','美国'),('singapore','新加坡')]:
        item=supplied[name]
        if not re.fullmatch(r'[0-9.]+',item['host']):raise SystemExit('IPv4 host expected')
        if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,3}',item['host_key']):raise SystemExit('Verified Ed25519 host key expected')
        known.append(item['host']+' '+item['host_key'])
        peers.append(dict(server=label,host=item['host'],port=22,key=str(keys/('export_'+name)),known_hosts=str(keys/'known_hosts'),bind_interface=interface))
    (keys/'known_hosts').write_text('\n'.join(known)+'\n')
    cfg['metrics_peers']=peers
    guard.atomic(root/'config.json',cfg)
    print('Three statistics sources configured; host keys pinned')
elif a.mode=='verify':
    results=[]
    for peer in cfg['metrics_peers']:
        if peer.get('local'):continue
        payload=metrics.remote(peer,0)
        m=[e for e in payload['events'] if e['type']=='roster']
        row=dict(server=peer['server'],roster_count=len(m[-1]['data']['accounts']) if m else 0)
        base=['ssh','-F','/dev/null','-o','BatchMode=yes','-o','IdentitiesOnly=yes',
              '-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
              '-o','UserKnownHostsFile='+peer['known_hosts'],'-i',peer['key']]
        target='root@'+peer['host']
        if peer.get('bind_interface'):base[1:1]=['-B',peer['bind_interface']]
        for command in ['id','cat '+str(root/'config.json'),'since 0; id']:
            r=subprocess.run(base+[target,command],capture_output=True,text=True,timeout=20)
            if r.returncode!=64 or r.stdout:raise SystemExit('Restricted command check failed')
        r=subprocess.run(base+['-W','127.0.0.1:5700',target],capture_output=True,text=True,timeout=20)
        if r.returncode==0:raise SystemExit('Forwarding unexpectedly available')
        r=subprocess.run(base+['-tt',target,'id'],capture_output=True,text=True,timeout=20)
        if r.returncode not in (64,255) or r.stdout or 'PTY allocation request failed' not in r.stderr:
            raise SystemExit('PTY restriction check failed')
        row.update(arbitrary_commands='rejected',config_read='rejected',forwarding='denied',pty='denied')
        results.append(row)
    print(json.dumps(results,ensure_ascii=False))
else:
    unit=Path('/etc/systemd/system')
    service='[Unit]\nDescription=Merge three QingLong participation sources\nAfter=network-online.target\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/python3 '+str(root)+'/metrics.py hub --root '+str(root)+'\nTimeoutStartSec=240\n'
    timer='[Unit]\nDescription=Merge participation metrics every five minutes; report at 09:00 New York\n[Timer]\nOnBootSec=45\nOnCalendar=*-*-* *:0/5:00\nAccuracySec=1\n[Install]\nWantedBy=timers.target\n'
    (unit/'qinglong-participation-hub.service').write_text(service)
    (unit/'qinglong-participation-hub.timer').write_text(timer)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','qinglong-participation-hub.timer'],check=True,capture_output=True)
    subprocess.run(['systemctl','start','qinglong-participation-hub.service'],check=True)
    print('Five-minute aggregation enabled; daily report gate is America/New_York 09:00')
