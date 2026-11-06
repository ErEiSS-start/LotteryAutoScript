import importlib.util
import json
import os
import pathlib
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('guard', pathlib.Path(__file__).with_name('guard.py'))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / 'task-guard'
        self.root.mkdir()
        self.cfg = dict(server='TEST', installed_at=0, tasks={'check': {'cron_id': 7}}, ql_url='http://127.0.0.1:1')
        g.atomic(self.root / 'config.json', self.cfg)
        self.c = g.open_store(self.root)

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def state(self, run, accounts=None, failures=None, status='failed'):
        return dict(run_id=str(run), task='check', server='TEST', status=status,
                    accounts=accounts or [], issues=failures or [], log_path='test.log')

    def test_outcomes(self):
        def result(rows, issues=None):
            return g.sanitize_result(dict(version=1, complete=True, accounts=rows, issues=issues or []))
        bad = dict(account='11', status='failed', issues=[dict(code='LOGIN_FAILED', stage='login')])
        good = dict(account='12', status='success', warnings=['SHARE_RESTRICTED', 'PROTECTED_COINS'])
        self.assertEqual(g.summarize(result([bad, good]), 2)[0], 'partial')
        self.assertEqual(g.summarize(result([bad]), 1)[0], 'failed')
        self.assertEqual(g.summarize(result([good]), 0)[0], 'success')
        self.assertEqual(g.summarize(result([]), 0)[1][0]['code'], 'NO_ACCOUNTS')
        self.assertEqual(g.summarize(result([good], [dict(code='DISCOVERY_INCOMPLETE', stage='discovery')]), 1)[0], 'failed')
        self.assertEqual(g.summarize(None, 0)[1][0]['code'], 'RESULT_MISSING')

    def test_dedup_reason_change_independent_recovery(self):
        a = g.issue('LOGIN_FAILED', 'login', '11')
        b = g.issue('CHECK_INCOMPLETE', 'check', '12')
        g.ingest(self.c, self.state(1, failures=[a,b]), 0)
        sent = []
        sender = lambda *args: sent.append(args) or True
        g.drain(self.c, self.root.parent, 0, sender)
        self.assertEqual(len(sent), 1)
        g.ingest(self.c, self.state(2, failures=[a,b]), 60)
        g.drain(self.c, self.root.parent, 60, sender)
        self.assertEqual(len(sent), 1)
        changed = g.issue('ACCOUNT_EXCEPTION', 'login', '11')
        g.ingest(self.c, self.state(3, failures=[changed,b]), 120)
        g.drain(self.c, self.root.parent, 120, sender)
        self.assertEqual(len(sent), 2)
        good = dict(account='11', status='failed', passed=['login'])
        g.ingest(self.c, self.state(4, accounts=[good], failures=[b], status='partial'), 180)
        g.drain(self.c, self.root.parent, 180, sender)
        self.assertEqual(len(sent), 3)
        self.assertIn('已恢复', sent[-1][1])
        g.ingest(self.c, self.state(5, accounts=[good], failures=[b], status='partial'), 240)
        g.drain(self.c, self.root.parent, 240, sender)
        self.assertEqual(len(sent), 3)

    def test_retry_persists_5_15_60(self):
        g.ingest(self.c, self.state(1, failures=[g.issue('CLEAR_FAILED','clear','11')]), 0)
        for now, expected in [(0,300),(300,1200),(1200,4800),(4800,8400)]:
            g.drain(self.c, self.root.parent, now, lambda *a: False)
            self.assertEqual(self.c.execute('select due from outbox').fetchone()[0], expected)
        self.c.close()
        self.c = g.open_store(self.root)
        self.assertEqual(self.c.execute('select attempts from outbox').fetchone()[0],4)

    def test_cancellation_does_not_recover(self):
        g.ingest(self.c,self.state(1, failures=[g.issue('LOGIN_FAILED','login','11')]),0)
        g.drain(self.c,self.root.parent,0,lambda *a:True)
        g.ingest(self.c,self.state(2,status='cancelled'),60)
        self.assertEqual(self.c.execute('select active from faults').fetchone()[0],1)
        self.assertEqual(self.c.execute('select count(*) from outbox').fetchone()[0],1)

    def test_discovery_recovers_once_when_running_snapshot_is_committed(self):
        failure = dict(self.state(1, failures=[g.issue('DISCOVERY_INCOMPLETE', 'discovery')]), task='start')
        g.ingest(self.c, failure, 0)
        sent = []
        sender = lambda *args: sent.append(args) or True
        g.drain(self.c, self.root.parent, 0, sender)
        running = dict(self.state(2, status='running'), task='start', started_at=60, cron_id=7)
        g.atomic(self.root / 'runs' / '2.json', running)
        result_path = self.root / 'results' / '2.json'
        g.atomic(result_path, dict(run_id='2', passed=[]))
        with patch.object(g, 'missing_runs'), patch.object(g, 'resolve_external', return_value=None):
            g.watch(self.root, self.cfg, 60, sender)
            self.assertEqual(len(sent), 1)
            g.atomic(result_path, dict(run_id='2', passed=['discovery']))
            g.watch(self.root, self.cfg, 120, sender)
            g.watch(self.root, self.cfg, 180, sender)
        self.assertEqual(len(sent), 2)
        self.assertIn('已恢复', sent[-1][1])
        self.assertEqual(self.c.execute('select active from faults').fetchone()[0], 0)

    def test_external_dead_alive_manual_and_container(self):
        state = dict(run_id='x',task='check',cron_id=7,started_at=0,heartbeat=0,status='running')
        with patch.object(g,'ql_instance',return_value=None), patch.object(g,'process_alive',return_value=False):
            self.assertIsNone(g.resolve_external(self.root,self.cfg,state.copy(),120))
            self.assertEqual(g.resolve_external(self.root,self.cfg,state.copy(),121)['issues'][0]['code'],'PROCESS_LOST')
        with patch.object(g,'ql_instance',return_value={'status':2,'finished_at':123}):
            self.assertEqual(g.resolve_external(self.root,self.cfg,state.copy(),125)['status'],'cancelled')
        with patch.object(g,'ql_instance',return_value={'status':3}), patch.object(g,'process_alive',return_value=False):
            self.assertEqual(g.resolve_external(self.root,self.cfg,state.copy(),125)['status'],'failed')
        with patch.object(g,'ql_instance',return_value=None), patch.object(g,'process_alive',return_value=True):
            self.assertIsNone(g.resolve_external(self.root,self.cfg,state.copy(),10000))
        with patch.object(g,'ql_instance',return_value=None), patch.object(g,'process_alive',side_effect=[True,False]):
            self.assertEqual(g.resolve_external(self.root,self.cfg,dict(state,child_pid=123),125)['status'],'failed')
        with patch.object(g,'ql_instance',return_value=None), patch.object(g,'process_alive',return_value=False), patch.object(g,'container_state',return_value={'Running':False,'OOMKilled':True}):
            self.assertEqual(g.resolve_external(self.root,self.cfg,state.copy(),125)['issues'][0]['code'],'OOM_KILLED')

    def test_real_launcher_exit_and_kill(self):
        base = [sys.executable,str(pathlib.Path(g.__file__)), 'run','--root',str(self.root),'--task','check','--']
        self.assertEqual(subprocess.run(base+[sys.executable,'-c','raise SystemExit(7)'],capture_output=True).returncode,7)
        self.assertEqual(subprocess.run(base+[sys.executable,'-c','import os,signal;os.kill(os.getpid(),signal.SIGKILL)'],capture_output=True).returncode,137)
        script = 'import os,json;json.dump(dict(version=1,complete=True,accounts=[dict(account="11",status="failed",issues=[dict(code="CHECK_INCOMPLETE",stage="check")]),dict(account="12",status="success")]),open(os.environ["TASK_GUARD_RESULT_PATH"],"w"));raise SystemExit(2)'
        self.assertEqual(subprocess.run(base+[sys.executable,'-c',script],capture_output=True).returncode,2)


if __name__ == '__main__':
    unittest.main(verbosity=2)
