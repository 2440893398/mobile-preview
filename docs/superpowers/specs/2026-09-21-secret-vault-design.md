# mobile-preview 密钥保存、使用档位与配置文件渲染设计

日期：2026-09-21
状态：已实现（feat/secret-vault 分支，未发版）；实现中的调整已写回各节，另见 §16
前置：[2026-09-11-secret-relay-design.md](2026-09-11-secret-relay-design.md)（下称「中继设计」）

## 1. 背景

中继设计的第一版里，值只存在一个 daemon 的内存里，TTL 到期就消失。真机用下来有两个问题：

- **每次新会话都要重填。** 用户在手机上，得回云控制台翻 AccessKey。整个流程里最麻烦的
  那一步，每次都要重来一遍。
- **只认配置文件里真值的工具用不了。** 中继设计 §5.4 让 AI 通过 `mp secret run` 跑工具
  自带的 configure 命令，但很多工具没有这种命令，只能在配置文件里写死密钥才能运行。

本设计补三件事：加密保存（§4）、使用档位（§5）、render（§6）。三者共用一张手机表单和
一份 vault 格式，所以放在一起设计。

## 2. 事实基础

| 事实 | 出处 | 影响 |
|---|---|---|
| DPAPI、macOS 钥匙串、libsecret 都按「当前系统用户」授权。AI 以同一用户运行，一行 `ProtectedData.Unprotect` 就能解开 | 中继设计 §4.4，本机已验证 | 系统加密只挡「不小心」，挡不住「故意」。这是整个设计的边界 |
| Chrome 2024 年承认 DPAPI 挡不住同用户的恶意程序，专门做了 App-Bound Encryption，几个月内被窃密木马绕过 | [Red Canary](https://redcanary.com/blog/threat-intelligence/google-chrome-app-bound-encryption/) | 同用户防护连 Google 也没解决，本设计不追求 |
| 2025-08 Nx 投毒（s1ngularity）调用本机 Claude Code / Gemini CLI，加 `--dangerously-skip-permissions` 让它们翻文件找密钥，泄露 2349 个 | [The Hacker News](https://thehackernews.com/2025/08/malicious-nx-packages-in-s1ngularity.html) | 「AI 翻文件找密钥」是真实攻击面。通用扫描下明文会被整批拿走，密文不会 |
| `trycloudflare.com` 在公共后缀列表里（2026-09-21 查，第 12704 行） | [publicsuffix.org](https://publicsuffix.org/list/public_suffix_list.dat) | 每条隧道都是一个独立站点：手机浏览器存储、passkey、密码管理器自动填充都带不到下一条隧道。解锁因子只能是用户**输入**的东西 |
| 用户在手机上，不在电脑前 | 使用场景 | Windows Hello / Touch ID 的本机确认没人能按 |
| gh CLI 找不到系统钥匙串时退回明文存储；有用户把这当缺陷报过 | [gh auth login](https://cli.github.com/manual/gh_auth_login)、[cli/cli#10108](https://github.com/cli/cli/issues/10108) | 反例。本设计没有钥匙串就不提供保存 |
| Node 内置 `crypto.scrypt`；`crypto.argon2` 要 Node ≥ 24.7 | [Node 24.7.0 发布说明](https://nodejs.org/en/blog/release/v24.7.0)、`package.json` 的 engines 是 ≥ 20 | 主密码的 KDF 用 scrypt |
| 受限语言模式（企业 AppLocker / WDAC）下 PowerShell 的 `Add-Type` 不可用 | PowerShell 文档 | DPAPI 可能调不起来，要探测，不能假定 |

## 3. 目标与非目标

### 目标

- 同一项目再次需要同样的值时，用户不用重新翻密钥
- 常用、泄露也不太敏感的值，做到「存一次，以后不打扰」；敏感的值由用户选更严的档
- 磁盘上只有密文：AI 不小心读到、恶意包批量扫描、文件被同步 / 备份 / 误提交，都拿不到值
- 只认配置文件的工具也能用：AI 写模板，mp 填值，AI 全程看不到值
- 存不存、存哪一档、写哪个文件，都只能在手机上决定。AI 的命令行只能往严里调、不能往松里调

### 非目标

- 不对抗故意作恶的 AI，边界与中继设计 §7 相同。主密码档是唯一的例外，而且取决于口令强度
- 不做密码管理器：没有搜索、分享、导入导出、跨机器同步
- 不做找回：忘了主密码，就重新从云控制台复制一遍。存的只是缓存，真源在云控制台
- 第一版不做跨项目共享（§13）

## 4. 保存

### 4.1 存在哪、存什么

目录：`%LOCALAPPDATA%\mobile-preview\vault\`（`state.js` 的 `stateDir()` 下，受 `MP_STATE_DIR` 控制）。

| 文件 | 内容 |
|---|---|
| `vault.key` | 库钥匙 K 包装后的 blob、包装方式（`dpapi` / `keychain` / `libsecret`）、版本；设了主密码时还有 scrypt 参数和校验值 |
| `<projectId>.json` | 一个项目一份：项目根路径（明文，用于展示）、每个字段的密文与元数据、记住的用途、记住的渲染目标 |
| `audit.log` | 保存、使用、篡改、过期、删除、渲染，逐行 JSON |

项目按根目录区分：从 `mp secret ask` 的 cwd 跑 `git rev-parse --show-toplevel`，不在仓库里就用
cwd 本身；取 `realpath`，Windows 上转小写；`projectId` = SHA-256 的前 16 位十六进制。

```json
{
  "version": 1,
  "root": "c:\\users\\24408\\ideaprojects\\my-app",
  "fields": {
    "OSS_ACCESS_KEY_SECRET": {
      "kind": "secret", "level": "auto",
      "savedAt": 1790000000000, "expiresAt": 1797776000000,
      "length": 30, "sha256_8": "4f7d31a0",
      "iv": "…", "ct": "…",
      "lastUsedAt": 1790500000000, "useCount": 7
    }
  },
  "uses": [{ "use": "npm run deploy", "fields": ["OSS_ACCESS_KEY_ID", "OSS_ACCESS_KEY_SECRET"] }],
  "files": [{ "template": "…\\config.yml.tpl", "out": "…\\config.yml", "keep": false, "fields": ["OSS_ACCESS_KEY_SECRET"] }],
  "mac": "…"
}
```

`length` 和 `sha256_8` 沿用中继设计的指纹，供用户核对是否填错。state 文件（`secrets\<id>.json`）
里仍然**永远没有值**，这一条不变。

### 4.2 钥匙层级（信封加密）

```
字段值 ──AES-256-GCM──> 密文        档位 auto / confirm
          ↑ 库钥匙 K（32 字节随机，整个 vault 一把）
          ↑ 系统钥匙串包装 → vault.key

字段值 ──AES-256-GCM──> 密文        档位 passphrase
          ↑ K_p = HKDF( K ‖ scrypt(主密码, salt) )
```

**库钥匙 K** 在第一次保存时生成，由系统钥匙串包装：

| 平台 | 包装 | 注意 |
|---|---|---|
| Windows | DPAPI（CurrentUser），`powershell -NoProfile -NonInteractive -Command <脚本>`，数据走 stdin/stdout | 同一用户能看到别的进程的命令行，所以 K 绝不放进 argv；optional entropy 用常量 `mobile-preview-vault-v1`，只做域隔离，不是秘密 |
| macOS | 钥匙串 generic password，`security -i` 从 stdin 读命令 | 同上，`add-generic-password -w` 的值不能出现在 argv |
| Linux | libsecret，`secret-tool store` 从 stdin 读 | 无头服务器通常没有 Secret Service |

第一次保存前做一次包装→解包往返。失败（没有钥匙串、受限语言模式）就判定不可用：表单里不
出现保存选项，改显示一行「这台电脑没有可用的系统钥匙串，不能保存」；`mp secret ask` 的输出
也告诉 AI 这一点。**不退回明文，也不退回「密钥文件放在旁边」**——那只是把明文换了个名字。

**主密码档 K_p**：`HKDF-SHA256(ikm = K ‖ scrypt(主密码, salt, 32), info = "mp-vault-passphrase-v1")`。
两样缺一不可：文件被拷走，DPAPI 解不开 K；AI 在本机，不知道主密码。

- scrypt 参数 N = 2¹⁷、r = 8、p = 1（OWASP 推荐值），内存 128 MiB。Node 默认的 `maxmem` 是
  32 MiB，要显式传 `maxmem: 256 MiB`，否则直接抛错
- 一个 vault 一个主密码，第一次选主密码档时在手机上设置（输两遍）。`vault.key` 里存 salt、
  参数和一个校验值（用 K_p 加密的常量），用来区分「主密码错」和「数据坏了」
- 主密码至少 6 位，纯数字也行，像支付密码一样（用户 2026-09-21 的决定，见 §13；原方案是至少 12 个字符、
  不能全是数字）。表单检查一遍，daemon 再检查一遍。要清楚它和支付密码的差别：支付密码有服务端数错误次数，
  这里没有——AI 读得到密文，可以离线逐个试。6 位纯数字只有 10⁶ 种，按每次 0.3 秒算，单核约 3.5 天，
  8 核约 11 小时。所以短主密码对故意偷取的 AI 是**拖延**，不是**挡住**；位数和字符种类越多，拖得越久。
  表单上的说明据此写成「位数越多越难猜」，不再说「只有这一档能挡住」
- 解锁后 K_p 只在这个 slot 的 daemon 内存里，slot 结束即清除；下一个会话再输一次

K、K_p 的 Buffer 用完即 `fill(0)`（尽力而为，V8 可能留有副本）。

### 4.3 防篡改

AI 以同一用户运行，改 vault 的 JSON 很容易，比如「顺手」把档位改松、给自己加一条用途。两层处理：

- **档位与到期写进附加数据。** 字段密文的 AES-GCM 附加数据是
  `mp-vault-v1|<projectId>|<字段名>|<kind>|<level>|<expiresAt 或 never>`。改了其中任何一项，
  这个字段就解不开：按「未保存」处理，要求重填，并写一条 `tamper` 审计
- **用途与渲染目标加 HMAC。** `mac = HMAC-SHA256(HKDF(K, projectId, "mp-vault-mac-v1"), 规范化的 {uses, files})`。
  校验不过，这两份清单整体作废，回到逐项在手机上批准，同样写审计

这两层挡的是「不持有 K 的一方」，以及热心修改 JSON 的 AI。蓄意的 AI 可以先用 DPAPI 拿到 K
再重算——与 §2 第一行是同一条边界，这里不重复宣称能防。

`lastUsedAt`、`useCount` 这类统计字段不在保护范围内，改了也没关系。

### 4.4 谁读写 vault

- **只有 daemon 解密。** CLI 进程从不持有 K，也从不持有值
- CLI 可以直接读 JSON 里的明文元数据（`mp secret saved` 靠这个），也可以删条目（删除不需要 K）
- 保存发生在手机提交之后：daemon 解开表单密文 → 用 K 或 K_p 加密 → 原子写 `<projectId>.json`

### 4.5 过期

保存时在手机上选：7 天 / 30 天 / **90 天（默认）** / 不过期。

在 DPAPI 档，过期挡不住蓄意的 AI（它在有效期内随时能解）。过期的作用是清理不再用的条目、
提醒用户轮换密钥，所以默认值偏长。到期后下次 `ask` 会开页面，页面上除了重填，还提供
「续期（值不变）」：点一下，用原值重新加密、换上新的到期时间，不用重新输入。

## 5. 使用档位

### 5.1 四档

保存时在手机上选一档，作用于这次提交的所有字段：

| 档位 | 以后怎么用 | 对故意偷取的 AI | 适合 |
|---|---|---|---|
| **直接用** `auto`（勾选保存后默认选中） | 批准过的命令直接跑，不开隧道，不打扰手机 | 挡不住 | 常用、泄露了也能随时禁掉的：测试环境、只读账号、单 bucket 子账号 |
| **点一下** `confirm` | 每个会话在手机上确认一次，管整个 slot 有效期（默认 120 分钟） | 挡不住，只起知情作用 | 想知道 AI 什么时候在用的 |
| **主密码** `passphrase` | 每个会话输一次主密码 | 拖延：得先离线猜中主密码。6 位纯数字约 8 核半天，越长越久 | 生产环境、能花钱的 |
| **不保存** | 与现在相同，每次重填 | 值不落盘 | 最敏感的，例如数据库 root |

表单上「在这台电脑上记住」**默认不勾**，要用户主动选；勾上后档位默认「直接用」，下面一行
提示「生产环境、能花钱的钥匙，建议选更严的档」。

「点一下」这一档要写清楚它的性质：在只靠系统加密的前提下，确认页是**知情**手段，不是**强制**
手段。故意的 AI 可以绕过确认直接解密。真正的强制只有主密码档。

### 5.2 `mp secret ask` 遇到已保存的值

按本次请求的字段查当前项目的 vault，多个字段档位不同时取最严的：

| 情况 | 结果 |
|---|---|
| 字段全部已保存、未过期、都是 `auto`，且 `--use` / `--render` 都在记住的清单里 | daemon 直接解密，进入 `filled`，**不开隧道** |
| 同上，但有没批准过的用途或渲染目标 | 开「批准新用途」页（沿用现有 `approve` 模式），只列新的那几项，值不重填 |
| 有字段是 `confirm` | 确认页，点一下 |
| 有字段是 `passphrase` | 确认页加主密码输入框 |
| 有字段没保存或已过期 | 填写页：已保存的显示为「使用已保存」，只需填缺的；过期的可以续期 |
| 带了 `--refill` | 填写页，这些字段全部重新输入，旧值不预填 |

- 记住的用途连同批准时的字段一起存：`npm run deploy` 批准给 OSS 的两个字段，不等于也批准给数据库密码。
  一条记录只在它的字段覆盖本次全部字段时生效（`appliesTo`）；生效的记录全部视为已批准，`ask` 带不带 `--use` 都一样
- 字段 `kind` 以保存时为准（它在附加数据里）；本次声明为 `secret` 的，按 `secret` 打码
- 确认页上取消勾选某条记住的用途，就把它从清单里删掉。确认页也是修剪清单的地方

### 5.3 一直生效的护栏

这几条不需要用户做任何操作：

- **用途清单照旧。** 「直接用」只覆盖批准过的命令和渲染目标，逐项相等匹配（`argv.js` 的
  `findApprovedUse`，不变）。出现新命令才问一次，批准后记住
- **档位只能在手机上改松。** CLI 能删条目（`mp secret forget --saved`），不能改档位
- **审计。** 每次解密都写 `vault/audit.log`：哪个 slot、什么时候、哪一档、哪些字段。
  `mp secret saved` 列出每个字段的最近使用时间和次数
- **输出打码照旧。** `mp secret run` 的输出仍由 daemon 按中继设计 §5.3 打码
- **兜底靠凭证本身。** 「直接用」这一档最适合配权限很窄的凭证，泄露了到控制台禁掉即可

## 6. render：把值写进配置文件

### 6.1 什么时候用

按以下顺序选，SKILL.md 也照这个顺序教 AI：

1. **工具能读环境变量**（dotenv 系、docker compose、Spring 的 `${}`、Prisma 的 `env()`、aws / ossutil 等 CLI）
   → 配置里写引用或留空，用 `mp secret run` 注入。磁盘上没有真值
2. **工具有自己的 configure 命令，并且能从环境变量或 stdin 取值** → 通过 `mp secret run` 跑它
3. **工具只认文件里的真值** → render

render 让明文落盘，比前两种弱一档：它挡得住「不小心读到」，挡不住「故意」（§8）。

### 6.2 模板

AI 写模板，模板里只有占位符，可以提交进 git：

```yaml
# config.yml.tpl
oss:
  bucket: my-bucket
  access-key-id: {{mp:OSS_ACCESS_KEY_ID}}
  access-key-secret: {{mp:OSS_ACCESS_KEY_SECRET|json}}
database:
  url: postgres://app:{{mp:DB_PASSWORD|url}}@localhost/app
```

| 写法 | 输出 | 用于 |
|---|---|---|
| `{{mp:NAME}}` | 原样 | 值里没有特殊字符时 |
| `{{mp:NAME\|json}}` | `JSON.stringify(value)`，带引号 | JSON、YAML、TOML 的字符串 |
| `{{mp:NAME\|url}}` | `encodeURIComponent(value)` | 连接串里的密码 |

- 只认本 slot 的字段名。有未知占位符，**一个文件都不写**，直接报错
- 这三种形态恰好是 `scrub.js` 已经登记的变形（本体、JSON 转义、URL 编码），工具把配置打印
  出来时照样被打码

### 6.3 命令与文件寿命

| 命令 | 文件什么时候删 |
|---|---|
| `mp secret run --id X --render config.yml.tpl=config.yml -- npm start` | 命令退出时 |
| `mp secret render --id X config.yml.tpl=config.yml` | slot 结束时（TTL 到期或 `forget`） |
| 上面任一，且目标用 `--render-keep` 声明、在手机上批准 | 不自动删，`mp secret forget --files` 删 |

- 模板和输出用 `=` 分隔，不用 `:`，因为 Windows 路径里有盘符冒号
- `--render` 可以出现多次
- 渲染目标和命令一样是一项「用途」：`ask` 用 `--render` 声明，手机上显示为
  「写入 `C:\…\config.yml`（用完即删 / 一直保留）」，由用户勾选。批准的是**模板路径 + 输出路径**
  这一对；模板内容 AI 可以随时改（比如改端口），不需要重新批准
- 输出路径在项目根目录之外的（例如 `~/.ossutilconfig`），手机上额外标一个「项目外」

### 6.4 写入前检查

由 daemon 执行，任何一条不通过都不写：

1. 输出路径与批准的完全一致（解析为绝对路径并 `realpath` 后比较）
2. **git 检查**：输出在某个 git 工作树内时，必须被 `.gitignore` 忽略（`git check-ignore -q`），
   并且未被跟踪（`git ls-files --error-unmatch` 失败）。否则提示先把它加进 `.gitignore`。
   配置文件被提交进 git，是密钥最常见的真实泄露途径
3. **不覆盖手写的文件**：输出已存在、又不是 mp 上次渲染的（state 里有路径和指纹记录），就拒绝
4. 原子写（临时文件 + rename）；POSIX 上权限收紧到 `0600`。Windows 上不改 ACL：项目通常在用户目录下，
   本来就只对本人开放，去掉继承反而可能让以 SYSTEM 身份运行、合法读取配置的服务读不到。
   这一步防的是别的系统用户，不是 AI

写完后在 state 里记 `renderedFiles: [{ path, template, lifetime, sha256_8, renderedAt }]`；
「一直保留」的记进 `vault\kept-files.json`（路径与指纹，不是秘密），hook 和写入前检查都读它。

### 6.5 写入后保护

- **hook 拦读写**（§9）：AI 用 `Read` / `Edit` / `Write` / `Grep` 碰这些路径，或在 Bash / PowerShell
  命令里提到它们（`mp secret` 自己的命令除外），一律 `deny`。拒绝理由告诉 AI：改模板、重新渲染，
  要核对内容用 `peek`
- **`mp secret peek --id X config.yml`**：daemon 读文件，用它持有的值打码后返回。AI 能核对格式
  对不对，看不到值。只接受本 slot 渲染过的文件和本项目「一直保留」的文件。值不跨进程边界，
  这一条仍然由构造保证
- **删除与孤儿清扫**：命令退出、slot 结束时删除；daemon 崩溃留下的文件，由下一次
  `mp secret status` / `forget` 按 state 里的记录清扫——state 文件比 daemon 活得久，所以找得到
- 目录级搜索：ripgrep 默认跳过被 `.gitignore` 忽略的文件，第 2 条检查顺带让它们不进搜索结果。
  Claude Code 的 `Grep` 工具是否沿用这一默认行为，⚠️ 待验证

## 7. 手机端

### 7.1 填写页新增的部分

```
填写凭证 —— 配置 OSS 上传
项目：C:\Users\24408\IdeaProjects\my-app

OSS_ACCESS_KEY_ID      [••••••••]  显示
OSS_ACCESS_KEY_SECRET  [••••••••]  显示

允许 AI 用这些值：
 ☑ 运行 npm run deploy
 ☑ 写入 C:\…\config.yml（用完即删）

☐ 在这台电脑上记住（加密保存）
    档位   ◉ 直接用   ○ 点一下   ○ 主密码
    有效期 [ 90 天 ▾ ]
    生产环境、能花钱的钥匙，建议选更严的档

[ 加密并提交 ]
```

- 页面顶部显示项目路径，用户据此判断是不是自己那个项目
- 选「主密码」时展开主密码输入框：第一次是「设置 + 再输一遍」，之后是「输入」
- 没有可用钥匙串时，整个保存区块换成一行灰字

### 7.2 确认页（`confirm` / `passphrase` 档）

```
使用已保存的凭证？ —— 配置 OSS 上传
项目：C:\Users\24408\IdeaProjects\my-app

OSS_ACCESS_KEY_ID      24 位 · 9c1e0b2a · 12 天前保存
OSS_ACCESS_KEY_SECRET  30 位 · 4f7d31a0 · 12 天前保存

允许 AI 用这些值：
 ☑ 运行 npm run deploy
 ☑ 运行 node scripts/check-oss.js   新

[ 主密码 •••••••• ]        ← 仅 passphrase 档
[ 使用已保存的值 ]
重新填写
```

- 「重新填写」把字段换成输入框，并展开保存区块（默认沿用原来的档位）。重新填写时取消「记住」就等于删除：
  重新输入、又不再保存的字段，旧的保存记录会被删掉。所以不单设「删除」按钮
- 主密码连续输错 5 次，表单关闭。这是在线限速；真正的上限是 §4.2 的离线爆破成本
- 已过期的字段标「已过期」，并提供「续期（值不变）」

### 7.3 传输

- 主密码与字段值走同一条 ECDH + AES-GCM 通道（中继设计 §4.3），占用保留字段名 `__mp_passphrase`。
  `parseFieldSpec` 要拒绝 `__mp_` 开头的字段名——现在的 `FIELD_NAME_RE` 允许下划线开头
- 保存与否、档位、有效期、渲染审批这些选择，和现在的 `uses` 一样以明文 JSON 提交。被动的
  边缘节点改不了它们；主动篡改页面的中间人本来就能拿到值，中继设计 §4.3 已声明不防

## 8. 威胁模型增量

在中继设计 §7 之上新增：

| 威胁 | 处置 | 依据 |
|---|---|---|
| AI 不小心读到 vault 文件 | 只有密文 | 构造 |
| 恶意包、扫描器批量搜密钥 | 只有密文，得专门针对本工具写解密代码 | 构造（对通用扫描） |
| vault 被同步、备份、拷到别的机器 | DPAPI 绑定本机、本用户 | 构造 |
| AI 改 vault 元数据，把档位改松、加用途 | 档位与到期在附加数据里，清单有 HMAC，改了即失效 | 构造（对不持有 K 的一方） |
| AI 故意用系统钥匙串解开 `auto` / `confirm` 档 | **挡不住**；hook 拦最直白的写法 | 策略 |
| AI 故意解 `passphrase` 档 | 需要主密码；可离线爆破，6 位纯数字约 8 核半天，长口令才真正挡得住 | 构造（强度由用户的主密码决定） |
| render 出来的文件被提交进 git | 写入前检查 gitignore 与未跟踪 | 构造 |
| render 出来的文件残留 | 命令结束 / slot 结束即删，孤儿按 state 清扫 | 构造 |
| AI 不小心读到 render 出来的文件 | hook 拦读取；`peek` 给打码视图 | 策略 |
| AI 故意读 render 出来的文件（写个脚本去读） | **挡不住** | — |
| 保存把暴露窗口从 2 小时拉长到几个月 | 档位由用户选；审计；凭证做窄 | 用户决策 |

## 9. 插件侧

### 9.1 hooks

| 事件 | 匹配 | 决策 | 目的 |
|---|---|---|---|
| `PreToolUse` | `Read\|Edit\|Write\|MultiEdit\|Grep\|NotebookEdit` | 路径命中 render 出来的文件 → `deny` | 落盘真值的读写保护（中继设计 §6.1 第三行，当时留给 1.1） |
| `PreToolUse` | `Bash\|PowerShell` | 命令提到 render 出来的文件，且不是 `mp secret` 命令 → `deny` | 拦 `cat`、`Get-Content`、`copy`、`git add -f` 等 |
| `PreToolUse` | `Bash\|PowerShell` | 命令提到 `vault.key`，或同时出现 `mobile-preview` 与 `Unprotect` / `CryptUnprotectData` / `find-generic-password` / `secret-tool lookup` → `deny` | 拦「我帮你解开看看是不是填错了」的热心 AI |
| `PreToolUse` | `Read` | 路径是 `vault.key` → `deny`，理由指向 `mp secret saved` | 同上 |

- 受保护路径的来源：`secrets\*.json` 的 `renderedFiles`，加上 `vault\kept-files.json`。
  hook 每次触发时现读，文件都很小
- `hooks.json` 现在只给 `Bash|PowerShell` 和提问工具挂了 `PreToolUse`，要新增一条文件工具的匹配
- 和现有规则一样只用 `deny`，理由见中继设计 §6.1。启发式规则一定有漏，它们是最后一道防线
- Codex 的文件工具名与 Claude Code 不同，覆盖面 ⚠️ 待验证

### 9.2 SKILL.md 与 SessionStart

- 配置文件三选一的顺序（§6.1），替换现在「用工具自带的 configure 命令」那一段
- `mp secret ask` 可能直接返回 filled——那是用户保存过、选了「直接用」，不需要再等手机
- 不要读 vault，也不要尝试解密。核对值对不对，看指纹，或跑一条批准过的检查命令；检查命令报
  鉴权失败，就用 `--refill` 重新要
- 永远不要自己把值写进文件：写模板，用 `--render`

## 10. 命令面变化

| 命令 | 变化 |
|---|---|
| `mp secret ask` | 先查 vault，结果三种：直接 `filled`（没有链接）、确认页链接、填写页链接。新增 `--render TPL=OUT`、`--render-keep TPL=OUT`、`--refill`。JSON 增加 `source: "saved" \| "form"` 和 `level` |
| `mp secret wait` | 不变；对已经 `filled` 的 slot 立即返回 |
| `mp secret run` | 新增 `--render TPL=OUT`，可重复 |
| `mp secret render` | 新增。`--id X TPL=OUT…`，渲染并留到 slot 结束 |
| `mp secret peek` | 新增。`--id X <file>`，打码视图 |
| `mp secret saved` | 新增。列出当前项目保存的字段（档位、保存时间、到期、最近使用、次数）、记住的用途和渲染目标、保留的文件；`--all` 列所有项目 |
| `mp secret forget` | 新增 `--saved [NAME…]`（删保存记录）、`--files`（删保留的渲染文件）；`--all` 的语义不变，只管 slot |

「直接用」时 `ask` 的文本输出：

```
used saved values — no phone needed:
  OSS_ACCESS_KEY_ID (24 chars, sha256 9c1e0b2a, saved 12 days ago)
  OSS_ACCESS_KEY_SECRET (30 chars, sha256 4f7d31a0, saved 12 days ago)
id: s-7f3a1c — kept in memory for 120 min
approved uses:
  npm run deploy
next: mp secret run --id s-7f3a1c -- npm run deploy
```

所有输出仍然只有名字、指纹、用途和时间，不含值。

## 11. 模块划分

| 模块 | 职责 | 复用 |
|---|---|---|
| `src/keystore.js`（新） | DPAPI / 钥匙串 / libsecret 适配：`available()`、`wrap()`、`unwrap()`；测试用内存桩 | `argv.js` 的 `spawnArgv` |
| `src/secret-vault.js`（新） | 项目识别、信封加密、附加数据、HMAC、过期、主密码 KDF；纯函数部分离线可测 | `secret-crypto.js` 的 AES-GCM 写法 |
| `src/secret-render.js`（新） | 模板解析与过滤器、写入前检查、原子写、删除、孤儿清扫 | `scrub.js` 的变形定义 |
| `secret-form.js` | 保存区块、确认模式、主密码输入、渲染审批项 | 现有 `fill` / `approve` 两种模式 |
| `secret-daemon.js` | 启动时查 vault；`auto` 直接 `filled`；提交后写 vault；IPC 增加 `render`、`peek`；slot 结束删文件 | 现有生命周期 |
| `secret-cli.js` | `ask` 的三种结果；`render` / `peek` / `saved`；`forget --saved` / `--files` | 现有骨架 |
| `state.js` | `vaultDir()` | — |
| `hooks/pre-tool-use.mjs`、`hooks.json` | §9.1 的四条规则 | `splitPipeline`、`words` |

## 12. 测试策略

沿用 `node --test`。

- **secret-vault**：往返；改档位 / 到期 → 解密失败并按未保存处理；改清单 → HMAC 失败、清单作废；
  过期；项目识别（大小写、末尾斜杠、符号链接、不在仓库里）；主密码对 / 错 / 太弱；scrypt 的 `maxmem`
- **keystore**：Windows 上 DPAPI 真往返（按平台跳过）；不可用 → 表单不出现保存选项；argv 里
  不出现 K（断言传给 spawn 的参数）
- **secret-render**：未知占位符 → 一个文件都不写；三种过滤器；被跟踪或没被忽略 → 拒绝；
  不覆盖手写文件；命令退出后删除；daemon 被杀后由 `status` 清扫；原子写
- **secret-daemon（进程内）**：`auto` → `filled`，且 `startTunnelFn` 从未被调用；`confirm` → 确认页；
  混合档位取最严；`auto` 加新用途 → 只为新用途开批准页；提交后写 vault，state 文件里仍然没有值
- **hooks**：四条规则各一正一反
- **表单**：没有钥匙串时不显示保存区块；主密码强度检查；拒绝 `__mp_` 开头的字段名
- **端到端（真机）**：填写并保存 → `forget` → 再 `ask` → 直接 `filled`；确认页在 iPhone 视口下
  点一下；用一个只认配置文件的小脚本走 render，命令结束后文件消失。最后在 `stateDir()` 和项目
  目录里全盘搜这个值及其变形（复用 `scrub.js` 生成变形），除 render 期间外应该一处都没有

## 13. 决策记录

| 日期 | 决定 | 理由 | 来源 |
|---|---|---|---|
| 2026-09-21 | 做加密保存，推翻中继设计 §3「不做长期保存」 | 每次重填是最大的使用摩擦：用户在手机上，翻不到密钥 | 用户 |
| 2026-09-21 | 保存默认不勾；勾上后档位默认「直接用」 | 常用且泄露不敏感的钥匙，每次确认只增加麻烦；在 DPAPI 下确认本来就挡不住故意的 AI，强制确认不增加安全。gh、Git 凭据管理器、aws CLI 存好凭证后也都直接用 | 用户提出，分析支持 |
| 2026-09-21 | 确认的粒度是一个会话（slot 有效期），不是每条命令 | 同上 | 用户 |
| 2026-09-21 | 做 render | 有些工具只认配置文件里的真值 | 用户 |
| 2026-09-21 | 没有系统钥匙串就不提供保存，不退回明文 | gh 的明文回退被用户当缺陷报过 | 分析 |
| 2026-09-21 | 第一版只做项目作用域 | 需求原话是「该项目再做相同的操作」 | 分析 |
| 2026-09-21 | 默认有效期 90 天，到期可一键续期 | 过期在 DPAPI 档不增加安全，只负责清理和提醒轮换 | 分析 |
| 2026-09-21 | 主密码至少 6 位，纯数字也行（原为至少 12 个字符、不能全是数字） | 用户：像支付密码一样，长度限制多了操作不方便。已向用户说明差别：没有服务端数错误次数，短主密码只能拖延故意偷取的 AI，不能挡住；表单文案相应改为「位数越多越难猜」 | 用户 |

## 14. 后续（不在第一版）

- **跨项目共享**：同一个 OSS 账号给多个项目用，确认页上可选「所有项目」，存 `_global.json`，查找时项目优先
- **管理页**：手机上集中改档位、批量删除；第一版只能删了重填
- **改主密码**：第一版忘了或想换，只能删掉主密码档的条目重填
- **固定域名下的 passkey 解锁**：换成固定域名后（命名隧道，或 GitHub Pages 上的静态页），
  可以用 WebAuthn PRF 从手机 passkey 派生解锁钥匙，Face ID 一下就解开，不用记主密码
- **跨账号 daemon**：中继设计 §11 已列。它能把「AI 拿不到值」变成对所有档位都成立的技术保证

## 15. 文档影响

| 文档 | 状态 |
|---|---|
| `README.md` 安全一节 | 已改：不再说「never written to disk」，写明落盘的条件和边界 |
| 两份 SKILL.md 的 `mp secret` 一节（§9.2） | 已改 |
| 手册参数表 `reference/commands.md`（中英，`docs/guide` 与 `publish/` 两份） | 已改：`tests/usage.test.js` 要求每个参数都进表 |
| 手册流程页 `workflows/secrets-and-decisions.md` 的「值只在守护进程内存里」 | **未改**。它描述的默认路径仍然成立，但没讲保存与 render；该页受 doc-automation 契约约束（真跑证据、门禁），应走 maintain 模式出变更清单后再改，`llms.txt` / `llms-full.txt` 随之重新生成 |
| 中继设计 §4.4、§5.4、§11 | 已加指向本文的说明 |

## 16. 实现记录（2026-09-21）

### 16.1 模块

| 模块 | 内容 |
|---|---|
| `src/keystore.js` | DPAPI / 钥匙串 / libsecret；`withProbe` 做往返探测；`memoryKeystore` 只能由测试传入 |
| `src/secret-vault.js` | 项目识别、信封加密、附加数据、HMAC、主密码、`removeSaved`（删除不需要钥匙） |
| `src/secret-render.js` | 模板、git 检查、原子写、`kept-files.json` |
| `src/secret-form.js` | fill / confirm / approve 三态；主密码走加密通道；`FormError` 让主密码输错可重试 |
| `src/secret-daemon.js` | 启动时查 vault；`auto` 不开隧道；IPC 新增 `render`、`peek` |
| `src/secret-cli.js`、`src/usage.js` | `ask` 的 filled 结果；`render` / `peek` / `saved`；`forget --saved` / `--files` |
| `hooks/pre-tool-use.mjs`、`hooks.json` | 文件工具与 shell 命令碰生成文件、vault 钥匙一律 `deny` |

### 16.2 验证

- 单元与进程内测试：`secret-vault`、`secret-render`、`secret-vault-daemon`（直接用不开隧道、新用途只开批准页、
  确认页、主密码重试与 5 次锁定、重新填写即删除、篡改档位回退到填写页、render 用完即删、peek 打码、不覆盖手写文件）、
  hook 新规则。全套 `npm test` 通过
- **真钥匙串端到端**（`tests/secret-vault-cli.test.js`，本机 DPAPI）：保存一次 → 真 CLI 的 `ask` 拉起独立 daemon、
  从 DPAPI 取回库钥匙、不开隧道直接 filled → `run --render` / `render` / `peek` / `saved` → `forget --saved`；
  最后全盘搜状态目录，值及其 base64、URL 编码形态一处都没有。钥匙串不可用的机器上跳过
- **手机视口真点**（iPhone 13 视口，Edge 引擎，临时脚本未入库）：勾「记住」展开档位、选主密码出现输入框、弱口令在页面上被拦、
  真页面提交后按主密码档保存；确认页只要主密码、「重新填写」展开输入框和保存区块、输错提示剩余次数、输对后 filled
- **真隧道 + 用户的手机**（2026-09-21，本机真实状态目录与 DPAPI）：三档都走了一遍。主密码档：确认页输错一次提示剩余次数，
  输对后取回原值；直接用：`ask` 1.8 秒返回 filled，不开隧道、不发链接；点一下：确认页点一下取回原值。另外走通了
  「重新填写 → 改档位」和「不重输值、只打开『用已保存的值』并改档位」两条路径；每轮 `run --render` 都是运行时文件存在、
  结束即删，输出全部打码。试跑数据随后清除（含 `vault.key`）。用户手机的浏览器型号未记录

### 16.3 真点出来的旧缺陷

表单页面脚本用全局 `var status` 指代提示行。页面顶层的 `status` 就是 `window.status`——一个字符串属性，
赋值后变量成了字符串，之后每一次 `status.textContent = …` 都静默失效。**0.4.0 起表单上从来没显示过任何提示**：
「提交中」、服务端的 400、字段为空，全都没有。单元测试只断言服务端的响应，所以一直没发现；在手机视口里输错主密码、
等不到提示，才暴露出来。已改名为 `statusEl`，并加了一条断言页面脚本不再声明全局 `status` 的测试。

### 16.4 按真机反馈改的

- 表单整页重做（用户：「太丑，交互也优化一下」）：用途作标题，项目名与链接倒计时作标签；用途与写文件做成带开关的列表；
  保存区做成开关 + 三张档位卡片 + 四格有效期；主密码框就近出现；空项全部就地标红；主按钮吸底
- 输入框改为白底描边加占位文字（用户：「一开始都没分辨出它是个输入框」）；已保存字段的「用已保存的值」开关挪到单独一行，
  长字段名不再被挤断
- 主密码最短 6 位、数字也行（见 §4.2、§13）

### 16.5 未验证

- macOS 钥匙串、Linux libsecret 两个适配器按文档实现，本机是 Windows，**没有跑过**。钥匙串不可用时自动判定为
  「不能保存」，不会半途写坏；但它们第一次在真机上跑之前，不能宣称支持
- 真手机只试了用户自己的一台，浏览器型号未记录；iOS Safari 与 Android Chrome 是否都正常，没有分别确认
- §6.5 提到的 Claude Code `Grep` 是否跳过 `.gitignore` 里的文件、Codex 文件工具的覆盖面：仍待验证
