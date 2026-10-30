#!/usr/bin/env python3
"""Add only the dedicated, source-restricted statistics export key."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import shutil
import sys

os.umask(0o077)
p=argparse.ArgumentParser()
p.add_argument('--root',required=True)
p.add_argument('--source-ip',required=True)
p.add_argument('--server',choices=['usa','singapore'],required=True)
a=p.parse_args()
address=str(ipaddress.ip_address(a.source_ip))
public=sys.stdin.read().strip()
if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]{50,}={0,3} qinglong-participation-20261030-'+a.server,public):
    raise SystemExit('Unexpected dedicated public key')
root=Path(a.root).resolve()
if not (root/'metrics.py').is_file():raise SystemExit('Statistics exporter not installed')
authorized=Path('/root/.ssh/authorized_keys')
authorized.parent.mkdir(mode=0o700,exist_ok=True)
previous=authorized.read_text() if authorized.exists() else ''
backup=root.parent/'backup/participation-20261030-v1/authorized_keys.before'
if not backup.exists():backup.write_text(previous)
line='from="'+address+'",restrict,command="/usr/bin/python3 '+str(root)+'/metrics.py export --root '+str(root)+'" '+public
if public.split()[1] not in previous:
    temp=authorized.with_name('authorized_keys.metrics-new')
    temp.write_text(previous.rstrip('\n')+'\n'+line+'\n')
    temp.chmod(0o600)
    os.replace(temp,authorized)
print('Dedicated statistics export key installed with source, command and forwarding restrictions')
