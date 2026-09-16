# 通用人工介入交互层：调研与实施方案 v2

日期：2026-09-16。状态：研究与规划，未实施。取代同日 visual-decision-companion 初稿。

## 1. 重新定义问题

AI 在任务中需要人的知识、偏好、评价、纠正或授权时，经常输出长篇说明。用户要先读懂术语、重建关系、比较后果，再把答案组织回聊天。这些理解与表达成本才是要解决的问题。

产品目标：把 Agent 的人工介入请求，转化为当下最容易理解和完成的交互，再把有明确语义的反馈返回原任务。

暂名 Human Interaction Companion。HTML 是一种交付方式；产品的核心是「识别真正需要人的部分 → 帮助理解 → 收集反馈 → 恢复任务」。ELI5 是其中的解释策略。

先前五条业务材料仅保留为跨场景测试集中的一个样本。协议、组件、流程、命名均不得出现对这些 ID 或数据库领域的专门依赖。

## 2. 调研方式与结论边界

本轮访问官方文档、原作者仓库与人机交互设计指南，查看了 Superpowers 的浏览器事件源码。下文区分已有项目能力与本项目建议。没有安装或运行第三方 demo，未实测当前 Happy/Agent 宿主的 MCP Apps、elicitation 或恢复能力。

上轮本地检查发现现有 mobile-preview 有认证预览、CLI 与隧道基础设施，尚无人工介入模块；secret 正在开发。v2 将这些作为接入背景，不把它们绑定进通用核心。依赖版本、许可证细节与兼容性必须在实现前锁定。

## 3. 类似实现：按层复用

