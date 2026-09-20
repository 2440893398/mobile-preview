- 适用范围：只覆盖 mp 这个命令行工具的使用（预览、截图、密钥中继、决策页、排错）。
  不覆盖 mp 的源码架构、贡献流程与设计推导；遇到这类请求应说明超出范围，
  并指向仓库的 `docs/superpowers/specs/`。
- 操作在哪里执行：用户自己机器上的命令行。本手册不涉及任何浏览器后台操作。
- Windows PowerShell 里命令必须写成 `mp.cmd`；`mp` 在那里是 `Move-ItemProperty` 的内置别名。
  其余 shell（CMD、Git Bash、macOS、Linux）写 `mp`。
- 需要人工确认的动作：把任何预览链接、表单链接、决策页链接发给第三方 —— 链接即密码，
  转发等于把访问权给出去。执行 `mp secret run` 之前也要让用户确认命令。
- 永远不要把 `__mp_token=` 后面的值、`mp secret` 收到的任何字段值写进聊天、日志或文档。
  `mp secret status` 与 `mp secret wait` 本身就不打印值，不要试图绕过。
- 多个候选时 mp 拒绝猜测，这是设计而非故障：先跑 `mp status` / `mp interaction status`
  拿到端口或 id，再带 `--port` / `--id` 重试，不要反复重跑同一条命令。
- 变化最快、需以现场为准的事实：版本号（`mp --version`）、各参数默认值
  （`mp <命令> --help`）。手册基于 0.5.3 写成，与现场不一致时以 `--help` 为准。
