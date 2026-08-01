# QingLong Log Viewer

一个独立、按字节分块读取的青龙日志查看器，并为 LotteryAutoScript 提供待领取中奖提醒管理。它不会调用青龙的整文件日志接口，也没有删除日志接口。

## 设计目标

- 默认只读取日志末尾 128 KB，大文件可立即打开。
- 首页默认进入 `LotteryAutoScript_start` 并自动打开最新日志。
- 自动识别 `LotteryAutoScript_start` 和 `LotteryAutoScript_check` 任务，为正在写入的日志显示“运行中”标记。
- 每 5 秒静默刷新运行状态，隐藏页面时暂停刷新。
- 64/128/256/512 KB 分块前后翻页。
- 服务端流式搜索，搜索时不把整份文件载入内存。
- 2 秒一次的可选自动追踪。
- 目录按需展开，不一次递归加载整棵日志树。
- 只允许访问配置的日志根目录，并拒绝符号链接越界。
- 独立登录页；用户名默认 `logs`，随机密码首次启动时生成并保存到状态目录。
- 登录后签发长期有效的 HttpOnly、Secure、SameSite 签名 Cookie，不在浏览器保存明文密码。
- 登录失败 5 次后按客户端限制 15 分钟，避免密码被持续尝试。
- 在窄窗口中固定使用视口高度和内部滚动，避免日志末行与滚动条底部被裁切。
- 登录后可查看本机完整中奖私信，并手动“取消提醒”或“恢复提醒”。
- 取消提醒只写入独立的 `web_state/dismissed-wins.json` 账本，不修改、标记已读或删除 B 站私信。
- 主副服务器分别读取本机帐号数据，并可通过页面按钮跳转到另一台服务器。

## 本机部署参数

- 日志目录：`/opt/1panel/apps/qinglong/qinglong/data/log`
- 监听地址：`127.0.0.1:5799`
- 外部路径：`https://qinglong.ereiss.top/log-viewer/`
- 凭据文件：`/var/lib/qinglong-log-viewer/token`
- LotteryAutoScript：`/opt/1panel/apps/qinglong/qinglong/data/scripts/LotteryAutoScript`
- 取消提醒账本：`LotteryAutoScript/web_state/dismissed-wins.json`

主副服务器使用相同登录凭据与签名密钥。实例名称和另一台服务器地址通过
`/etc/qinglong-log-viewer.env` 配置：

```ini
VIEWER_INSTANCE=主服务器
PEER_VIEWER_URL=https://qinglong2.example.com/log-viewer/
```

如果希望浏览器只登录一次，可把副服务器通过主域名的另一条路径反向代理，
参考 `deploy/nginx-single-login-location.conf`，并把主服务器的 `PEER_VIEWER_URL`
指向同域地址（例如 `https://qinglong.example.com/log-viewer-2/`）。登录页会同时签发
适用于 `/log-viewer` 和 `/log-viewer-2` 的同源会话 Cookie。

青龙升级或容器重建不会覆盖本服务，因为程序和 systemd 单元均位于容器外。
