"""Create portable source patches against the exact archived deployed sources."""
import difflib
from pathlib import Path
import tarfile
import sys

root=Path(sys.argv[1]) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent
target=root/'patches'
target.mkdir(exist_ok=True)
for folder,archive_name in [('lottery','lottery-source.tar.gz'),('bilitool','bili-source.tar')]:
    with tarfile.open(root/archive_name) as archive:
        baseline={m.name.removeprefix('./'):archive.extractfile(m).read().decode('utf-8')
                  for m in archive.getmembers() if m.isfile() and m.name.endswith(('.js','.cs'))}
    chunks=[]
    for p in sorted((root/folder).rglob('*')):
        if not p.is_file() or p.suffix not in ('.js','.cs'): continue
        rel=p.relative_to(root/folder).as_posix()
        if any(part in ('obj','bin','node_modules','.git') for part in p.relative_to(root/folder).parts): continue
        old=baseline.get(rel,'').replace('\r\n','\n')
        new=p.read_text(encoding='utf-8').replace('\r\n','\n')
        if old!=new:
            chunks.extend(difflib.unified_diff(old.splitlines(True),new.splitlines(True),
                          fromfile='a/'+rel if rel in baseline else '/dev/null',tofile='b/'+rel))
    (target/(folder+'.patch')).write_text(''.join(chunks),encoding='utf-8')
