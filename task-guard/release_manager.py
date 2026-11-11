#!/usr/bin/env python3
"""Explicit, immutable releases. No command runs platform business actions except launch."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time

BASELINE = '401698e88abedd1ff16ac0e5833b78369d29c631'
TASKS = {'start': 'LotteryAutoScript_start.sh', 'check': 'LotteryAutoScript_check.sh',
         'clear': 'LotteryAutoScript_clear.sh', 'daily': 'TaskGuard_daily.sh'}
TESTS = ['task-guard/test_lottery.cjs', 'task-guard/test_metrics.cjs',
         'test/alert_reading_regression.test.js', 'test/article.test.js',
         'test/check_notification.test.js', 'test/pending_win_store.test.js',
         'test/env_merge.test.js', 'test/shared_state_permission.test.js']
TESTS += ['test/winner_v4.test.js', 'integrations/winner-viewer/test/server.test.js','integrations/winner-viewer/test/gateway.test.js']
TESTS += ['test/offline/bili-api.js']
TOOLS = ['release_manager.py', 'guard.py', 'metrics.py', 'wins.py', 'wins_deploy.py','wins_compat.cjs']

def digest(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''): h.update(block)
    return h.hexdigest()

def read(p): return json.loads(Path(p).read_text())

def atomic(p, value, mode=0o600):
    p = Path(p)
    tmp = p.with_name(p.name + '.release-new')
    with tmp.open('w') as f:
        f.write(value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2))
        f.flush(); os.fsync(f.fileno())
    tmp.chmod(mode); os.replace(tmp, p)

def run(args, **kwargs):
    r = subprocess.run([str(x) for x in args], capture_output=True, text=True, **kwargs)
    if r.returncode: raise RuntimeError('Command failed: ' + ' '.join(map(str, args[:3])) + '\n' + (r.stderr + r.stdout)[-2400:])
    return r.stdout

def valid_id(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}', value): raise ValueError('Invalid release ID')
    return value

def files(directory):
    result = {}
    for p in sorted(Path(directory).rglob('*')):
        if p.is_symlink(): raise ValueError('Symlinks are not allowed inside release: ' + str(p))
        if p.is_file() and p != Path(directory) / 'release.json': result[str(p.relative_to(directory))] = digest(p)
    return result

def verify(directory, release_id=None):
    directory = Path(directory)
    m = read(directory / 'release.json')
    if m.get('schema') != 1 or (release_id and m['release_id'] != release_id): raise ValueError('Manifest version or release mismatch')
    valid_id(m['release_id'])
    if not re.fullmatch(r'[a-f0-9]{40}', m['git_commit']): raise ValueError('Invalid Git commit')
    if m['bili_baseline'] != BASELINE: raise ValueError('Unexpected Bili baseline')
    actual = files(directory)
    if actual != m['files']:
        bad = sorted(k for k in set(actual) | set(m['files']) if actual.get(k) != m['files'].get(k))
        raise ValueError('Release file mismatch: ' + ', '.join(bad[:10]))
    for required in ['lottery/main.js', 'lottery/node_modules/got/package.json',
                     'bili/Ray.BiliBiliTool.Console.dll', *['tools/' + p for p in TOOLS[:3]]]:
        if required not in actual: raise ValueError('Missing component: ' + required)
    if not m.get('tests', {}).get('passed'): raise ValueError('Offline tests have not passed')
    if m.get('features',{}).get('wins'):
        for required in ['tools/wins.py','tools/wins_deploy.py','viewer/server.js','viewer/gateway.js','viewer/public/wins.js']:
            if required not in actual:raise ValueError('Missing winner component: '+required)
    return m

def scan_secrets(directory):
    patterns = [rb'-----BEGIN (?:OPENSSH|RSA|EC|PRIVATE).*KEY-----',
                rb'gh[pousr]_[A-Za-z0-9]{30,}', rb'github_pat_[A-Za-z0-9_]{40,}',
                rb'SESSDATA\s*[=:]\s*["\x27]?[A-Za-z0-9%]{35,}']
    for p in Path(directory).rglob('*'):
        if p.is_file() and p.suffix in ('.js', '.json', '.py', '.md', '.sh', '.config', '.xml'):
            content = p.read_bytes()
            if any(re.search(pattern, content) for pattern in patterns): raise ValueError('Possible credential in ' + p.name)

def build(a):
    release_id = valid_id(a.release)
    source = Path(a.source).resolve()
    if run(['git', '-C', source, 'rev-parse', 'HEAD']).strip() != a.commit: raise ValueError('Source HEAD mismatch')
    if run(['git', '-C', source, 'status', '--porcelain', '--untracked-files=no']).strip(): raise ValueError('Tracked source is dirty')
    out = Path(a.output).resolve(); out.mkdir(parents=True, exist_ok=True)
    archive = out / (release_id + '.tar.gz')
    if archive.exists(): raise ValueError('Release archive already exists')
    with tempfile.TemporaryDirectory(prefix='release-build-', dir=out) as td:
        stage = Path(td); payload = stage / 'payload'; payload.mkdir()
        lottery = payload / 'lottery'; lottery.mkdir()
        for name in ['main.js', 'lib', 'package.json', 'package-lock.json']:
            p = source / name
            if p.is_dir(): shutil.copytree(p, lottery / name)
            else: shutil.copy2(p, lottery / name)
        # Snapshot all installed dependencies once. Their actual bytes and package
        # versions are pinned by the manifest, not by a mutable production symlink.
        shutil.copytree(a.node_modules, lottery / 'node_modules', symlinks=False)
        tools = payload / 'tools'; tools.mkdir()
        for name in TOOLS: shutil.copy2(source / 'task-guard' / name, tools / name)
        shutil.copytree(source / 'integrations/winner-viewer', payload / 'viewer')
        for target in [source / 'test', source / 'task-guard']:
            dest = stage / target.name
            shutil.copytree(target, dest, ignore=shutil.ignore_patterns('__pycache__'))
        # Offline tests use a disposable copy, never production state.
        shutil.copytree(lottery, stage / 'test-source')
        for name in ['test', 'task-guard']: shutil.copytree(stage / name, stage / 'test-source' / name)
        shutil.copytree(source / 'integrations', stage / 'test-source/integrations')
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
        for k in list(env):
            if k.startswith(('Ray_', 'TASK_')) or k in ['COOKIE', 'PUSH_PLUS_TOKEN', 'PUSH_PLUS_USER']: env.pop(k)
        test_source = stage / 'test-source'
        for name in TESTS: run([a.node, name], cwd=test_source, env=env, timeout=180)
        run(['python3', '-m', 'unittest', 'discover', '-s', 'task-guard', '-p', 'test_*.py', '-q'], cwd=test_source, env=env, timeout=180)
        # Build from the exact upstream commit plus the tracked adaptation patch.
        bili_source = Path(a.bili_source).resolve()
        if run(['git', '-C', bili_source, 'rev-parse', 'HEAD']).strip() != BASELINE: raise ValueError('Bili source baseline mismatch')
        if run(['git', '-C', bili_source, 'status', '--porcelain', '--untracked-files=no']).strip(): raise ValueError('Bili source is dirty')
        bili = stage / 'bili-source'; bili.mkdir()
        raw = stage / 'bili-source.tar'
        with raw.open('wb') as f: subprocess.run(['git', '-C', str(bili_source), 'archive', BASELINE], stdout=f, check=True)
        with tarfile.open(raw) as t: t.extractall(bili, filter='data')
        patch = source / 'integrations/bilitool/task-guard.patch'
        run(['git', 'apply', '--check', str(patch)], cwd=bili)
        run(['git', 'apply', str(patch)], cwd=bili)
        env.update(DOTNET_CLI_TELEMETRY_OPTOUT='1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1',
                   HUSKY='0',  # Source archives have no Git hooks to install.
                   DOTNET_ROOT=str(Path(a.dotnet).resolve().parent),
                   PATH=str(Path(a.dotnet).resolve().parent) + os.pathsep + env.get('PATH', ''))
        test_project = 'test/Ray.BiliBiliTool.DomainService.UnitTests'
        run([a.dotnet, 'test', test_project, '--filter', 'FullyQualifiedName~StructuredTaskResultTests', '-c', 'Release'], cwd=bili, env=env, timeout=900)
        run([a.dotnet, 'publish', 'src/Ray.BiliBiliTool.Console', '-c', 'Release', '-o', payload / 'bili'], cwd=bili, env=env, timeout=900)
        scan_secrets(payload)
        dependencies = {}
        for p in (lottery / 'node_modules').rglob('package.json'):
            try:
                package = read(p)
                if package.get('name') and package.get('version'): dependencies[str(p.parent.relative_to(lottery / 'node_modules'))] = package['version']
            except (ValueError, OSError): pass
        m = dict(schema=1, release_id=release_id, git_commit=a.commit, bili_baseline=BASELINE, features={'wins': True, 'runtime_inspection': True},
                 bili_patch_sha256=digest(patch), package_lock_sha256=digest(lottery / 'package-lock.json'),
                 runtime=dict(node_min_major=18, python_min='3.11', dotnet_major=10, platform='linux', architecture='x86_64'),
                 dependencies=dependencies, tests=dict(passed=True, node=TESTS, python='test_*.py', bili='StructuredTaskResultTests'), files=files(payload))
        atomic(payload / 'release.json', m)
        verify(payload, release_id)
        with tarfile.open(archive.with_suffix('.tmp'), 'w:gz') as t:
            for p in sorted(payload.iterdir()): t.add(p, arcname=p.name)
        os.replace(archive.with_suffix('.tmp'), archive)
    atomic(out / (release_id + '.sha256'), digest(archive) + '  ' + archive.name + '\n')
    print(json.dumps(dict(release=release_id, git_commit=a.commit, package=str(archive), sha256=digest(archive))))

def unpack(archive, destination):
    with tarfile.open(archive) as t:
        for member in t.getmembers():
            p = PurePosixPath(member.name)
            if p.is_absolute() or '..' in p.parts or not (member.isfile() or member.isdir()): raise ValueError('Unsafe archive member')
        # Only regular files/directories with relative, non-traversing paths passed
        # the checks above. This also supports the USA host's Python 3.10.
        t.extractall(destination)

def context(data):
    data = Path(data).resolve(); root = data / 'task-guard'; cfg = read(root / 'config.json')
    return data, root, cfg

def runtime_path(path, data, cfg):
    return str(path).replace(str(data), '/ql/data', 1) if cfg.get('container') else str(path)

def runtime_run(command, cfg, **kwargs):
    return run((['docker', 'exec', cfg['container']] if cfg.get('container') else []) + list(command), **kwargs)

def compatibility(directory, data, cfg):
    target = runtime_path(directory, data, cfg)
    node = runtime_run(['node', '--version'], cfg).strip()
    if int(node.lstrip('v').split('.')[0]) < 18: raise ValueError('Node 18+ required')
    py = runtime_run(['python3', '-c', 'import sys;print("%d.%d"%sys.version_info[:2])'], cfg).strip()
    if tuple(map(int, py.split('.'))) < (3, 11): raise ValueError('Python 3.11+ required')
    if run(['uname', '-m']).strip() != 'x86_64': raise ValueError('Unsupported architecture')
    dotnet = 'dotnet' if cfg.get('container') else '/root/ql-runtime/bilitool/dotnet/dotnet'
    if 'Microsoft.NETCore.App 10.' not in runtime_run([dotnet, '--list-runtimes'], cfg): raise ValueError('Missing .NET 10 runtime')
    runtime_run(['node', '--check', target + '/lottery/main.js'], cfg)
    # Resolve required modules without executing business entrypoints.
    runtime_run(['node', '-e', 'for(const x of ["got","chalk","@catlair/blogin","qrcode"])require.resolve(x,{paths:[process.argv[1]]})', target + '/lottery'], cfg)
    return dict(node=node, python=py, dotnet=10)

def configuration(data):
    with sqlite3.connect('file:' + str(data / 'db/database.sqlite') + '?mode=ro', uri=True) as c:
        envs = c.execute('select name,value,status,remarks from Envs order by id').fetchall()
        crons = c.execute('select id,name,command,schedule,isDisabled,task_before,task_after from Crontabs order by id').fetchall()
    business = data / 'scripts/LotteryAutoScript'
    return dict(envs=hashlib.sha256(json.dumps(envs).encode()).hexdigest(),
                crons=hashlib.sha256(json.dumps(crons).encode()).hexdigest(),
                files={name: digest(business / name) for name in ['env.js', 'my_config.js'] if (business / name).exists()})

def progress(data):
    result = {}; business = data / 'scripts/LotteryAutoScript'
    for name in ['dyids', 'lottery_info', 'comment_history', 'web_state']:
        base = business / name
        for p in sorted(base.rglob('*')) if base.is_dir() else [base]:
            if p.is_file():
                with contextlib.suppress(FileNotFoundError): result[str(p.relative_to(business))] = digest(p)
    return result

def health(data, root, cfg):
    for name in ['qinglong-task-guard.timer', 'qinglong-participation-collect.timer'] + (['qinglong-participation-hub.timer'] if cfg.get('metrics_peers') else []):
        run(['systemctl', 'is-active', '--quiet', name])
    with sqlite3.connect('file:' + str(root / 'metrics/local.sqlite') + '?mode=ro', uri=True) as c:
        row = c.execute("select value from meta where key='collected_at'").fetchone()
        if not row or time.time() - float(json.loads(row[0])) > 180: raise ValueError('Statistics collector is stale')
        if c.execute('pragma quick_check').fetchone()[0] != 'ok': raise ValueError('Statistics database integrity failure')
    import pwd
    winner=cfg.get('wins_enabled') and (root/'current/tools/wins.py').exists()
    if winner:
        hashes=read(root/'wins/runtime-hashes.json')
        for path,value in hashes.items():
            if digest(path)!=value:raise ValueError('Winner runtime entry drift: '+Path(path).name)
        with sqlite3.connect('file:'+str(root/'monitor.sqlite')+'?mode=ro',uri=True) as c:
            state=c.execute('select at,error from winner_sync where server=?',(cfg['server'],)).fetchone()
            if not state or state[1] or time.time()-state[0]>180:raise ValueError('Winner collection is stale')
        settings=read(root/'wins/config.json')
        if settings.get('hub'):
            run(['systemctl','is-active','--quiet','qinglong-wins-web.service'])
            run(['systemctl','is-active','--quiet','qinglong-wins-hub.timer'])
    try: viewer = pwd.getpwnam('qinglong-log-viewer')
    except KeyError: return dict(timers=True, collector=True, viewer='not installed')
    paths = [data / 'scripts/LotteryAutoScript/web_state/local-accounts.json']
    paths += list((data / 'scripts/LotteryAutoScript/lottery_info').glob('pending_wins_*.json'))
    for p in paths:
        run(['runuser', '-u', viewer.pw_name, '--', 'test', '-r', str(p)])
    run(['systemctl', 'is-active', '--quiet', 'qinglong-log-viewer.service'])
    if winner and settings.get('hub'):
        if run(['systemctl','show','qinglong-log-viewer.service','-p','NoNewPrivileges','--value']).strip()!='yes':raise ValueError('Viewer privilege protection changed')
        script="require(process.argv[1]).createGateway(process.argv[2])({method:'list',status:'all'}).then(x=>{if(!Array.isArray(x.records))process.exit(1)}).catch(()=>process.exit(1))"
        run(['runuser','-u',viewer.pw_name,'--','node','-e',script,str((root/'current/viewer/gateway.js').resolve()),'/run/qinglong-wins/gateway.sock'])
    return dict(timers=True, collector=True, viewer_readable=True)

def shim(root, filename):
    # Every process resolves current once; imports stay inside that immutable tools directory.
    return ('#!/usr/bin/env python3\nimport os,sys,runpy\nfrom pathlib import Path\n'
            'sys.dont_write_bytecode=True\n'
            'root=Path(__file__).resolve().parent\n'
            'current=(root/"current").resolve()\n'
            'if not (current/"release.json").is_file() and current != root/"legacy-tools": raise RuntimeError("Selected release is unavailable")\n'
            'directory=current/"tools" if (current/"release.json").is_file() else root/"legacy-tools"\n'
            'sys.path.insert(0,str(directory))\n'
            'globals().update(runpy.run_path(str(directory/' + repr(filename) + '),run_name=__name__))\n')

def entry_script():
    return '''#!/usr/bin/env python3
import os,sys
from pathlib import Path
root=Path(__file__).resolve().parent
current=(root/'current').resolve()
task=sys.argv[1]
names={'start':'LotteryAutoScript_start.sh','check':'LotteryAutoScript_check.sh','clear':'LotteryAutoScript_clear.sh','daily':'TaskGuard_daily.sh'}
if task not in names: raise SystemExit(64)
if current == root/'legacy-tools':
    os.execv('/bin/bash',['bash',str(root/'legacy-tools/scripts'/names[task])])
if current.parent != root/'unified-releases' or not (current/'release.json').is_file():
    raise SystemExit('Selected release is unavailable; refusing legacy fallback')
extra=sys.argv[2:]
if extra not in ([], ['--inspect']): raise SystemExit(64)
os.execv(sys.executable,[sys.executable,str(current/'tools/release_manager.py'),'launch','--data',str(root.parent),'--release-dir',str(current),'--task',task]+extra)
'''

def bootstrap(data, root, cfg):
    legacy = root / 'legacy-tools'
    legacy.mkdir(mode=0o700, exist_ok=True)
    for filename in ['guard.py', 'metrics.py']:
        if not (legacy / filename).exists(): shutil.copy2(root / filename, legacy / filename)
    scripts = legacy / 'scripts'; scripts.mkdir(exist_ok=True)
    for filename in TASKS.values():
        if not (scripts / filename).exists(): shutil.copy2(data / 'scripts' / filename, scripts / filename)
    # Install a permanent resolver. All wrappers use it; it dispatches to legacy
    # wrappers until the single current-pointer commit below.
    atomic(root / 'release_entry.py', entry_script(), 0o755)
    rroot = runtime_path(root, data, cfg)
    for filename in ['guard.py', 'metrics.py']: atomic(root / filename, shim(root, filename), 0o644)
    for task, filename in TASKS.items():
        atomic(data / 'scripts' / filename,
               '#!/usr/bin/env bash\nbash -c ' + shlex.quote('exec python3 ' + shlex.quote(rroot + '/release_entry.py') + ' ' + task) + '\n', 0o755)
    atomic(legacy / 'ready', 'ready\n')

def switch(root, target):
    temp = root / 'current.release-new'
    if temp.is_symlink(): temp.unlink()
    temp.symlink_to(os.path.relpath(target, root), target_is_directory=True)
    os.replace(temp, root / 'current')

def deployment_lock(root):
    f = (root / 'release.lock').open('a')
    try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close(); raise RuntimeError('Another release operation is in progress')
    return f

def current_dir(root):
    p = root / 'current'
    return p.resolve() if p.is_symlink() else None


def runtime_selection(data, root, cfg):
    target = current_dir(root)
    manifest = read(target / 'release.json')
    if not manifest.get('features', {}).get('runtime_inspection'):
        code = "import pathlib,sys; p=(pathlib.Path(sys.argv[1])/'current').resolve(); assert (p/'release.json').is_file(); print(p)"
        selected = runtime_run(['python3', '-c', code, runtime_path(root, data, cfg)], cfg).strip()
        if selected != runtime_path(target, data, cfg): raise ValueError('Runtime release path is unavailable')
        return
    for task in TASKS:
        raw = runtime_run(['python3', runtime_path(root, data, cfg) + '/release_entry.py', task, '--inspect'], cfg)
        selected = json.loads(raw)
        expected = {name: manifest['files'][name] for name in selected['files']}
        if (selected['release'] != manifest['release_id'] or selected['git_commit'] != manifest['git_commit']
                or selected['files'] != expected
                or selected['release_dir'] != runtime_path(target, data, cfg)):
            raise ValueError('Runtime selected different release: ' + task)

def restore_entries(backup, data, root):
    for name in ['guard.py', 'metrics.py', 'release_entry.py']:
        if (backup / name).exists():
            atomic(root / name, (backup / name).read_text(), (backup / name).stat().st_mode & 0o777)
    for name in TASKS.values():
        atomic(data / 'scripts' / name, (backup / name).read_text(), (backup / name).stat().st_mode & 0o777)

def check(a):
    data, root, cfg = context(a.data)
    expected = a.sha256
    if not re.fullmatch(r'[a-f0-9]{64}', expected) or digest(a.package) != expected: raise ValueError('Archive SHA-256 mismatch')
    # Staging resides below the mounted data path so container checks see it too.
    with tempfile.TemporaryDirectory(prefix='.release-check-', dir=root) as td:
        unpack(a.package, td); m = verify(td, a.release)
        compatible = compatibility(Path(td), data, cfg)
    print(json.dumps(dict(release=m['release_id'], git_commit=m['git_commit'], compatible=compatible, health=health(data, root, cfg)), ensure_ascii=False))

def deploy(a):
    data, root, cfg = context(a.data)
    with deployment_lock(root):
        check(a)
        target = root / 'unified-releases' / valid_id(a.release)
        known_hashes = read(root / 'archive-hashes.json') if (root / 'archive-hashes.json').exists() else {}
        if a.release in known_hashes and known_hashes[a.release] != a.sha256:
            raise ValueError('Release ID already exists with different archive hash')
        if current_dir(root) == target:
            status(a); return
        target.parent.mkdir(exist_ok=True)
        if target.exists():
            m = verify(target, a.release)
            if read(target / 'release.json').get('archive_sha256'): raise ValueError('Unexpected modified manifest')
            # A release ID may never silently refer to another archive.
            if not (root / 'archive-hashes.json').exists() or read(root / 'archive-hashes.json').get(a.release) != a.sha256: raise ValueError('Release ID already exists with different provenance')
        else:
            temp = target.with_name('.' + target.name + '.stage')
            if temp.exists(): raise ValueError('Interrupted stage exists; inspect before retrying')
            temp.mkdir(mode=0o700); unpack(a.package, temp); verify(temp, a.release)
            os.replace(temp, target)
        hashes = read(root / 'archive-hashes.json') if (root / 'archive-hashes.json').exists() else {}
        hashes[a.release] = a.sha256; atomic(root / 'archive-hashes.json', hashes)
        manifests = read(root / 'manifest-hashes.json') if (root / 'manifest-hashes.json').exists() else {}
        predecessor = current_dir(root)
        if predecessor and (predecessor / 'release.json').exists():
            prior = verify(predecessor)
            manifests.setdefault(prior['release_id'], digest(predecessor / 'release.json'))
        manifests[a.release] = digest(target / 'release.json'); atomic(root / 'manifest-hashes.json', manifests)
        before = configuration(data); initial_progress = progress(data)
        backup = data / 'backup' / ('unified-' + a.release + '-' + str(time.time_ns()))
        backup.mkdir(parents=True, mode=0o700)
        previous = current_dir(root)
        atomic(backup / 'before.json', dict(configuration=before, progress=initial_progress,
               previous=str(previous) if previous else None, config=cfg))
        for filename in ['config.json', 'guard.py', 'metrics.py']:
            shutil.copy2(root / filename, backup / filename)
        if (root / 'release_entry.py').exists(): shutil.copy2(root / 'release_entry.py', backup / 'release_entry.py')
        if (root / 'unified-deployment.json').exists(): shutil.copy2(root / 'unified-deployment.json', backup / 'previous-deployment.json')
        for filename in TASKS.values(): shutil.copy2(data / 'scripts' / filename, backup / filename)
        private_config = backup / 'business-config'; private_config.mkdir(mode=0o700)
        for name in ['env.js', 'my_config.js']:
            p = data / 'scripts/LotteryAutoScript' / name
            if p.exists(): shutil.copy2(p, private_config / name)
        for name, db in [('qinglong.sqlite', data / 'db/database.sqlite'),
                         ('monitor.sqlite', root / 'monitor.sqlite'),
                         ('statistics-local.sqlite', root / 'metrics/local.sqlite'),
                         ('statistics-hub.sqlite', root / 'metrics/hub.sqlite')]:
            if db.exists():
                with sqlite3.connect('file:' + str(db) + '?mode=ro', uri=True) as src:
                    with sqlite3.connect(private_config / name) as dest: src.backup(dest)
        # Preserve source and program packages for the first legacy migration too.
        if not (root / 'legacy-tools').exists():
            for dirname in ['20261030-v1', '20261030-metrics-v1', '20261030-reading-fix-v1']:
                src = root / 'releases' / dirname
                if src.exists(): shutil.copytree(src, backup / dirname, symlinks=True)
        try:
            bootstrap(data, root, cfg)
            switch(root, target)
            # Config remains outside the bundle. Change only release metadata.
            cfg.update(unified_release=a.release)
            cfg.pop('wins_rollback_compat',None)
            if read(target / 'release.json').get('features', {}).get('wins'):
                cfg.update(wins_enabled=True)
                cfg.setdefault('wins_installed_at', time.time())
            atomic(root / 'config.json', cfg)
            if cfg.get('wins_enabled') and (target / 'tools/wins_deploy.py').exists():
                run(['python3', target / 'tools/wins_deploy.py', 'enable', '--data', data, '--backup', backup])
            if configuration(data) != before: raise ValueError('Business configuration changed during deployment')
            runtime_selection(data, root, cfg)
            healthy = health(data, root, cfg)
            verify(target, a.release)
        except BaseException:
            if previous: switch(root, previous)
            else:
                legacy = root / 'legacy-tools'; switch(root, legacy)
            old = read(backup / 'config.json'); now = read(root / 'config.json')
            for field in ['unified_release','wins_enabled','wins_installed_at']:
                if field in old:now[field]=old[field]
                else:now.pop(field,None)
            atomic(root / 'config.json', now)
            # Restore the predecessor's resolver format as well as its pointer.
            # Already running processes have loaded their own module bytes.
            restore_entries(backup, data, root)
            if (backup / 'winner-runtime').exists():
                run(['python3', target / 'tools/wins_deploy.py', 'restore', '--data', data, '--backup', backup])
            raise
        after_progress = progress(data)
        report = dict(server=cfg['server'], release=a.release, git_commit=read(target / 'release.json')['git_commit'],
                      archive_sha256=a.sha256, previous=str(previous) if previous else 'legacy', backup=str(backup),
                      configuration_unchanged=True, health=healthy,
                      concurrent_progress_changes=[p for p in sorted(set(initial_progress) | set(after_progress)) if initial_progress.get(p) != after_progress.get(p)],
                      business_jobs_started=False, business_jobs_stopped=False)
        atomic(backup / 'after.json', report); atomic(root / 'unified-deployment.json', report)
        print(json.dumps(report, ensure_ascii=False))

def status(a):
    data, root, cfg = context(a.data); target = current_dir(root)
    if not target or not (target / 'release.json').exists(): raise ValueError('Legacy deployment; no unified release selected')
    m = verify(target, getattr(a, 'release', None))
    pinned = read(root / 'manifest-hashes.json')
    if pinned.get(m['release_id']) != digest(target / 'release.json'): raise ValueError('Manifest provenance drift')
    # A rollback may select a prior resolver format. Validate against the selected
    # release's already hash-verified definitions, not the caller's tool version.
    selected = runpy.run_path(str(target / 'tools/release_manager.py'), run_name='_release_shapes')
    for task, filename in TASKS.items():
        text = (data / 'scripts' / filename).read_text()
        expected = '#!/usr/bin/env bash\nbash -c ' + shlex.quote('exec python3 ' + shlex.quote(runtime_path(root, data, cfg) + '/release_entry.py') + ' ' + task) + '\n'
        compat=cfg.get('wins_rollback_compat')
        if task=='check' and compat:
            patch=root/'wins/compat_notify.cjs'
            if digest(patch)!=compat['sha256'] or digest(data/'scripts'/filename)!=compat['wrapper_sha256']:raise ValueError('Winner archive compatibility drift')
        elif text != expected: raise ValueError('Task wrapper drift: ' + task)
    for filename in ['guard.py', 'metrics.py']:
        if (root / filename).read_text() != selected['shim'](root, filename): raise ValueError('Host resolver drift: ' + filename)
    if (root / 'release_entry.py').read_text() != selected['entry_script'](): raise ValueError('Task resolver drift')
    if cfg.get('unified_release') != m['release_id']: raise ValueError('Configured release mismatch')
    runtime_selection(data, root, cfg)
    report = dict(server=cfg['server'], release=m['release_id'], git_commit=m['git_commit'], runtime_verified=True,
                  manifest_sha256=digest(target / 'release.json'), actual_files_verified=len(m['files']),
                  health=health(data, root, cfg), compatibility=cfg.get('wins_rollback_compat'),passed=True)
    print(json.dumps(report, ensure_ascii=False))

@contextlib.contextmanager
def winner_rollback_window(root,release):
    active=current_dir(root)
    if not active or not (active/'release.json').exists() or read(active/'release.json')['release_id']!=release:raise ValueError('Named release is not active')
    if not (active/'tools/wins.py').exists():yield;return
    with (root/'watch.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        hub=read(root/'wins/config.json').get('hub',False)
        try:
            if hub:run(['systemctl','stop','qinglong-wins-hub.timer','qinglong-wins-hub.service'])
            run(['python3',active/'tools/wins.py','flush','--root',root])
            with sqlite3.connect(root/'monitor.sqlite') as c:
                c.execute("update outbox set kind='wins_suspended',due=32503680000 where kind='wins' and sent is null")
            yield
        finally:
            if hub and current_dir(root)==active:run(['systemctl','enable','--now','qinglong-wins-hub.timer'])

def rollback(a):
    data, root, cfg = context(a.data)
    with deployment_lock(root),winner_rollback_window(root,a.release):
        report = read(root / 'unified-deployment.json')
        if report['release'] != a.release: raise ValueError('Rollback must name the currently deployed release')
        active = current_dir(root)
        if not active or not (active / 'release.json').exists() or read(active / 'release.json')['release_id'] != a.release:
            raise ValueError('Named release is not active')
        backup = Path(report['backup']); before = read(backup / 'before.json')
        previous = Path(before['previous']) if before['previous'] else root / 'legacy-tools'
        if (previous / 'release.json').exists(): verify(previous)
        unchanged = configuration(data)
        switch(root, previous)
        restore_entries(backup, data, root)
        if (backup / 'winner-runtime').exists():
            run(['python3', active / 'tools/wins_deploy.py', 'restore', '--data', data, '--backup', backup])
        if (previous / 'release.json').exists(): cfg['unified_release'] = read(previous / 'release.json')['release_id']
        else: cfg.pop('unified_release', None)
        for field in ['wins_enabled','wins_installed_at']:
            if field in before['config']:cfg[field]=before['config'][field]
            else:cfg.pop(field,None)
        if (active/'tools/wins_compat.cjs').exists() and not (previous/'tools/wins.py').exists():
            patch=root/'wins/compat_notify.cjs'
            atomic(patch,(active/'tools/wins_compat.cjs').read_text(),0o644)
            rroot=runtime_path(root,data,cfg)
            code='export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require='+rroot+'/wins/compat_notify.cjs"; exec python3 '+shlex.quote(rroot+'/release_entry.py')+' check'
            wrapper=data/'scripts'/TASKS['check']
            atomic(wrapper,'#!/usr/bin/env bash\nbash -c '+shlex.quote(code)+'\n',0o755)
            cfg['wins_rollback_compat']=dict(sha256=digest(patch),wrapper_sha256=digest(wrapper),source_release=report['release'])
        atomic(root / 'config.json', cfg)
        if (backup / 'previous-deployment.json').exists():
            atomic(root / 'unified-deployment.json', read(backup / 'previous-deployment.json'))
        if configuration(data) != unchanged: raise ValueError('Business configuration changed during rollback')
        print(json.dumps(dict(rolled_back=a.release, active=str(previous), business_progress_restored=False)))

def launch(a):
    data, root, cfg = context(a.data); release = Path(a.release_dir).resolve()
    # release_dir was resolved once by the stable wrapper. Never resolve current again.
    if release.parent != root / 'unified-releases': raise ValueError('Invalid resolved release directory')
    r = runtime_path(release, data, cfg)
    if getattr(a, 'inspect', False):
        manifest = read(release / 'release.json')
        names = ['tools/guard.py', 'bili/Ray.BiliBiliTool.Console.dll'] if a.task == 'daily' else [
            'tools/guard.py', 'lottery/main.js', 'lottery/lib/net/api.bili.js', 'lottery/lib/core/monitor.js']
        checked = {name: digest(release / name) for name in names if name in manifest['files']}
        print(json.dumps(dict(release=manifest['release_id'], git_commit=manifest['git_commit'],
                              release_dir=str(release), files=checked)))
        return
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    guard = ['python3', r + '/tools/guard.py', 'run', '--root', runtime_path(root, data, cfg), '--task', a.task, '--']
    if a.task != 'daily':
        os.chdir(data / 'scripts/LotteryAutoScript')
        command = guard + ['node', r + '/lottery/main.js', a.task]
        os.execvpe(command[0], command, env)
    preload = '/ql/shell/preload/env.sh' if cfg.get('container') else '/usr/local/lib/node_modules/@whyour/qinglong/shell/preload/env.sh'
    cwd = '/ql/data/repo/RayWangQvQ_BiliBiliToolPro/src/Ray.BiliBiliTool.Console' if cfg.get('container') else '/root/ql-runtime/bilitool/app'
    dotnet = 'dotnet' if cfg.get('container') else '/root/ql-runtime/bilitool/dotnet/dotnet'
    script = 'set -e\nsource ' + shlex.quote(preload) + '\n'
    if not cfg.get('container'): script += 'export DOTNET_ROOT=/root/ql-runtime/bilitool/dotnet\n'
    script += 'export DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 Ray_PlatformType=QingLong Ray_RunTasks=Daily\ncd ' + shlex.quote(cwd) + '\nexec ' + shlex.join(guard + [dotnet, r + '/bili/Ray.BiliBiliTool.Console.dll', '--ENVIRONMENT=Production'])
    os.execvpe('/bin/bash', ['bash', '-c', script], env)

def main():
    p = argparse.ArgumentParser(description=__doc__); sub = p.add_subparsers(dest='command', required=True)
    b = sub.add_parser('build')
    for name in ['source', 'commit', 'release', 'output', 'bili-source', 'node-modules', 'dotnet']: b.add_argument('--' + name, required=True)
    b.add_argument('--node', default='node')
    for name in ['check', 'deploy', 'status', 'rollback']:
        q = sub.add_parser(name); q.add_argument('--data', required=True)
        q.add_argument('--release', required=name != 'status')
        if name in ['check', 'deploy']:
            q.add_argument('--package', required=True); q.add_argument('--sha256', required=True)
    q = sub.add_parser('launch'); q.add_argument('--data', required=True)
    q.add_argument('--release-dir', required=True); q.add_argument('--task', choices=TASKS, required=True)
    q.add_argument('--inspect', action='store_true')
    a = p.parse_args()
    if hasattr(a, 'release') and a.release: valid_id(a.release)
    globals()[a.command](a)

if __name__ == '__main__':
    sys.dont_write_bytecode = True
    os.umask(0o077)
    try: main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as e:
        print(json.dumps({'error': str(e)}, ensure_ascii=False), file=sys.stderr); raise SystemExit(1)