| 项目/规范 | 本次核实的能力 | 本项目的借鉴与边界 |
|---|---|---|
| [Superpowers Visual Companion](https://github.com/obra/superpowers/blob/main/skills/brainstorming/visual-companion.md) | 生成 HTML、呈现比较方案、收集选择事件供下一轮读取 | 借鉴按问题选择视觉表达；它主要用于视觉 brainstorm，不能直接当通用任务恢复服务 |
| [CopilotKit HITL](https://docs.copilotkit.ai/agent-spec/human-in-the-loop) | 自定义组件收集输入，以 respond 返回工具结果；另有图执行中断模式 | 最接近用户要的完整互动体验；自有 Agent Web 应用可直接评估采用，在外部 CLI 宿主中不能仅加一个 hook 就获得运行控制 |
| [OpenGenerativeUI](https://github.com/CopilotKit/OpenGenerativeUI) | 在沙箱 iframe 展示动态 HTML/SVG、图表、交互演示 | 借鉴自由图解的展示方式；它是 showcase，不据此宣称任意生成代码已满足本项目生产要求 |
| [json-render](https://json-render.dev/) | 限定组件与动作目录，AI 生成 JSON，绑定状态并渲染 UI | Web 首版渲染器优先候选：复用布局、校验和状态能力，只新增本项目的解释与反馈组件 |
| [A2UI](https://a2ui.org/) | 声明式界面协议、自定义组件目录与跨端渲染；[Actions](https://a2ui.org/concepts/actions/) 定义用户交互消息 | 适合未来跨客户端交换 UI；与 json-render 处在相邻层，第一版不同时维护两套完整渲染器 |
| [AG-UI](https://docs.ag-ui.com/introduction) | Agent 与前端间的事件协议，承载状态、工具交互等 | 适合受控 Agent 后端的适配；不是页面组件协议，也不自动为任意第三方宿主增加恢复接口 |
| [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) | 在支持的宿主中嵌入 HTML，经宿主桥接双向交互 | 宿主内入口优先候选；不支持时提供独立浏览器入口。普通 MCP 支持不等于 MCP Apps 支持 |
| [MCP Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) | 向用户请求输入，区分 accept/decline/cancel；有表单与 URL 模式 | 简单问题可直接走此通道；其表单能力不等价于任意可视化画布，URL 模式也不自动把页面内容回传 |
| [LangGraph Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | 持久化执行状态，用 interrupt/Command 暂停和恢复 | 借鉴关联中断 ID、持久化及重放原则；不为这一功能强制把已有 Agent 迁移到 LangGraph |

A2UI 官网在本次访问时列出 0.9.1 为 Current、1.0 为 Candidate。只作为访问时快照；实施时固定兼容版本，不混用不同版本的动作字段。[版本依据](https://a2ui.org/)

具体源码发现：Superpowers 的 [helper.js](https://github.com/obra/superpowers/blob/main/skills/brainstorming/scripts/helper.js) 使用 WebSocket 发送 click/choice 并处理重连。现有预览代理不转发 WebSocket，因此直接复用其传输存在兼容缺口；HTTP POST/结果查询或经过验证的宿主桥接更适合首版。

结论：已有基础设施覆盖了「生成界面、交互回传、持久化恢复」的不同部分。需要自己实现的是通用的介入语义、解释组织策略，以及当前宿主接入；不用重写全部 UI 框架或 Agent 编排器。

## 4. 通用场景与交互语义

按「人要做什么」建模，行业内容作为数据输入。

| 介入类型 | 泛化例子 | 适合的表达/操作 | 返回内容 |
|---|---|---|---|
| clarify：补充或澄清 | 受众、地区、时间、目标含义 | 简短表单、例子选择、自由回答 | 字段值、未知项 |
| choose：比较取舍 | 旅行路线、实现方案、服务选项 | 同维度比较、情景图、单/多选 | 选择与理由/条件 |
| configure：调整约束 | 预算、时间范围、质量阈值 | 数字、日期、范围、联动反馈 | 带单位参数、约束 |
| prioritize：排顺序/定范围 | 功能范围、待办优先级 | 排序、必选/可选/排除分组 | 有序 ID、分组 |
| review：审阅与纠正 | 文稿、图片方案、计划、数据映射 | 前后对照、逐项评论、局部修改 | 内容修订、锚点意见 |
| approve：批准具体行动 | 发送某封邮件、执行某次变更 | 精确目标和参数、修改/批准/拒绝 | 绑定目标版本的批准/拒绝 |
| recover：异常接管 | 外部服务不可达、数据缺失、尝试失败 | 已尝试事项与剩余路径、重试/换方案/暂停 | 恢复策略、补充信息 |

解释不是第八种互斥表单，而是贯穿所有类型的能力。用户随时可以选择「再解释」「举个例子」「这些选项都不合适」。以上是起始语义集合，可通过版本化扩展，并非穷举所有业务。

一个请求可包含多种类型，但只展示当前需要处理的部分；有依赖的项按依赖展开，独立项可以批量处理。不强制所有问题一页一题，也不把所有问题一次铺满。

## 5. 降低成本的交互原则

### 5.1 先减少不必要的问题

创建请求前确认：Agent 是否已能从上下文、既有授权或可读资料中得到答案？人提供的回答将改变哪个下一步？不能改变下一步的问题不应中断任务。

简单二选一或一个字段可在原聊天内完成；涉及关系、多个维度、内容审阅或反复调整时再升级 HTML。用户明确请求可视化时直接提供。网页入口是一种帮助，不变成所有任务的强制流程。

### 5.2 每次先解释「你需要判断什么」

默认展示：为什么需要你、你要操作什么、选择会改变什么。重要损失与不确定性紧邻操作区；机制细节、完整证据和原文逐层展开。ELI5 的通俗化不强制幼儿化比喻，用户可切换「简明/详细/专业」。

借鉴 Google PAIR：解释围绕当下的理解与行动，按需展开，而非在任务中解释系统的一切。[PAIR 设计模式](https://pair.withgoogle.com/guidebook-v2/patterns)

### 5.3 视觉必须表达关系

时间顺序用时间线，取舍用同维度比较，影响用前后对照，依赖用关系图，调参用有依据的结果预览。纯字段输入用表单即可。

模拟值必须标注计算规则、输入假设与估计性质。缺少模型或数据时提供定性情景，不能编造精确收益、置信百分比或“实时”预测。

### 5.4 允许纠正问题本身

提供「前提不对」「没有合适选项」「不知道」「暂缓」及自由输入；保留草稿与返回路径，不重复索取已有答案。复杂批次提交前提供可修改的摘要；低成本单题允许直接明确提交，无需层层确认。

借鉴 [GOV.UK Question pages](https://design-system.service.gov.uk/patterns/question-pages/) 与 [Check answers](https://design-system.service.gov.uk/patterns/check-answers/) 的问题聚焦、回答复用与提交前核对。

### 5.5 防止美观解释掩盖错误

事实、推断、建议、用户原始倾向与最终选择分别表示。不给 AI 推荐项伪造共识或默认批准；鼠标停留、浏览、点击探索均不表示授权。用户可以反馈到具体内容。

Microsoft HAX 提醒解释本身可能提升信任并导致过度依赖，因此本项目同时展示局限和纠错入口。[解释指南](https://www.microsoft.com/en-us/haxtoolkit/guideline/make-clear-why-the-system-did-what-it-did/)；[HAX 模式](https://www.microsoft.com/en-us/haxtoolkit/design-patterns/)

## 6. 架构：语义、展示、恢复分开

```text
原 Agent / 工作流
  → 介入整理器：提取真正的问题、依据、反馈契约
  → InteractionRequest：与领域和 UI 框架无关
  → 展示适配器：聊天表单 / MCP App / 浏览器 HTML
  → 用户理解、调整、追问或提交
  → 校验与持久化：InteractionResponse + receipt
  → 宿主适配器：回填工具结果 / 恢复中断 / 待读取
  → 原 Agent 继续任务并返回接收状态
```

**介入整理器**由当前 Agent 配合 skill 执行；首版无需另启一套模型服务或让用户配置第二套模型账户。技能提供解释准则、类型选择、组件目录和结构化输出要求。

**核心模块**只理解请求、答案、版本和状态，不理解 git、数据库、旅行或邮件业务；不依赖 mobile-preview 的进程或插件路径。可先在当前仓库实现独立边界，待需要复用时再拆包，不先拆多个仓库。

**展示**第一版优先验证 json-render 作为组件组合层。新增 ExplainPanel、Comparison、DiffReview、RankedList 等语义组件；基础表单与布局尽可能复用。至少支持“解释 + 参数 + 比较 + 反馈”的混合页面，不能锁死为几张固定选择卡。

**自由图解扩展**借鉴 OpenGenerativeUI：特殊解释可生成沙箱 HTML/SVG，与正式提交区隔离。仅经校验的消息桥回传候选值，最终结果在受控区域确认。扩展支持动态解释，但不是“沙箱里的任何按钮都能调用任意工具”。

**承载入口**：MCP Apps 可用时嵌入当前对话；普通浏览器配合 mobile-preview 满足手机访问；简单请求可映射到 MCP elicitation/宿主输入控件。三种入口共用核心结果契约。

**恢复适配**：自有 Web Agent 可直接采用 CopilotKit 的 respond 流程；已有 AG-UI/LangGraph 工作流使用对应恢复能力；外部 CLI/Happy 使用实际可用的工具等待或会话继续接口。不同宿主的支持必须分别验证。

## 7. 最小语义契约

这是本项目的领域无关语义，不宣称它就是 A2UI、AG-UI 或 MCP 标准字段；各适配器显式转换。

InteractionRequest：

- schemaVersion、requestId、revision、contentDigest。
- origin：host、conversationId、runId、toolCallId/interruptId（按宿主能力提供）。
- purpose、whyHuman、blockingScope、contextSummary。
- items：稳定 ID、kind、question、options/fields/contentRef、constraints、dependencies。
- evidence：sourceRefs、事实/推断标记、关键 unknowns；数据不足时允许明确为空。
- presentation：展示偏好与可选图解 spec，不作为提交校验的唯一依据。
- responseSchema：结果结构、单位、允许操作；批准类额外绑定 actionId、目标、参数摘要与 digest。
- resumePolicy：需要哪些项才能继续、哪些独立分支可先进行；超时默认不产生回答。

InteractionResponse：

- requestId、revision、contentDigest、responseId、服务端 receivedAt、receiptId。
- disposition：answered / declined / cancelled / deferred / needs_clarification。
- answers：values、orderedIds、contentEdits、annotations、conditions 等按 item.kind 校验。
- confirmedItemIds、未完成项、用户补充；不能只保存显示文本或“选了第二个”。

局部修订必须绑定内容版本和稳定锚点；全文有变化时不能盲套旧评论。批准仅适用于指定目标与参数，变更后旧批准失效。带条件的同意是约束输入，不直接等于可执行批准。

结果协议参考 MCP elicitation 区分接受、拒绝和取消的思路，但本协议增加暂缓与追问。只有真实适配 MCP 时才使用标准 action 字段；不向标准端点发送自定义 action。

## 8. 生命周期与回传可靠性

状态：draft → awaiting_human → submitted → delivered → applied。另有 cancelled、superseded；访问链接到期与业务结果保存独立管理。

- submitted：服务端已持久化，用户获得回执。
- delivered：目标宿主/工具调用确认收到。
- applied：Agent 或工作流已校验并应用到任务状态；不表示任务执行完成。
- request-more-context 是一次交互事件，后续文档有新 revision；被修改的题目重新确认，未变项保留草稿。

依照宿主能力选择同步工具结果、有状态中断恢复、或结果队列加受支持唤醒。不能承诺随便一个宿主都能后台唤醒。若只能持久化待读取，页面明确显示“已保存，等待任务恢复”，不假装闭环已完成。

存储按请求隔离、原子写入，重复提交使用幂等键。向宿主交付采用可重试队列，消费端按 responseId 去重；不能用“只发一次”承诺恰好执行一次。恢复前检查任务是否取消、内容是否过时和阻塞项是否仍存在。

LangGraph 官方明确恢复会重新执行节点，中断前副作用需要幂等；这一规则说明为什么页面提交去重和业务执行去重是两件事。[恢复与副作用依据](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

第一版只保存最小上下文与必要证据，不复制完整 transcript。结果不进入普通日志或 Git。单用户本地能力链接与多用户身份认证分开建模；部署多用户 MCP 服务时不能只用 sessionId 识别人。

## 9. 选型决策与复用清单

| 层 | 首版决策 | 何时改变 |
|---|---|---|
| 解释和介入识别 | 当前 Agent + 独立 skill；通用语义契约 | 质量评估表明需要独立内容服务时 |
| HTML 组合 | json-render 优先技术验证，避免自写全部组件解释器 | 若目标宿主已有成熟 A2UI renderer，则优先复用宿主能力 |
| 特殊图解 | 沙箱扩展位；首版先做一个可运行样例 | 多个陌生场景无法用目录表达时扩展 |
| 人机回合 | 借鉴/适配 CopilotKit HITL，不在外部宿主强行引入完整聊天系统 | 自有 Agent Web 应用可直接用 CopilotKit |
| 宿主内 UI | 官方 MCP Apps SDK 作为优先适配候选 | 实测宿主不支持则走浏览器 |
| 手机访问 | 复用 mobile-preview 的认证预览接口 | 网络或宿主原生入口更适合时 |
| 事件传输 | 本地 HTTP POST + 可恢复结果读取 | 受控后端需要标准事件流时接 AG-UI |
| 工作流恢复 | 宿主原生中断/恢复机制 | 自建工作流时评估 LangGraph 等现有编排器 |

不要首版同时集成全部框架。先完成一条真实宿主链路，再扩适配器。json-render 目前是优先候选而非已经安装验收的依赖；P0 必须记录包版本、许可证、构建体积、状态回传与失败降级证据，再确定采用。

与旧稿的关键变化：通用模块不再只是 mp decision 子命令；CLI 是可选适配入口。页面不再固定五条或三种图。完成标准不再只是“读取一个 JSON 文件”，而是语义准确并恢复到正确任务。

## 10. 分批实施与验收

### P0：复用验证与宿主闭环

输入三个跨领域小样例：补充活动日期、排序工作事项、审阅一段文稿。

验证 json-render 的状态与自定义组件；用当前宿主验证“请求 → 手机/内嵌页面 → 结构化回答 → 原任务继续”。核验 MCP Apps/elicitation 支持与连接生命周期，不依据产品名称推断能力。

交付：依赖与版本选择记录、宿主能力矩阵、一条成功回传记录、断线/宿主停止时的真实行为。闭环缺口优先解决，避免继续堆页面。

### P1：通用协议、技能与语义测试集

定义请求/响应 schema、状态机与适配接口。技能支持主动生成请求和把已有长篇说明转换为交互两种入口。来源中发现的问题保留为疑点，不能被压缩掉。

测试集至少覆盖七类介入，增加未参与模板设计的领域作为保留集。业务例子只放 fixtures，不进入核心条件分支。

### P2：组合 UI 与解释能力

实现表单、比较、参数输入、排序、内容对照与评论；共用解释、原文展开、追问和提交回执。支持一屏简单题与复杂多步骤两种编排，不固定题数。

生成内容先校验再激活提交。无效或不支持的图示退回结构化文本/表单，保留问题与已有答案。实现一个特殊沙箱图解样例，验证扩展边界。

### P3：持久化与恢复

实现重复提交、版本冲突、草稿恢复、部分回答、澄清迭代和跨会话隔离。增加交付队列与消费去重；恢复已有任务不重建无关任务。页面展示提交、送达和应用状态。

### P4：打包与第二入口

完成独立 skill 分发和当前宿主适配；依据 P0 结果先选 MCP Apps 或浏览器之一，再补第二入口。当前项目可新增 interaction 模块及必要的 CLI/help 接口；通过既有预览 API 集成，不依赖正在开发的 secret 内部实现。

### P5：验证降低理解成本与泛化能力

比较同等材料的「原长文本」「简短文本+普通选项」「交互界面」三种方式。不能仅证明比最差的长文本好；需要知道什么场景值得开页面。

用交叉安排的不同样例减少记住答案的影响。初期 5–8 人可用于形成性观察，不据此宣称统计显著；个人工作流先以用户实测为主。

测量：找到关键问题的时间、完成时间、对后果的理解正确率、遗漏约束/错误确认数、来回追问次数、主观费力程度，以及生成与打开页面的额外等待。

试验目标（待基线校准，并非已有结果）：复杂场景完成时间中位数降低约 30%，理解正确率不下降；关键约束漏失为零。简单问题不能因页面切换显著变慢，否则走聊天入口。

协议验收要求：重放测试中不出现重复应用、跨会话错投、过期批准被执行；未知组件可降级且答案保留。至少一个保留领域只通过数据/组件组合即可支持，无需修改核心业务代码。

## 11. 风险与后续演进

- AI 可把错误解释得更有说服力：保留来源、不确定性与前提纠正入口，以理解正确率而非点击完成率验收。
- 自由 HTML 增加生成延迟与执行风险：常见交互走组件目录，特殊图解沙箱隔离，最终提交协议保持统一。
- 插件不能控制所有宿主：明确能力检测与降级，不把 MCP、MCP Apps、elicitation、AG-UI 当成可互换名词。
- 抽象过度导致实现庞大：第一版只连接当前一个真实宿主；接口预留不等于一次实现所有适配。
- 个性化解释程度可先作为本次会话偏好；跨会话保存偏好需单独明确，不把探索点击当偏好结论。

最终定位：可复用的人机协作交互层。以现有界面框架、协议与恢复机制为基础，重点解决「什么时候问人、怎样让人看懂、怎样准确接回任务」。
