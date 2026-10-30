# Viewer input permissions

The task supervisor's private umask exposed a sharing bug: atomic replacements of
`web_state/local-accounts.json` and `lottery_info/pending_wins_*.json` became root-only.
The unprivileged web viewer then reported EACCES and could show incomplete counts.

Both writers now explicitly set mode 0640 on the temporary document and use the
group of the existing `web_state` directory before the atomic rename. On viewer
hosts this directory belongs to `qinglong-log-viewer`; on hosts without a viewer
it remains the task's group. Cookies and other files keep their existing rules.

`repair_viewer_permissions.py DATA SOURCE` backs up writer modules, permission
metadata and the code hash manifest, updates installed copies, and repairs only
existing viewer input documents without modifying contents. It does not start or
stop jobs, change schedules or edit account configuration. Backups are stored in
`DATA/backup/viewer-permissions-TIMESTAMP`. Restoring those modules and the hash
manifest reverses the code patch; permission metadata is in
`permissions-before.json`. Leaving the repaired read permissions in place avoids
immediately breaking the viewer again.

Validation covers initial creation and atomic replacement under umask 077,
including a different viewer group. Existing pending-win and account-import tests
also pass. After deployment, the actual viewer service user successfully listed
records on both viewer hosts with an empty warnings array. All three hosts have
the same source digest:
`47708e79f3f71ae55e0885d56897196bd292ca7dbcc8f6c6bdcfc4d97734b2e5`.

Document contents were unchanged, all monitored timers remained active, and no
business tasks were started or stopped by this repair.
