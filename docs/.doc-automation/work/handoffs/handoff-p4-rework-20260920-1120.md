# 交接记录 — P4 完成（返工版）

> 时间：2026-09-20
> 阶段：P4（质量门禁）已通过，运行模式 generate（重建）
> 触发原因：上一轮产物因重复 README、零图、零运行时证据被推倒重做

## 已完成步骤

- P0：`work/context-brief.md` 新增 `## 既有文档与去重策略`，用户定为「取代 README」；
  上一版简报留在 `context-brief.bak.md`
- P1：`work/doc-plan.md` 新增 `## 规模预算`，6 页每语言；`--phase p1` 退出码 0
- Batch-1 取证：真跑 doctor / start / status / capture / stop / secret / interaction，
  4 份终端实录落 `assets/transcripts/`，1 张真实截图落 `publish/assets/screenshots/`
- Batch-2/3：`publish/` 中文 6 页 + 英文 6 页 + `_agent-instructions.md`
- Batch-4：README 23KB → 9.6KB；`publish/` 整目录镜像到 `docs/guide/`；已 `git add`
- P4：`--phase p4` 退出码 0，`--drift` 无漂移；`work/quality-report.md` 含原始输出与 4 条降级

## 下一个会话要注意

- **`publish/` 是自带资源的**：图片放 `publish/assets/screenshots/`，页面用 `../assets/…`
  引用。这样镜像到 `docs/guide/` 是纯拷贝，不需要改写任何链接。
  不要把图片挪回工作区根的 `assets/screenshots/` —— 两处目录深度不同，镜像后链接会断
- 跨出 `publish/` 的链接（例如指向 `plugins/mobile-preview/README.md`）必须写仓库绝对
  地址，同样是因为镜像后深度变了
- 台账主表「文件路径」列**不要**用反引号包裹：capture 覆盖率检查直接匹配该列，
  带反引号会让截图证据被静默判成「无截图类证据」而全绿
- 重放那张截图需要 `assets/fixtures/demo/`（演示页 + 静态服务器），它有意放在
  `fixtures/` 而不是 `tmp/` —— `tmp/` 是发布后可整目录删除的
- 改文档的顺序：改 `publish/` → 跑门禁 → 重新镜像到 `docs/guide/` → 提交。
  直接改 `docs/guide/` 会被下一次镜像覆盖
- 版本变更时先看 `reference/commands.md` 的默认值是否仍与 `src/usage.js` 一致，
  该页已锚定指纹，`--drift` 能检出

## 未做的事

- 未推送到远程（`git push`），只在本地提交
- 未跑 `publish-post.mjs --llms`：本仓库无展示层，需要 `llms.txt` 时再补
- 未跑 `render-check.mjs`：无 Docusaurus 展示层
- 「本次未覆盖」清单见 `quality-report.md`，等用户点单
