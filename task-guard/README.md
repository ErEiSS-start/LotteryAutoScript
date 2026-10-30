# 三台青龙结构化结果与宿主机告警

范围：start 自动抽奖、check 中奖检查、clear 清理、daily 每日升级。服务器账号分配、计划时间和互动参数不变。启动器不重跑业务。

## 运行布局

武汉数据目录 `/root/ql-runtime/data`；新加坡、美国宿主机数据目录 `/opt/1panel/apps/qinglong/qinglong/data`，对应容器内 `/ql/data`。

数据目录下：

- `task-guard/config.json`：任务 ID、服务器、部署起点、容器和青龙本地 API 地址，无推送凭据。
- `task-guard/releases/20261030-v1/lottery` 和 `bili`：隔离代码与程序包。原始目录的代码不覆盖；抽奖工作目录仍为原始目录，升级仍读取原有配置。
- `task-guard/runs`：运行编号、任务、账号、原因代码、起止时间、心跳、PID 和日志位置。
- `task-guard/results`：业务程序提交的结构化账号结果。
- `task-guard/monitor.sqlite`：故障状态、已处理运行编号、持久化推送队列。
- `backup/task-guard-20261030-v1`：原始代码、配置、程序包、任务命令、业务校验值与状态备份。目录含现有敏感配置，仅 root 可读，不应上传 GitHub。

宿主机 `qinglong-task-guard.timer` 每分钟调用独立检查器。心跳每 30 秒更新，超过 120 秒再核对 PID 和启动时间；僵尸进程视为已结束，无法联系 Docker 时保持未知，不能据此猜测进程已消失。容器明确停止也会识别。手动取消使用青龙 `RunningInstances.status=2`；错误为 `3`。

青龙会 source `.sh`，业务启动器在子 Shell 中执行，避免 `exec` 或 `set -e` 跳过青龙结束记录。业务退出码 0、1、2 分别表示成功、整体失败、部分失败；外部退出码和信号按实际状态转发。青龙自身源码不修改。

## 告警

故障键为服务器、任务、账号/全局、阶段、原因代码。每轮新故障合并发送，相同故障持续不重复；明确成功的账号或阶段恢复一次。手动取消不改变故障状态，不发送故障或恢复。

PushPlus 凭据每次从本机青龙启用的 `PUSH_PLUS_TOKEN`、`PUSH_PLUS_USER` 读取，不另存副本。失败队列按 5、15、60 分钟重试，此后每 60 分钟重试。业务结果与推送结果独立；已消失的待发旧故障会丢弃，未成功发送的故障不发送恢复通知。

结构化结果不保存 Cookie、密钥、异常原文或接口响应。旧登录失效推送仅在受监测的任务中停用；中奖通知保留。

## 验证与回滚

`test_guard.py` 覆盖结果分类、故障去重、原因变化、独立恢复、持久化退避、手动取消、容器停止、OOM 证据以及真实假子进程的非零退出和 SIGKILL。

`test_lottery.cjs` 模拟依赖和账号，不联网。Bili `StructuredTaskResultTests` 使用模拟接口验证观看、投币异常与分享 -403、余额不足、保护余额。

`ql_acceptance.py DATA RUNTIME_DATA` 仅创建临时假任务和虚构账号，推送发送器也使用模拟实现。覆盖青龙错误状态 1/2/137、持续故障安静、一次恢复、手动停止和启动器被杀。结果保存于 `task-guard-acceptance/report.json`，临时任务及入口随后删除。测试不运行真实抽奖、投币、评论、转发。

回滚前可查看 `deployment.json`、`verification.json` 和备份。恢复入口：

```sh
python3 DATA/task-guard/rollback.py DATA
```

将 DATA 替换为上面的宿主机数据目录。仅恢复原始任务命令和抽奖入口，关闭检查定时器，不中断正在运行的任务，不回退任何业务进度，不删除发布目录或证据。若上线后手工改过入口，先核对差异。

未更新上游版本，未推送 GitHub 或修改默认分支。当前正在运行的旧版本任务继续完成；下一次运行使用新入口。
