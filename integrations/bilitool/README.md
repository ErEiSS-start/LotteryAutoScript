# BiliBiliToolPro task-result integration

This directory preserves the source patch deployed with the QingLong task guard.
It does not change the upstream repository or require a fork of it.

- Upstream: https://github.com/RayWangQvQ/BiliBiliToolPro
- Exact source baseline: `401698e88abedd1ff16ac0e5833b78369d29c631`
- Runtime: .NET 10; the deployed runtime was 10.0.12.
- Patch: `task-guard.patch`, including the structured Console result sink and mocked interface tests.

Apply and build in a separate checkout:

```sh
git checkout 401698e88abedd1ff16ac0e5833b78369d29c631
git apply --check /path/to/task-guard.patch
git apply /path/to/task-guard.patch
dotnet test test/Ray.BiliBiliTool.DomainService.UnitTests --filter FullyQualifiedName~StructuredTaskResultTests
dotnet publish src/Ray.BiliBiliTool.Console -c Release -o /path/to/stage/publish
tar -czf /path/to/stage/bili-publish.tar.gz -C /path/to/stage/publish .
```

Only a monitored Daily process receives `TASK_GUARD_RESULT_PATH`; other Bili tasks
retain their existing behavior. The source baseline, patch and tests contain no
live cookies or PushPlus credentials. Published binaries and production backups
remain on the servers and are not tracked in this branch.
