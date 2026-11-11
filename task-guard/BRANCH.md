# 专用分支说明

分支：`codex/qinglong-task-guard`，基于现有 `discovery-oom-fix`，保留三台服务器正在使用的采集内存修复。默认分支不变。

第三项统一发布、校验与回滚的当前入口为 `release_manager.py`，操作约定见 `RELEASES.md`。下面的一次性部署说明仅作历史记录；新发布不再直接运行旧部署脚本。

当前统一版本为 `20261111-runtime-wins-v1`。发布指针使用相对路径，校验覆盖容器内四类实际任务入口与文件哈希。无效发布入口会明确失败。中奖分类规则收紧宽泛关键词，并复核已有记录。验收见 `reports/runtime-wins-acceptance.json`。此前评论限额、清理与接口迁移验收见 `reports/task-recovery-acceptance.json` 和 `reports/upstream-api-acceptance.json`。参与量日报和中奖页说明见 `METRICS.md` 和 `WINS.md`。

现已包含第二项“每日参与量统计与异常提醒”。武汉每五分钟汇总三台统计，每天纽约时间 09:00 发前一天的合并日报；运行、统计口径、受限 SSH、保守提醒及回滚说明见 `METRICS.md`。

仓库根目录是已部署的抽奖代码；`task-guard` 保存宿主机检查器、启动器、离线测试、部署与回滚工具。`integrations/bilitool` 保存每日升级适配补丁及其精确上游基线。

离线结果测试：

```sh
node task-guard/test_lottery.cjs
python3 task-guard/test_guard.py
```

Python 检查器和测试需要 Linux。部署验收使用虚构账号、临时青龙任务和模拟推送发送器；三个验收报告位于 `reports`。真实推送送达没有作为测试结果声称通过。

部署脚本保留了本次服务器路径，准备阶段需要将此分支根目录下的 `main.js`、`lib`、`package.json` 和 `package-lock.json` 放入独立 `stage/lottery`，将 `task-guard` 放入 `stage/task-guard`，并按升级补丁说明构建 `stage/bili-publish.tar.gz`。脚本从该 stage 运行；它不会在生产目录中执行 git 拉取。现有部署已完成，无需因创建此分支再次部署。

分支不收录 Cookie、密钥、青龙数据库、生产配置、业务进度、程序包、服务器备份或包含真实账号路径的校验报告。本次仅上传源码、补丁、说明和虚构任务验收记录。

完整运行与回滚说明见 `README.md`，本次验收说明见 `IMPLEMENTATION.md`。这些文档保留首次部署时“未推送 GitHub”的历史描述；本分支是随后按用户要求建立的源码留档。
