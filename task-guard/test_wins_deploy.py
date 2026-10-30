import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import wins_deploy as d

class WinnerDeploymentTests(unittest.TestCase):
    def test_enable_and_restore_only_touch_fixed_winner_files(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);data=base/'data';root=data/'task-guard'
            (root/'wins').mkdir(parents=True);(root/'wins/config.json').write_text(json.dumps({'hub':True}))
            release=root/'unified-releases/test';(release/'viewer').mkdir(parents=True)
            (release/'viewer/server.js').write_text('fixture')
            (release/'tools').mkdir();(release/'tools/wins_compat.cjs').write_text('fixture compatibility adapter')
            (root/'current').symlink_to(release,target_is_directory=True)
            backup=base/'backup';backup.mkdir()
            def mapped(value):
                value=str(value)
                if value.startswith(('/etc/','/opt/')):return base/'system'/value.lstrip('/')
                return Path(value)
            entry=mapped('/opt/qinglong-log-viewer/release-entry.cjs');entry.parent.mkdir(parents=True);entry.write_text('prior-entry')
            (data/'scripts/LotteryAutoScript').mkdir(parents=True)
            calls=[]
            with patch.object(d,'Path',side_effect=mapped),patch.object(d.pwd,'getpwnam',return_value=SimpleNamespace(pw_gid=os.getgid())),patch.object(d,'run',side_effect=lambda args:calls.append(args)),patch.object(d.subprocess,'run'):
                args=['wins_deploy.py','enable','--data',str(data),'--backup',str(backup)]
                with patch('sys.argv',args):d.main()
                self.assertIn('startFromEnvironment',entry.read_text())
                policy=mapped('/etc/systemd/system/qinglong-wins-web.service').read_text()
                self.assertNotIn('sudo',policy);self.assertIn('wins_web.py',policy);self.assertIn('NoNewPrivileges=true',policy)
                override=mapped('/etc/systemd/system/qinglong-log-viewer.service.d/unified-wins.conf').read_text()
                self.assertNotIn('NoNewPrivileges=false',override);self.assertIn('WINS_GATEWAY_SOCKET=',override)
                self.assertTrue((root/'wins_agent.py').exists())
                with patch('sys.argv',['wins_deploy.py','restore','--data',str(data),'--backup',str(backup)]):d.main()
                self.assertEqual(entry.read_text(),'prior-entry')
                self.assertFalse(mapped('/etc/systemd/system/qinglong-wins-web.service').exists())
                self.assertFalse(any('task-guard.service' in ' '.join(map(str,call)) for call in calls))

if __name__=='__main__':unittest.main()
