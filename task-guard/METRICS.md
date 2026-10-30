# 每日参与量监测

三台自动抽奖记录结构化事件，宿主机每分钟导入 `task-guard/metrics/local.sqlite`。武汉每五分钟增量汇总到 `hub.sqlite`，每天纽约时间 09:00 发送前一天的合并日报；按 `America/New_York` 处理跨日及夏令时。

上线前没有监测数据的日期不补发日报。首个监测日会标注观察期；每天日报只有一条，迟到数据修正本地历史，不重复推送整份日报。

成功仅取互动原始返回码 0，按 UID、动态和日期去重；候选多轮续接取集合，剩余队列取最新值；共享采集只在服务器层累计。全部正常跳过的候选不会触发零参与。耗时区分任务墙钟时间与账号处理时段，跨日切分。失败、中断、取消、缺失和迁移日不进入参与量基线。

同一账号、队列、纽约日期的候选仅增量写入，避免轮转期间反复写入整个队列。导出响应限制约 4 MiB，支持幂等游标、数据库代次变化和历史缺口识别；汇总按日加载明细，避免把 180 天的全部事件装进内存。中断账号的开放时段以已知任务终止时间为上限。

首次上线、账号新加入或迁移当天为观察期。连续两个完整日有可参与候选却成功为零才提醒；下降需七个有效日，七日中位数至少 10，连续两天低于一半才提醒。同一账号异常持续安静，恢复一次。统计写入故障不改变业务退出码，单独标记并告警。同步连续三次失败后合并提醒，补齐数据不重复发送历史日报或追发历史参与量异常。

通知使用原有 `monitor.sqlite/outbox` 和 PushPlus 通道，退避 5、15、60 分钟；日报键为纽约统计日期。180 天明细、365 天日汇总；只清理统计库和已导入且结束超过 180 天的统计日志，业务文件不清理。

远端 SSH 使用单独密钥，authorized_keys 同时指定武汉来源地址、`restrict` 和固定命令：

```text
from="HUB_PUBLIC_IP",restrict,command="/usr/bin/python3 DATA/task-guard/metrics.py export --root DATA/task-guard" ssh-ed25519 PUBLIC_KEY qinglong-participation-20261030-SERVER
```

仅接受 `since 非负整数`，通过只读 SQLite 连接导出固定版本统计字段；禁止任意命令、文件读取、PTY 和转发。武汉固定远端主机公钥，不使用自动信任。专用 SSH 绑定主路由的物理网卡，使透明代理环境下的连接仍以武汉地址直连，无需更改全局路由或代理规则。私钥、生产配置、统计数据库及真实账号数据不提交 GitHub。

离线测试：

```sh
node task-guard/test_lottery.cjs
node task-guard/test_metrics.cjs
python3 -m unittest discover -s task-guard -p 'test_*.py' -v
```

部署到独立 `20261030-metrics-v1` 目录，原先在跑的任务继续使用旧版本。只替换自动抽奖下一次的入口，清理、中奖检查和每日升级入口不变。首次部署不解析旧日志、不补造历史。

在武汉查询指定日期，不发送通知：

```sh
python3 DATA/task-guard/metrics.py report --root DATA/task-guard --day YYYY-MM-DD
```

回滚在每台宿主机运行 `python3 DATA/task-guard/rollback_metrics.py DATA`，恢复原抽奖入口、停用新增统计定时器、对应受限公钥与武汉的专用私钥，并取消尚未发送的统计通知。原失败监控和业务进度保留，已在运行的任务不中断。
