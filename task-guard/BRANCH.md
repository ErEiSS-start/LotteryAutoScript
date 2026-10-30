# 专用分支说明

分支：`codex/qinglong-task-guard`，基于现有 `discovery-oom-fix`，保留三台服务器正在使用的采集内存修复。默认分支不变。

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
