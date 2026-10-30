#!/usr/bin/env python3
"""Offline fixture. Never contacts BiliBili or reads real accounts."""
import json
import os
import signal
import sys
import time

mode = sys.argv[1]
if mode == 'sleep':
    time.sleep(300)
elif mode == 'kill':
    os.kill(os.getpid(), signal.SIGKILL)
elif mode == 'lost':
    os.kill(os.getppid(), signal.SIGKILL)
else:
    rows = [dict(account='900000001', number=901, status='success', passed=['login','check'], issues=[])]
    if mode in ('fail','partial'):
        rows[0].update(status='failed',passed=[],issues=[dict(code='CHECK_INCOMPLETE',stage='check')])
    if mode == 'partial':
        rows.append(dict(account='900000002',number=902,status='success',passed=['login','check'],issues=[]))
    with open(os.environ['TASK_GUARD_RESULT_PATH'],'w') as f:
        json.dump(dict(version=1,complete=True,accounts=rows),f)
    sys.exit({'fail':1,'partial':2}.get(mode,0))
