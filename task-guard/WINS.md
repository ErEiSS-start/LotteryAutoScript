# Winner classification and reliable delivery

This release covers current local records and future scheduled checks. It does
not traverse already-read history, mark platform messages read, add AI calls,
rerun jobs or change schedules, account allocation or participation settings.

## Classification and identity

`winner_classifier.js` accepts account UID/name, source, mentions and content. It
returns `category`, `reason`, and `ruleVersion`. Categories are `winner`, `review`,
`reservation`, and `ignored`. Lifecycle and manual decisions are independent.
An announcement naming other recipients is not a personal prize. Uncertain
announcements remain review items; explicit association with the account and
prize is required for a winner entry. Plain private award/claim notices remain
eligible. Reservation confirmations are silent and never count as wins.

Ownership lives in private `DATA/task-guard/wins/config.json`, keyed by UID. The
file contains `hub`, `owners` (`owner`, `name`), and constrained `peers`. Unknown
accounts display an unset owner. No live account mapping, private key, cookie or
production configuration is tracked in Git.

The monitored check writes per-run, fsynced JSONL events outside the immutable
release, and retains compatible private pending records. New feed adapters page
@/reply feeds by their cursors and private history by `end_seqno`, using the
existing page count and delay. End-of-list, covered count, stalled cursors and
invalid pages are handled explicitly. Incomplete scans still fail via task guard.
Only unread-triggered scans and the existing recent-reply tracking window run.

## Durable state and notification

Each host imports normalized events and old ledgers into additional winner tables
in the existing monitor database. The existing failure/daily tables are retained.
UID plus stable message identity prevents repeated first delivery. A cross-source
merge additionally requires the same sender, activity and exact content; different
accounts or different prizes are kept separate. Source IDs and old ledger IDs
are retained.

The USA hub merges the two fixed remote exports each minute and alone enqueues
winner PushPlus notices. This preserves one notification history when an account
appears on another host. Existing PushPlus credentials are read locally by task
guard, never added to exports. Outbox kinds and keys are separate from task
faults and daily reports. Failures/recoveries have dispatch priority.

Only successful delivery increments counters. Failed sends retain one pending
notice and retry after 5, 15, then 60 minutes. Clear winners repeat after two hours;
reviews deliver once. Dispatch rechecks the latest lifecycle and generation so
archive/reply/reclassification cancels obsolete notices. Manual confirmation
starts a winner generation; manual restore invalidates a cancelled generation.

Migration preserves IDs, notification counts and timestamps, acknowledged replies
and manual dismissal ledgers. It does not mass-resend history. Existing active
clear winners continue on their normal reminder clock. Raw events are retained
on import failure, which uses the existing failure/recovery machinery.

## Web and privileged boundary

The existing login/session implementation and `zj.niichi.me` entry remain. The USA
viewer lists all hosts with category, lifecycle, server, owner and UID filters;
stale remote data remains visible and is explicitly labelled. The former secondary
winner page redirects to the canonical page after normal authentication. Log
viewer routes remain available.

`GET /api/wins` retains status/counts/records and adds category, owner, source,
reason, synchronization state and filter options. Both `id` and `recordId` are
returned. Archived results also contain acknowledged and automatically filtered
records, with their actual lifecycle labels. `POST /api/wins/confirm`, existing
dismiss and restore routes require the session and `X-QLV-Action: 1`. Mutations
carry a stable `operationId`, UID and record ID and commit at the source before
returning success. Text uses DOM textContent and original links are validated.

The unprivileged viewer connects to `/run/qinglong-wins/gateway.sock`, mode 0660,
owned by root and the existing viewer group. A local constrained gateway validates
peer UID with SO_PEERCRED. JSON allows only list filters or the three validated
operations, never paths, SQL, scripts or arbitrary commands. The viewer retains
NoNewPrivileges and its existing sandbox; no sudo command is granted. The gateway
can write only its monitor/state directory and compatible dismissal ledger.
Only public viewer source gets read access, with directory traversal granted to
the existing viewer group; sensitive state remains root-private.

Remote dedicated SSH keys restrict the source IP, force `wins_agent.py`, deny PTY
and forwarding, and accept only literal `export` or `action`. Host keys are pinned.
Exports contain normalized winner records and enabled UID rosters, never cookies,
full API responses or configuration. Agent protocol is version 1. A lost action
acknowledgment can be retried with the same operation ID without applying twice.

## Deployment and rollback

The uniform release package includes `viewer`, `tools/wins.py`, deployment hooks
and the classifier. Prepare the private ownership/peer configuration and dedicated
keys first; deploy via `release_manager.py` in Wuhan, Singapore, USA order. New
checks activate on their next normal schedule. Existing check processes can finish.
The existing web service is restarted after its code switch; its session token
file is unchanged. Only the USA adds a per-minute winner synchronization timer.

Each deployment backs up legacy winner/state documents, viewer drop-ins, gateway
and synchronization units alongside the existing monitor snapshot.
Rollback restores prior viewer/service entries and release selection, retaining
winner tables and original events. Compatible dismissal ledgers remain in place;
old records and account progress are never restored over newer state. Disabled
winner resolvers reject remote commands when the selected release lacks support.

Validation uses synthetic accounts, local test servers, mocked SSH and PushPlus.
Tests cover the supplied three-prize announcement, paging, corrupt responses,
one pending send, backoff, successful acknowledgment, manual decisions, source
loss, invalid input, authentication and exact privilege boundaries. No test
executes a real platform interaction or sends a real prize push.

Pagination references: the upstream API collectors' original interface records at
https://github.com/huang3292/bilibili-API-collect-save/blob/master/docs/message/private_msg.md
and https://github.com/pskdje/bilibili-API-collect/blob/main/docs/message/msg.md.
