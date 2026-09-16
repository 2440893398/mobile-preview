# Codex 提问工具与 PreToolUse 拦截：核实记录

日期：2026-09-16。本机 Codex CLI 0.154.0（`@openai/codex` npm 包，Windows x64 二进制）。来源：官方 hooks 文档（learn.chatgpt.com/docs/hooks）、`codex features list`、二进制内嵌字符串。未跑真实会话验证 deny 行为。

## 结论

1. **工具名是 `request_user_input`**，另有 `request_user_input_async` 变体。二进制里有它的入参校验文案（questions 非空、title 非空、options 至少一个非空答案），说明结构是「多题、每题若干选项」，与 Claude Code 的 AskUserQuestion 相近。
2. **PreToolUse 按文档可以 deny 它。** 覆盖表把 `update_plan`、`spawn_agent`、`request_user_input` 归为「other local function tools」，PreToolUse/PostToolUse 都是 Yes，matcher 直接写函数名（支持正则）。只有 hosted tools（如 WebSearch）不走本地 hook 路径。deny 方式与 Claude Code 相同：`permissionDecision: "deny"` + `permissionDecisionReason`，或退出码 2 带 stderr。模型能看到 reason。
3. **但在默认模式下，模型很可能根本不调用它。** 二进制里默认模式的系统提示原文：

   > In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. Use the `request_user_input` tool only for optional questions where the answer would materially improve the quality of the work. … If explicit user input is required for another reason before progress can safely continue, do not use the `request_user_input` tool. Ask the user directly with one concise plain-text question instead. Never write a multiple choice question as a textual assistant message.

   也就是说，Codex 被明确要求：必须问的问题用纯文本问，不要用工具。这正是本项目要拦的那类长文提问，而它不经过任何工具调用。
4. **可用性开关有两个，都未默认开。**
   - `codex features list` 显示 `default_mode_request_user_input` 处于 under development，值为 false。
   - 配置项 `tools.experimental_request_user_input.enabled`（ToolsToml 里的键）可手动开启。开了以后模型能调用，但上面那段提示仍在，仍偏向纯文本提问。
5. **Stop hook 可用。** 输入含 `last_assistant_message`（string 或 null）和 `stop_hook_active`；返回 `decision: "block"` 后 Codex 用 reason 生成续接提示重启回合。`hooks` 特性在 0.154.0 为 stable；`plugin_hooks` 显示 removed，但文档仍说插件可带 `hooks/hooks.json`，具体含义要真机看。

## 对 P0 §6 的影响

- Codex 侧第二层（PreToolUse 拦提问工具）技术上可行，但命中率取决于模型是否调用工具。默认模式下预期命中率很低，不能作为主力。
- Codex 侧第三层（Stop 兜底）是主要的事后保障，因为 Codex 把必答问题写在文本里，恰好落在 Stop 的判断条件内。
- Codex 侧第一层（SessionStart 注入）仍是主力，且要和上面那段系统提示对着看：我们的规则说「三个以上选项去开页面」，官方提示说「多选题不要写成文本」，两者不冲突，反而互补。
- 若要提高第二层命中率，可在 skill 里建议用户开 `tools.experimental_request_user_input.enabled = true`；这是用户配置，不由插件改写。

## 待真机验证

- `plugin_hooks` 为 removed 时，插件目录里的 hooks.json 是否仍被加载。
- PreToolUse deny `request_user_input` 后，模型收到 reason 是改走 `mp interaction ask`，还是退回纯文本提问。
- Happy 驱动的 `codex app-server` 会话处于哪种模式，`last_assistant_message` 是否非空。
