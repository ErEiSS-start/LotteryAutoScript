# Unified releases

Updates are manual and require an explicit release ID and Git commit. There is no
automatic deployment timer. The default branch and upstream baselines are unchanged.

## Build once

Use a clean checkout of the requested `codex/qinglong-task-guard` commit and a clean
Bili checkout at `401698e88abedd1ff16ac0e5833b78369d29c631`. Build on Linux x86_64
with Python 3.12, Node 18+ and the upstream-pinned .NET SDK 10.0.300. Dependency
restore and tool restore may access package registries during preparation. Tests
use fixtures and mocked platform APIs, with no production credentials.

```sh
python3 task-guard/release_manager.py build \
  --source /secure/source --commit FULL_GIT_COMMIT --release RELEASE_ID \
  --bili-source /secure/bili-source --node-modules /secure/node_modules \
  --dotnet /secure/dotnet/dotnet --output /secure/artifacts
```

The Node dependencies are snapshotted from the explicitly supplied, previously
working installation, not fetched at task startup. Every dependency's actual
bytes and installed version are recorded alongside the source lockfile hash.
The Bili patch is applied to an isolated archive of the exact upstream commit;
structured-result tests and a fresh Console publish must succeed. No production
configuration is copied into the package. Secret scanning and the explicit
offline regression suite must pass before producing an archive and SHA-256 file.

The package contains `lottery`, `bili`, `tools` and `release.json`. Its manifest
records Git commit, Bili baseline and patch, runtime requirements, dependency
versions, test results, and every payload file's SHA-256. Keep binaries and
archives private; only source, documentation and sanitized reports go to GitHub.

## Check, deploy and inspect

Run these commands on each host using the release manager from the verified
source checkout. DATA is `/root/ql-runtime/data` on Wuhan and
`/opt/1panel/apps/qinglong/qinglong/data` on Singapore/USA.

```sh
python3 release_manager.py check --data DATA --release RELEASE_ID --package PACKAGE --sha256 SHA256
python3 release_manager.py deploy --data DATA --release RELEASE_ID --package PACKAGE --sha256 SHA256
python3 release_manager.py status --data DATA --release RELEASE_ID
python3 release_manager.py rollback --data DATA --release RELEASE_ID
```

Deploy Wuhan, then Singapore, then USA. Stop on any failed check. Preflight
verifies package integrity, manifest, runtime/module compatibility, active
monitoring/statistics timers, fresh local collection, database integrity, and
viewer input readability under the actual service user. Host Python 3.10+ is
supported; task runtime Python is 3.11+, .NET runtime is 10, Node is 18+.

Each release lives under `task-guard/unified-releases/RELEASE_ID`. All four task
wrappers dispatch through one stable resolver; `guard.py` and `metrics.py` are
compatible stable resolvers for the existing systemd and restricted SSH entries.
Every process resolves `current` once and keeps using that immutable directory.
Atomic replacement of this one symlink activates the complete release. No task
or container is stopped or restarted. Existing job schedules and QingLong
database configuration are not edited. Daily still sources the QingLong preload
and uses its existing working directory and production configuration.

Deployment locks reject concurrent operations. An existing release ID cannot be
reused for another package. Repeating the same deployment verifies its actual
files and is a no-op. Interrupted staging is retained for inspection. First
migration preserves legacy dispatch so partial wrapper installation remains
usable before activation, and a retry can resume bootstrap safely.

Status hashes actual payload files and checks every stable resolver and task
wrapper. It does not trust a saved manifest digest as proof of installed bytes.
Legitimate account additions do not count as source drift. Current checks of
business configuration are relative to each deployment, not the first rollout.

## Backup and rollback

Private backups are in `DATA/backup/unified-RELEASE_ID-TIMESTAMP`: previous entry
files, configuration, initial legacy code/program packages, permission-preserving
copies, business configuration hashes, and progress hashes. Release archives and
all installed release directories are retained. Before/after reports distinguish
concurrently advancing progress from unchanged configuration; progress is never
restored. Queues, snapshots, cookies, account roster, wins, monitor state,
statistics and pending notifications remain outside releases.

Rollback must name the active deployment and switches to its recorded predecessor
(or preserved legacy dispatch for the first migration). Only release metadata is
adjusted in configuration; later account additions and monitoring preferences are
preserved. Failed post-activation checks switch back automatically and block
subsequent hosts. Running processes stay on the version they started with.

## Historical tools

`deploy.py`, `deploy_metrics.py`, `deploy_reading_repair.py`,
`repair_viewer_permissions.py`, their one-off fixes and earlier rollback scripts
are historical records, not entrypoints for unified deployments. In particular,
do not run an older rollback that disables the existing failure monitor. Use only
the release manager above for future releases and rollback.

The web frontend and prize classification rules are outside this release change;
viewer readability and the existing shared-state permission regression are checked.
