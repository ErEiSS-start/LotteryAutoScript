import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch
import release_manager as r


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.data = self.base / 'data'; self.root = self.data / 'task-guard'
        self.root.mkdir(parents=True)
        (self.data / 'db').mkdir()
        with sqlite3.connect(self.data / 'db/database.sqlite') as c:
            c.executescript('create table Envs(id integer,name,value,status,remarks);'
                           'create table Crontabs(id integer,name,command,schedule,isDisabled,task_before,task_after);')
            c.execute('insert into Envs values(1,?,?,0,?)', ('Ray_BiliBiliCookies__0', 'fixture', 'fake'))
        self.business = self.data / 'scripts/LotteryAutoScript'; self.business.mkdir(parents=True)
        (self.business / 'env.js').write_text('fixture')
        (self.business / 'lottery_info').mkdir()
        (self.business / 'lottery_info/progress.json').write_text('{"progress":1}')
        r.atomic(self.root / 'config.json', dict(server='TEST', tasks={}))
        for name in ['guard.py', 'metrics.py']: (self.root / name).write_text('print("legacy")\n')
        for name in r.TASKS.values(): (self.data / 'scripts' / name).write_text('#!/bin/bash\nexit 0\n')
        self.health = patch.object(r, 'health', return_value={'fixture': True}); self.health.start()
        self.compat = patch.object(r, 'compatibility', return_value={'fixture': True}); self.compat.start()
        self.output = contextlib.redirect_stdout(io.StringIO()); self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None); self.compat.stop(); self.health.stop(); self.tmp.cleanup()

    def package(self, name, guard='print("fixture")\n'):
        p = self.base / ('source-' + name); p.mkdir()
        content = {'lottery/main.js': 'console.log("fixture")',
                   'lottery/node_modules/got/package.json': '{}', 'bili/Ray.BiliBiliTool.Console.dll': 'fixture',
                   'tools/guard.py': guard, 'tools/metrics.py': 'print("fixture")',
                   'tools/release_manager.py': Path(r.__file__).read_text()}
        for filename, value in content.items():
            target = p / filename; target.parent.mkdir(parents=True, exist_ok=True); target.write_text(value)
        r.atomic(p / 'release.json', dict(schema=1, release_id=name, git_commit='a' * 40,
                 bili_baseline=r.BASELINE, tests={'passed': True}, files=r.files(p)))
        archive = self.base / (name + '.tar.gz')
        with tarfile.open(archive, 'w:gz') as t:
            for item in p.iterdir(): t.add(item, arcname=item.name)
        return argparse.Namespace(data=str(self.data), release=name, package=str(archive), sha256=r.digest(archive))

    def test_deploy_status_repeat_and_rollback_preserve_progress(self):
        a = self.package('one'); before = r.configuration(self.data)
        r.deploy(a); r.status(a); r.deploy(a)
        (self.business / 'lottery_info/progress.json').write_text('{"progress":2}')
        # Legitimate new accounts are outside release identity.
        with sqlite3.connect(self.data / 'db/database.sqlite') as c:
            c.execute('insert into Envs values(2,?,?,0,?)', ('Ray_BiliBiliCookies__1', 'fake', 'added'))
        r.status(a); r.rollback(a)
        self.assertEqual((self.business / 'lottery_info/progress.json').read_text(), '{"progress":2}')
        self.assertNotEqual(r.configuration(self.data), before)
        self.assertEqual(r.current_dir(self.root), self.root / 'legacy-tools')

    def test_corrupt_archive_and_incompatible_runtime_do_not_switch(self):
        a = self.package('bad'); a.sha256 = '0' * 64
        with self.assertRaises(ValueError): r.deploy(a)
        self.assertIsNone(r.current_dir(self.root))
        a.sha256 = r.digest(a.package)
        with patch.object(r, 'compatibility', side_effect=ValueError('incompatible')):
            with self.assertRaises(ValueError): r.deploy(a)
        self.assertIsNone(r.current_dir(self.root))

    def test_concurrent_deploy_rejected(self):
        a = self.package('one')
        with r.deployment_lock(self.root):
            with self.assertRaises(RuntimeError): r.deploy(a)

    def test_failed_switch_restores_previous_and_no_mixed_wrappers(self):
        a = self.package('one'); r.deploy(a); old = r.current_dir(self.root)
        b = self.package('two')
        with patch.object(r, 'health', side_effect=[{}, RuntimeError('unhealthy')]):
            with self.assertRaises(RuntimeError): r.deploy(b)
        self.assertEqual(r.current_dir(self.root), old)
        r.status(a)

    def test_file_and_wrapper_drift_detected(self):
        a = self.package('one'); r.deploy(a)
        p = r.current_dir(self.root) / 'lottery/main.js'; original = p.read_text(); p.write_text('tampered')
        with self.assertRaises(ValueError): r.status(a)
        p.write_text(original)
        (self.data / 'scripts' / r.TASKS['clear']).write_text('wrong version')
        with self.assertRaises(ValueError): r.status(a)

    def test_old_process_keeps_version_new_process_uses_new_version(self):
        code = 'import time\nprint("ready",flush=True)\ntime.sleep(0.5)\nprint("one")\n'
        a = self.package('one', code); r.deploy(a)
        old = subprocess.Popen([sys.executable, str(self.root / 'guard.py')], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(old.stdout.readline().strip(), 'ready')
            b = self.package('two', 'print("two")\n'); r.deploy(b)
            newer = subprocess.check_output([sys.executable, str(self.root / 'guard.py')], text=True).strip()
            self.assertEqual(newer, 'two')
            self.assertEqual(old.communicate(timeout=10)[0].strip(), 'one')
        finally:
            if old.poll() is None: old.terminate(); old.wait()
        r.rollback(b); r.status(a)

    def test_unsafe_archive_rejected(self):
        archive = self.base / 'unsafe.tar'
        with tarfile.open(archive, 'w') as t:
            member = tarfile.TarInfo('../escape'); member.size = 1
            t.addfile(member, io.BytesIO(b'x'))
        with self.assertRaises(ValueError): r.unpack(archive, self.base / 'out')

    def test_host_resolver_preserves_import_contract(self):
        code = 'def marker(): return "imported"\nif __name__ == "__main__": raise SystemExit(64)\n'
        a = self.package('one', code); r.deploy(a)
        script = 'import sys;sys.path.insert(0,sys.argv[1]);import guard;print(guard.marker())'
        output = subprocess.check_output([sys.executable, '-c', script, str(self.root)], text=True)
        self.assertEqual(output.strip(), 'imported')

    def test_interrupted_bootstrap_can_resume_without_replacing_legacy(self):
        a = self.package('one')
        original = r.atomic
        def interrupt(p, *args, **kwargs):
            if Path(p).name == 'metrics.py': raise OSError('interrupted')
            return original(p, *args, **kwargs)
        with patch.object(r, 'atomic', side_effect=interrupt):
            with self.assertRaises(OSError): r.deploy(a)
        r.deploy(a); r.status(a)
        self.assertEqual((self.root / 'legacy-tools/guard.py').read_text(), 'print("legacy")\n')


if __name__ == '__main__': unittest.main()
