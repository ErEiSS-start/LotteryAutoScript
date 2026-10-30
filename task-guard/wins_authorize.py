#!/usr/bin/env python3
"""Install one fixed-command, source-limited public key; no general SSH access."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import shutil
import sys
import time
p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--source-ip',required=True)
p.add_argument('--peer',choices=['wuhan','singapore'],required=True);a=p.parse_args()
public=sys.stdin.read(512).strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]{50,}={0,3} qinglong-wins-20261030-'+a.peer,public):raise SystemExit('Unexpected dedicated public key')
root=Path(a.root).resolve();address=str(ipaddress.ip_address(a.source_ip))
authorized=Path('/root/.ssh/authorized_keys');before=authorized.read_text()
backup=root.parent/'backup'/('winner-ssh-'+str(time.time_ns()));backup.mkdir(mode=0o700);shutil.copy2(authorized,backup/'authorized_keys')
line='from="'+address+'",restrict,command="/usr/bin/python3 '+str(root)+'/wins_agent.py" '+public
if public.split()[1] not in before:
    temp=authorized.with_name('authorized_keys.wins-new');temp.write_text(before.rstrip('\n')+'\n'+line+'\n');temp.chmod(0o600);os.replace(temp,authorized)
print('Dedicated winner key installed: fixed source and command; PTY and forwarding disabled')
