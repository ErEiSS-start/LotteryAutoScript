import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import guard
import metrics as m


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'task-guard'
        self.root.mkdir()
        self.cfg = dict(server='W', metrics_installed_at=1,
                        metrics_peers=[dict(server=s, local=s == 'W') for s in ['W','S','U']])
        self.c = m.connect(self.root / 'metrics/hub.sqlite')
        self.now = dt.datetime(2026,10,20,10,tzinfo=m.NY).timestamp()
        for s in ['W','S','U']:
            m.setmeta(self.c, 'peer:' + s, dict(ok=True, collected_at=self.now, installed_at=1))
        self.seq = 0

    def tearDown(self):
        self.c.close()
        self.tmp.cleanup()

    def event(self, kind, data, uid='global', server='W', at=None, run='run1'):
        self.seq += 1
        e = dict(version=1,event_id='e'+str(self.seq),server=server,at=at or self.now-86400,
                 type=kind,run_id=run,uid=uid,number=1,data=data)
        m.insert(self.c,m.valid_event(e,server))
        return e

    def setup_day(self, day='2026-10-19', server='W', uid='11', success=True):
        lo, hi=m.day_bounds(day)
        self.event('roster',dict(accounts=[dict(uid=uid,number=1)]),server=server,at=lo-86400)
        self.event('candidates',dict(ids=['1','2'],queue='q',resumed=False),uid,server,lo+10)
        self.event('account_begin',dict(span='1',phase='participation'),uid,server,lo+20)
        self.event('account_end',dict(span='1',phase='participation',status='success'),uid,server,lo+120)
        self.event('run',dict(started_at=lo+1,finished_at=lo+200,status='success',complete=True,
                              issues=[],accounts=[dict(uid=uid,number=1,status='success',issues=[])]),server=server,at=lo+201)
        if success: self.event('interaction',dict(dyid='1',success=True),uid,server,lo+30)
        return lo,hi

    def test_rounds_cross_server_dedup_and_actual_outcomes(self):
        lo,_=self.setup_day()
        self.setup_day(server='S')
        self.event('interaction',dict(dyid='1',success=True),'11',at=lo+35)
        self.event('interaction',dict(dyid='2',success=False),'11',at=lo+40)
        self.event('candidates',dict(ids=['2'],queue='q',resumed=True),'11',at=lo+60)
        self.event('disposition',dict(dyid='2',outcome='deferred',remaining=1),'11',at=lo+61)
        self.event('disposition',dict(dyid='2',outcome='skipped',remaining=0),'11',at=lo+62)
        self.event('snapshot',dict(raw=9,count=2,snapshot='fixture'),at=lo+2)
        self.event('snapshot_reuse',dict(count=2,snapshot='fixture'),at=lo+5)
        report=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        a=report['accounts']['11']
        self.assertEqual(a['success'],['1'])
        self.assertEqual(a['candidates'],['1','2'])
        self.assertTrue(a['observation'])
        w=report['servers']['W']
        self.assertEqual((w['raw'],w['collected'],w['reused']),(9,2,1))
        self.assertEqual(w['accounts'][0]['remaining'],0)
        self.assertEqual(w['accounts'][0]['seconds'],100)

    def test_midnight_interruption_and_dst(self):
        self.assertEqual(m.day_bounds('2026-03-08')[1]-m.day_bounds('2026-03-08')[0],23*3600)
        self.assertEqual(m.day_bounds('2026-11-01')[1]-m.day_bounds('2026-11-01')[0],25*3600)
        lo,hi=self.setup_day()
        self.event('account_begin',dict(span='2',phase='participation'),'11',at=hi-30)
        self.event('account_end',dict(span='2',phase='participation',status='success'),'11',at=hi+30)
        self.event('run',dict(started_at=lo+1,finished_at=hi+30,status='failed',complete=False,issues=['PROCESS_LOST'],accounts=[]),at=hi+31)
        r=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        a=r['servers']['W']['accounts'][0]
        self.assertEqual(a['success'],['1'])
        self.assertEqual(a['seconds'],130)
        self.assertFalse(a['complete'])
        self.assertFalse(r['accounts']['11']['eligible'])

    def test_open_account_span_stops_at_external_termination(self):
        lo,_=self.setup_day()
        self.event('account_begin',dict(span='2',phase='participation'),'11',at=lo+600)
        self.event('run',dict(started_at=lo+1,finished_at=lo+700,status='failed',complete=True,
                              issues=['PROCESS_LOST'],accounts=[]),at=lo+701)
        r=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertEqual(r['servers']['W']['accounts'][0]['seconds'],200)

    def test_partial_account_failure_does_not_poison_healthy_account(self):
        lo,_=self.setup_day()
        self.event('roster',dict(accounts=[dict(uid='11',number=1),dict(uid='12',number=2)]),at=lo-100)
        self.event('run',dict(started_at=lo+1,finished_at=lo+200,status='partial',complete=True,issues=[],
                              accounts=[dict(uid='11',number=1,status='success',issues=[]),
                                        dict(uid='12',number=2,status='failed',issues=['LOGIN_FAILED'])]),at=lo+202)
        r=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertTrue(r['accounts']['11']['eligible'])
        self.assertFalse(r['accounts']['12']['eligible'])

    def test_missing_is_not_zero_or_recovery(self):
        self.setup_day(success=False)
        m.setmeta(self.c,'peer:W',dict(ok=False,collected_at=0,installed_at=1))
        r=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertFalse(r['accounts']['11']['eligible'])
        self.assertIn('数据缺失',m.render(r))
        self.c.execute('insert into anomalies values(?,?)',('11',None))
        issues,outcomes=m.evaluate(self.c,'2026-10-19',r)
        self.assertFalse(issues)
        self.assertEqual(outcomes[0]['status'],'failed')
        self.assertIsNotNone(self.c.execute('select * from anomalies').fetchone())

    def test_baseline_two_days_and_single_recovery(self):
        def report(n): return dict(accounts={'11':dict(eligible=True,success=list(map(str,range(n))))})
        start=dt.date(2026,10,1)
        for i in range(7):
            self.c.execute('insert into daily values(?,?)',((start+dt.timedelta(days=i)).isoformat(),json.dumps(report(100))))
        self.assertFalse(m.evaluate(self.c,'2026-10-08',report(30))[0])
        self.c.execute('insert into daily values(?,?)',('2026-10-08',json.dumps(report(30))))
        self.assertEqual(len(m.evaluate(self.c,'2026-10-09',report(20))[0]),1)
        self.assertEqual(len(m.evaluate(self.c,'2026-10-10',report(25))[0]),1)
        self.assertEqual(m.evaluate(self.c,'2026-10-11',report(50))[1][0]['status'],'success')
        self.assertFalse(m.evaluate(self.c,'2026-10-12',report(100))[0])
        self.assertIsNone(self.c.execute('select * from anomalies').fetchone())

    def test_zero_without_baseline_and_empty_candidates(self):
        r=dict(accounts={'11':dict(eligible=True,success=[])})
        self.c.execute('insert into daily values(?,?)',('2026-10-18',json.dumps(r)))
        self.assertEqual(len(m.evaluate(self.c,'2026-10-19',r)[0]),1)
        good=dict(accounts={'11':dict(eligible=True,success=['1'])})
        self.assertEqual(m.evaluate(self.c,'2026-10-20',good)[1][0]['status'],'success')
        r['accounts']['11']['eligible']=False
        self.assertFalse(m.evaluate(self.c,'2026-10-21',r)[0])

    def test_incremental_replay_staleness_gap_and_strict_schema(self):
        e=self.event('interaction',dict(dyid='1',success=True),'11')
        payload=dict(version=1,server='W',cursor=1,events=[e],collected_at=self.now,installed_at=1)
        m.import_export(self.c,'W',payload,self.now)
        m.import_export(self.c,'W',payload,self.now)
        self.assertEqual(self.c.execute('select count(*) from events').fetchone()[0],1)
        payload['gap']=True
        m.import_export(self.c,'W',payload,self.now)
        self.assertIsNotNone(m.meta(self.c,'gap:W'))
        payload['collected_at']=self.now-181
        with self.assertRaises(ValueError):m.import_export(self.c,'W',payload,self.now)
        e['data']['cookie']='synthetic'
        with self.assertRaises(ValueError):m.valid_event(e,'W')

    def test_export_database_reset_resynchronizes_without_silent_cursor_loss(self):
        m.setmeta(self.c,'cursor:W',99)
        m.setmeta(self.c,'epoch:W','old-database')
        p=dict(version=1,server='W',cursor=99,events=[],collected_at=self.now,installed_at=1,
               epoch='new-database',high_watermark=4)
        self.assertFalse(m.import_export(self.c,'W',p,self.now))
        self.assertEqual(m.meta(self.c,'cursor:W'),0)
        self.assertIsNotNone(m.meta(self.c,'gap:W'))
        p['cursor']=4
        self.assertTrue(m.import_export(self.c,'W',p,self.now))

    def test_late_roster_does_not_lose_confirmed_success(self):
        lo,_=self.setup_day()
        self.event('interaction',dict(dyid='9',success=True),'99',at=lo+86399)
        r=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertEqual(r['accounts']['99']['success'],['9'])
        self.assertTrue(r['accounts']['99']['observation'])
        self.assertFalse(r['accounts']['99']['eligible'])

    def test_export_byte_budget_preserves_incremental_cursor(self):
        path=self.root/'metrics/local.sqlite'
        with m.connect(path) as local:
            ids=[str(10**27+i) for i in range(500)]
            for i in range(400):
                m.insert(local,dict(event_id='large'+str(i),server='W',at=self.now,type='candidates',run_id='large',
                                    uid='11',number=1,data=dict(ids=ids,queue='fixture',resumed=False)))
            m.setmeta(local,'collected_at',self.now)
            m.setmeta(local,'installed_at',1)
        first=m.export(self.root,self.cfg,0)
        self.assertTrue(first['more'])
        self.assertLess(len(json.dumps(first,ensure_ascii=False).encode()),5*1024*1024)
        second=m.export(self.root,self.cfg,first['cursor'])
        self.assertFalse(second['more'])
        self.assertEqual(len(first['events'])+len(second['events']),400)

    def test_journal_partial_tail_replay_and_readonly_export(self):
        journal=self.root/'metrics/journal'
        journal.mkdir()
        e=dict(version=1,event_id='fixture:1',run_id='fixture',server='W',at=self.now,type='interaction',uid='11',number=1,data=dict(dyid='1',success=True))
        file=journal/'fixture.jsonl'
        file.write_text(json.dumps(e)+'\n'+json.dumps(dict(e,event_id='fixture:2'))[:15])
        with patch.object(m,'roster',return_value=[dict(uid='11',number=1)]):
            m.collect(self.root,self.cfg,self.now)
            m.collect(self.root,self.cfg,self.now)
        p=m.export(self.root,self.cfg,0)
        self.assertEqual(len([x for x in p['events'] if x['type']=='interaction']),1)
        before=(self.root/'metrics/local.sqlite').stat().st_mtime_ns
        m.export(self.root,self.cfg,0)
        self.assertEqual(before,(self.root/'metrics/local.sqlite').stat().st_mtime_ns)

    def test_notice_retry_and_sync_failure_recovery_dedup(self):
        c=guard.open_store(self.root)
        m.enqueue_notice(c,'daily:test','日报','fake',0)
        m.enqueue_notice(c,'daily:test','日报','fake',0)
        self.assertEqual(c.execute('select count(*) from outbox').fetchone()[0],1)
        guard.drain(c,self.root.parent,0,lambda *args:False)
        self.assertEqual(c.execute('select due from outbox').fetchone()[0],300)
        guard.drain(c,self.root.parent,300,lambda *args:True)
        self.assertIsNotNone(c.execute('select sent from outbox').fetchone()[0])
        issue=guard.issue('METRICS_SYNC_FAILED','U')
        def run(i,fail):return dict(run_id=str(i),task='metrics_sync',server='汇总',status='partial' if fail else 'success',issues=[issue] if fail else [],accounts=[dict(account='global',status='failed',passed=[] if fail else ['U'])])
        for i in [1,2]:guard.ingest(c,run(i,True),i)
        self.assertEqual(c.execute("select count(*) from outbox where kind='failure'").fetchone()[0],1)
        guard.drain(c,self.root.parent,301,lambda *args:True)
        guard.ingest(c,run(3,False),302)
        guard.ingest(c,run(4,False),303)
        self.assertEqual(c.execute("select count(*) from outbox where kind='recovery'").fetchone()[0],1)
        c.close()

    def test_hub_mock_ssh_daily_idempotency_and_three_failures(self):
        self.setup_day()
        source=[dict(version=1,event_id=r['event_id'],server=r['server'],at=r['at'],type=r['type'],run_id=r['run_id'],uid=r['uid'],number=r['number'],data=json.loads(r['data'])) for r in self.c.execute('select * from events')]
        self.c.commit()
        cfg=dict(self.cfg,metrics_peers=[dict(server=s) for s in ['W','S','U']])
        clock=[self.now]
        unavailable=[True]
        def fetch(peer,cursor):
            name=peer['server']
            if name=='U' and unavailable[0]:raise TimeoutError('mock SSH outage')
            values=source if name=='W' and cursor==0 else []
            return dict(version=1,server=name,cursor=len(source) if name=='W' else cursor,events=values,
                        collected_at=clock[0],installed_at=1,more=False,gap=False)
        for _ in range(3):
            m.hub(self.root,cfg,clock[0],fetch)
            clock[0]+=300
        with guard.open_store(self.root) as monitor:
            self.assertEqual(monitor.execute("select count(*) from outbox where kind='notice'").fetchone()[0],1)
            self.assertEqual(monitor.execute("select count(*) from outbox where task='metrics_sync' and kind='failure'").fetchone()[0],1)
            guard.drain(monitor,self.root.parent,clock[0],lambda *args:True)
        unavailable[0]=False
        m.hub(self.root,cfg,clock[0],fetch)
        with guard.open_store(self.root) as monitor:
            self.assertEqual(monitor.execute("select count(*) from outbox where kind='notice'").fetchone()[0],1)
            self.assertEqual(monitor.execute("select count(*) from outbox where task='metrics_sync' and kind='recovery'").fetchone()[0],1)

    def test_snapshot_shared_queue_all_skipped_and_assignment_change(self):
        lo,_=self.setup_day(success=False)
        self.event('disposition',dict(dyid='1',outcome='skipped',remaining=1),'11',at=lo+50)
        self.event('disposition',dict(dyid='2',outcome='skipped',remaining=0),'11',at=lo+51)
        report=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertFalse(report['accounts']['11']['eligible'])
        self.assertIn('无可参与内容',m.render(report))
        self.event('interaction',dict(dyid='1',success=True),'11',at=lo+100)
        report=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertTrue(report['accounts']['11']['eligible'])
        self.event('roster',dict(accounts=[]),at=lo+500)
        report=m.summarize(self.c,self.cfg,'2026-10-19',self.now)
        self.assertTrue(report['accounts']['11']['observation'])

    def test_real_fake_launcher_preserves_confirmed_event_before_sigkill(self):
        module=Path(os.environ.get('LOTTERY_SOURCE_ROOT', Path(__file__).resolve().parent.parent))/'lib/helper/participation_metrics.js'
        if not module.exists():self.skipTest('run from packaged source tree for Node integration')
        cfg=dict(self.cfg,metrics_enabled=True,tasks={'start':{'cron_id':7}})
        guard.atomic(self.root/'config.json',cfg)
        script=('process.env.COOKIE="DedeUserID=11;";process.env.NUMBER="1";'
                'const m=require('+json.dumps(str(module))+');'
                'm.emit("interaction",{dyid:"123",success:true,code:0});'
                'process.kill(process.pid,"SIGKILL");')
        p=subprocess.run([sys.executable,str(Path(guard.__file__)),'run','--root',str(self.root),
                          '--task','start','--','node','-e',script],capture_output=True,text=True)
        self.assertEqual(p.returncode,137)
        with patch.object(m,'roster',return_value=[dict(uid='11',number=1)]):
            m.collect(self.root,cfg)
        payload=m.export(self.root,cfg,0)
        self.assertEqual(len([e for e in payload['events'] if e['type']=='interaction' and e['data']['success']]),1)
        runs=[e for e in payload['events'] if e['type']=='run']
        self.assertEqual(runs[-1]['data']['status'],'failed')

    def test_restricted_export_rejects_commands_without_reading_other_files(self):
        guard.atomic(self.root/'config.json',self.cfg)
        for command in ['id','cat /root/.ssh/authorized_keys','since 0; id','since -1','', 'since 1\ncat /etc/passwd']:
            env=dict(os.environ,SSH_ORIGINAL_COMMAND=command)
            p=subprocess.run([sys.executable,str(Path(m.__file__)),'export','--root',str(self.root)],
                             capture_output=True,text=True,env=env)
            self.assertEqual(p.returncode,64,command)
            self.assertEqual(p.stdout,'')


if __name__ == '__main__': unittest.main(verbosity=2)
