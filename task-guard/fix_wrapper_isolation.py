from pathlib import Path
import os
import sys
data=Path(sys.argv[1])
for name in ['LotteryAutoScript_start.sh','LotteryAutoScript_check.sh','LotteryAutoScript_clear.sh','TaskGuard_daily.sh']:
    target=data/'scripts'/name
    text=target.read_text()
    if "bash -c '" not in text:
        temp=target.with_suffix('.tmp')
        temp.write_text("#!/usr/bin/env bash\nbash -c '"+text.split('\n',1)[1].rstrip()+"'\n")
        temp.chmod(0o755)
        os.replace(temp,target)
