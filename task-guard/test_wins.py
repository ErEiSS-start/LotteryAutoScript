import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import guard
import wins as w


class WinnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)/'data/task-guard';self.root.mkdir(parents=True)
        self.cfg=dict(server='TEST',tasks={},installed_at=0,wins_enabled=True)
        guard.atomic(self.root/'config.json',self.cfg)
        guard.atomic(self.root/'wins/config.json',dict(hub=True,owners={'10001':{'owner':'朋友','name':'我的账号'}}))
        self.business=self.root.parent/'scripts/LotteryAutoScript'
        guard.atomic(self.business/'web_state/local-accounts.json',{'accounts':[{'uid':'10001'}]})
        source=Path(__file__).resolve().parent.parent/'lib/helper/winner_classifier.js'
        target=self.root/'current/lottery/lib/helper/winner_classifier.js';target.parent.mkdir(parents=True);shutil.copy2(source,target)
        self.c=guard.open_store(self.root);w.schema(self.c)
        self.c.execute('insert into winner_rosters values(?,?)',('TEST',json.dumps(['10001'])));self.c.commit()
        self.now=1700000000
        self.c.execute('insert into winner_sync values(?,?,null)',('TEST',self.now));self.c.commit()

    def tearDown(self):self.c.close();self.tmp.cleanup()

    def row(self,category='winner',identifier='a'*24):
        return w.normalized(dict(id=identifier,accountUid='10001',accountName='我的账号',talkerId='20002',senderUid='20002',
            messageSequence='8',messageTimestamp=100,content='恭喜您中奖，请填写地址',category=category,source='private'), 'TEST', {'10001':{'owner':'朋友'}})

    def request(self,action,identifier='a'*24,operation=None):
        return dict(action=action,accountUid='10001',recordId=identifier,operationId=operation or action+'-operation-000000000')

    def test_retry_only_marks_delivery_after_success_and_no_pending_pileup(self):
        row=w.merge(self.c,self.row(),self.now);self.c.commit();w.enqueue(self.c,self.root,self.now);w.enqueue(self.c,self.root,self.now+1)
        self.assertEqual(self.c.execute("select count(*) from outbox where kind='wins'").fetchone()[0],1)
        guard.drain(self.c,self.root.parent,self.now,sender=lambda *args:False)
        self.assertEqual(w.get(self.c,w.key(row))['notifyCount'],0)
        pending=self.c.execute('select attempts,due from outbox').fetchone();self.assertEqual(pending['attempts'],1);self.assertEqual(pending['due'],self.now+300)
        self.c.execute('update winner_sync set at=?',(self.now+300,));self.c.commit()
        guard.drain(self.c,self.root.parent,self.now+300,sender=lambda *args:True)
        self.assertEqual(w.get(self.c,w.key(row))['notifyCount'],1)
        w.enqueue(self.c,self.root,self.now+301);self.assertEqual(self.c.execute('select count(*) from outbox').fetchone()[0],1)
        w.enqueue(self.c,self.root,self.now+7501);self.assertEqual(self.c.execute('select count(*) from outbox').fetchone()[0],2)

    def test_review_once_confirm_restarts_winner_cycle(self):
        row=w.merge(self.c,self.row('review'),self.now);self.c.commit();w.enqueue(self.c,self.root,self.now)
        guard.drain(self.c,self.root.parent,self.now,sender=lambda *args:True)
        w.enqueue(self.c,self.root,self.now+8000);self.assertEqual(self.c.execute('select count(*) from outbox').fetchone()[0],1)
        request=self.request('confirm');first=w.action(self.root,self.cfg,self.c,request,self.now+8001)
        second=w.action(self.root,self.cfg,self.c,request,self.now+8002);self.assertEqual(first,second)
        self.assertEqual(first['record']['notifyCount'],0)
        stale=self.row('review');stale['notifyCount']=1;stale['lastNotifiedAt']=self.now*1000
        w.merge(self.c,stale,self.now+8003);self.c.commit()
        self.assertEqual(w.get(self.c,w.key(row))['category'],'winner')
        w.enqueue(self.c,self.root,self.now+8004);self.assertEqual(self.c.execute('select count(*) from outbox').fetchone()[0],2)

    def test_dismiss_and_reply_cancel_pending_without_counting_delivery(self):
        row=w.merge(self.c,self.row(),self.now);self.c.commit();w.enqueue(self.c,self.root,self.now)
        w.action(self.root,self.cfg,self.c,self.request('dismiss'),self.now+1)
        sent=[];guard.drain(self.c,self.root.parent,self.now+2,sender=lambda *args:sent.append(args) or True)
        self.assertFalse(sent);self.assertEqual(w.get(self.c,w.key(row))['notifyCount'],0)
        w.action(self.root,self.cfg,self.c,self.request('restore'),self.now+3)
        w.enqueue(self.c,self.root,self.now+3)
        self.assertEqual(self.c.execute("select count(*) from outbox where kind='wins' and sent is null").fetchone()[0],1)
        w.reply(self.c,dict(accountUid='10001',talkerId='20002',messageSequence='9'),self.now+4)
        self.assertEqual(w.get(self.c,w.key(row))['status'],'acknowledged')

    def test_legacy_import_preserves_ids_counts_and_manual_archive(self):
        record=self.row();record.update(status='pending',notifyCount=2,lastNotifiedAt=self.now*1000)
        guard.atomic(self.business/'lottery_info/pending_wins_10001.json',dict(accountUid='10001',records=[record]))
        guard.atomic(self.business/'web_state/dismissed-wins.json',dict(records=[dict(accountUid='10001',recordId=record['id'])]))
        w.collect(self.root,self.cfg,self.c,self.now);w.collect(self.root,self.cfg,self.c,self.now+1)
        saved=w.get(self.c,w.key(record));self.assertEqual(saved['notifyCount'],2);self.assertEqual(saved['status'],'dismissed')
        self.assertEqual(len(w.records(self.c)),1)

    def test_sync_cache_stays_visible_when_offline_and_action_fails(self):
        peer=dict(server='REMOTE');cfg=w.settings(self.root);cfg['peers']=[peer];guard.atomic(self.root/'wins/config.json',cfg)
        row=self.row();row['server']='REMOTE'
        payload=dict(version=1,server='REMOTE',at=self.now,complete=True,roster=['10001'],records=[row])
        w.sync(self.root,self.cfg,self.c,self.now,transport=lambda *args:payload)
        w.sync(self.root,self.cfg,self.c,self.now+1,transport=lambda *args:(_ for _ in ()).throw(ValueError('offline')))
        result=w.snapshot(self.root,self.cfg,self.c,{'status':'pending'},self.now+2)
        self.assertEqual(len(result['records']),1);self.assertTrue(result['warnings'])
        with self.assertRaises(ValueError):w.action(self.root,self.cfg,self.c,self.request('dismiss'),self.now+3)

    def test_duplicate_account_and_cross_source_require_strong_link(self):
        row=self.row();row['link']='https://www.bilibili.com/opus/123'
        w.merge(self.c,row,self.now)
        repeated=dict(row,id='b'*24,source='at',server='REMOTE')
        w.merge(self.c,repeated,self.now+1);self.assertEqual(len(w.records(self.c)),1)
        another=dict(row,id='c'*24,content='另一条获奖信息',source='reply')
        w.merge(self.c,another,self.now+2);self.assertEqual(len(w.records(self.c)),2)

    def test_invalid_actions_and_identity_do_not_write(self):
        for uid in ['../config','1; id','']:
            with self.assertRaises(ValueError): w.action(self.root,self.cfg,self.c,dict(action='dismiss',accountUid=uid,recordId='a'*24,operationId='operation-000000000'),self.now)
        with self.assertRaises(ValueError):w.action(self.root,self.cfg,self.c,dict(self.request('dismiss'),path='/etc/passwd'),self.now)

    def test_same_platform_message_keeps_identity_when_body_changes(self):
        original=w.merge(self.c,self.row(),self.now)
        edited=self.row(identifier='b'*24);edited['content']='恭喜您中奖，请通过新的链接填写地址'
        merged=w.merge(self.c,edited,self.now+1)
        self.assertEqual(merged['id'],original['id']);self.assertEqual(len(w.records(self.c)),1)
        self.assertEqual(merged['content'],edited['content'])

    def test_direct_collector_does_not_write_release_bytecode(self):
        tools=self.root/'current/tools';tools.mkdir()
        source=Path(__file__).resolve().parent
        for name in ['wins.py','guard.py']:shutil.copy2(source/name,tools/name)
        environment=dict(os.environ);environment.pop('PYTHONDONTWRITEBYTECODE',None)
        child=subprocess.run([sys.executable,str(tools/'wins.py'),'collect','--root',str(self.root)],env=environment,capture_output=True,text=True,timeout=15)
        self.assertEqual(child.returncode,0,child.stderr)
        self.assertFalse(list(tools.rglob('__pycache__')))


if __name__=='__main__':unittest.main()
