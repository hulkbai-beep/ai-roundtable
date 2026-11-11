# AI 圆桌：给后续开发会话的说明

一个本机运行的群聊：Claude、Gemini、GPT 轮流发言、互相接话，用户是主持人。主要用户在 Windows 上。界面有中文和英文两种语言；项目负责人 Tim 用英文沟通。

## 结构

- `electron/main.js`：桌面版。启动 `lib/app-server.js`（数据在 `%APPDATA%\AI Roundtable`），再用 BrowserWindow 打开 `http://127.0.0.1:<port>`。
- `server.js` + `start.bat`：浏览器版，数据在仓库目录下（`config.json`、`data/`、`workspace/`，已加入 .gitignore）。
- `lib/app-server.js`：HTTP 接口和 SSE 推送，只接受本机 Host/Origin，POST 必须是 JSON。
- `lib/orchestrator.js`：发言队列。新消息会替换还没轮到的发言；@点名只让被点到的人说一次；某人出错后，这一轮里他后面的发言会跳过。
- `lib/providers.js`：各种接入方式。`lib/prompt.js`：人设和聊天记录拼装（太长时保留第一条话题和最近的消息）。
- `lib/spawn.js`：Windows 上启动命令行工具（见下文）。
- `lib/usage.js`：每次发言用了多少 token、谁的额度用完了（存在 `usage.json`）。`lib/limits.js`：从工具的报错里认出“额度用完了”，读出什么时候恢复。
- `lib/attachments.js`：附件的类型判断（看文件开头的字节，不信扩展名）、保存和取用，文件在 `workspace/attachments/`。`lib/doc-text.js`（zip + docx / xlsx / pptx + 文本编码）和 `lib/pdf-text.js` 负责取文字，全部自己解析。
- `public/`：原生 HTML/CSS/JS，不依赖任何框架；Markdown 渲染是自己写的，先转义再排版。

- `lib/i18n.js`：中英文两种界面语言（设置里的 `lang`，留空 = 跟随系统）。服务端的提示和错误写成 `tr('中文', 'English')`；接入方式的说明写成 `L('中文', 'English')`，发给界面前用 `loc()` 选一种。网页里固定文字的英文写在 `index.html` 的 `data-en*` 属性里，`app.js` 里用 `T('中文', 'English')`。新增任何给用户看的文字，都要两种语言一起写。

运行时没有任何第三方依赖，请保持这一点。开发依赖只有 electron 和 electron-builder。

## 关键决定（和理由）

- **订阅只能通过官方命令行工具使用。** Claude 用 `claude -p --output-format json --system-prompt … --tools ""`，提示词从标准输入传。不要换成 Agent SDK 或直接调接口，那样走的不是用户的 Max 订阅。
- **Gemini CLI 从 2026-06-18 起不再支持 AI Pro 登录**，所以 Gemini 默认用 Antigravity CLI（`agy -p "<提示词>"`），提示词作为命令行参数传，Windows 上要求直接启动 .exe（`requireDirect`），长度上限约 30000 字。agy 的行为以官方公开的更新日志为准（GitHub 上 google-antigravity/antigravity-cli 的 `CHANGELOG.md`：`-p` / `--print` / `--prompt`、`--model`、`--effort`、`--output-format text|json|stream-json`；出错时 stderr 上有 `error: …` 和一行 `AGY_ERROR: {…}`，退出码 3；旧版本在程序里调用会卡住或者没有输出，后来修了），但还没有在真机上验证过。备选是 `gemini-api`（API Key，不走订阅）。
- **GPT 默认用 Codex CLI**（`codex exec --sandbox read-only -o <文件> -`，提示词从标准输入传），用户用 ChatGPT 账号登录，免费账号也能用（OpenAI 可能只是限时开放）。1.0.1 起默认从 GitHub Models 换成了 Codex：`lib/store.js` 会把 version 1 配置里的 github-models 迁移成 codex-cli。备选是 GitHub Models 免费额度（`https://models.github.ai/inference`，fine-grained token 需要 models:read；免费档每次请求约 8000 token，所以只带 5000 字聊天记录）和自定义 OpenAI 兼容接口。
- **Windows 启动策略**：.exe 直接启动（Node 负责参数转义）；npm 生成的 .cmd 会被解析成“node + 脚本”直接启动（优先用 npm 目录里的 node.exe，其次 PATH 里的 node，桌面版没有 Node 时用 Electron 自带的，设置 `ELECTRON_RUN_AS_NODE=1`）；其他 .cmd 只能经过 cmd.exe，这时只传简单参数，人设并进标准输入。
- **兼容不同版本**：可选参数分组传递，命令行报“不认识的参数”时去掉那一组再试（`runAdaptive`）。
- **用量**（`lib/usage.js`，数据在 `usage.json`，只留 30 天）：每次发言记录 token。各家统一成“合计 = 没走缓存的输入 + 输出”（Codex 自己报的就是这个数），走缓存的输入单独记在 `cached` 里，界面上用 * 标出。Claude 读 JSON 里的 `modelUsage`（这次运行所有模型调用的合计；没有时读 `usage`），Codex 读 stderr 末尾的 `tokens used`（数字按系统语言加分隔符，例如 `1.234`），接口读 `usage` / `usageMetadata`；agy 不报用量，按字数估算并标 ≈。
- **额度用完**（`lib/limits.js` 识别，`lib/usage.js` 记标记）：
  - 只看工具自己说的话：codex exec 会把提示词原样回显在 stderr 上，判断前先用 `stripEcho` 去掉（要拿真正发出去的那段文字去比：带附件时提示词后面多一段文件清单，文件名是用户起的），而且只看 `ERROR:` 开头的行；Claude 看 JSON 里的 `result` / `errors` / `api_error`；agy 先看 `AGY_ERROR` 那一行（429 / `RESOURCE_EXHAUSTED`），没有再看 stderr 上的文字。有的版本不报错、把那句话当成回复输出，由 `limitReply` 认（只认很短、开头就是那句话的回复；`You've hit your … limit` 中间只能是说额度的词，`You've reached your daily caffeine limit.` 是聊天）。接口看状态码：429 / 402 算，但“这一次请求太大”不算（要看完整的报错，不能只看截短后的那一段）。报错里给用户看的文字也只用工具自己的话：它会显示在「用量」里、存进 `usage.json`，不能混进被回显的聊天内容。
  - 宁可漏认，不要错认：漏认只是报一次错、下一轮再试，错认会让这位成员被跳过。`Context limit reached`、`Server is temporarily limiting requests (not your usage limit)`、Codex 的 `Selected model is at capacity` 这些都不算；操作系统自己的配额报错（`Disk quota exceeded (os error 122)`、Windows 的 `Insufficient quota to complete the requested service`）也不算；只有一个状态码（429、`RESOURCE_EXHAUSTED`）而原因写的是请求太大、或者服务器没有容量（`No capacity available for model …`）时也不算（`notAccountLimit`）。新增或修改写法时，把逐字的例子加进 `test/unit.test.js` 的 `LIMIT_MESSAGES` / `NOT_LIMIT_MESSAGES`。
  - 恢复时间（`parseResetAt`）：`|时间戳`、ISO 时间、时长（`2h57m45s`、`in 2 hours 5 minutes`）、钟点（Claude 会在后面带时区，例如 `resets 3pm (Asia/Tokyo)`，按那个时区算）、只有日期（UTC 0 点）。CI 的机器都在 UTC，时区的问题在那里看不出来，所以 `test/unit.test.js` 会把自己放到别的时区里再跑一遍。这些正则里不要把两段 `\s*` 挨着写（中间只隔一个可有可无的词）：遇到一大片空白会反复回溯，几万个字符要算好几秒。Gemini API 按天算的额度（`quotaId` 里带 PerDay）要等到太平洋时间午夜，返回里的 `retryDelay` 不能信。
  - 什么时候再试：读得出恢复时间，到点后再等一下（最多一分钟，工具报的时间只精确到分钟）；读不出，一小时后；只是请求太频繁（rate limit）又没说等多久，5 分钟后（`e.limit.retryInMs`）。到点一试又用完，就至少等 5 分钟、15 分钟、1 小时。
  - 标记跟着接入方式走，每种接入方式各存一个（`usage.json` 里的键是 `成员|接入方式`）：换了接入方式就不算（标记留着，换回来还在；换过去之后又被限了，也不会盖掉原来的）；改了那种接入方式的设置（账号、Key、模型……）就去掉，发言期间改了设置的话，这次的“额度用完”也不记（它说的是旧设置）。被标记的成员在轮流发言里跳过、也不写进其他人的人设；@点名、连接测试成功或「再试一次」会清掉现在用的这种接入方式的标记。协作模式里负责总结的人被跳过时，改由队列里最后一位总结；他正好在总结那一次用完（每人只说一轮时就是这样），就请这一轮刚发过言的最后一位补一次总结。
  - 各家写法的出处：Claude Code 官方文档的 Error reference（`code.claude.com/docs/en/errors`）、openai/codex 的 `codex-rs/protocol/src/error.rs`、Antigravity CLI 的 `CHANGELOG.md`、google-gemini/gemini-cli 的 `googleQuotaErrors.ts`、Gemini API 的 429 返回，加上用户公开贴出来的报错。都还没有用真实账号在真机上触发过；`test/mocks/` 里的输出照着这些出处写。
- **附件**（图片、PDF、docx / xlsx / pptx、纯文本；每个 15 MB、每条消息 10 个）：先上传（`POST /api/upload`，base64 放在 JSON 里）再随 `/api/send` 的 `attachments: [id]` 发出。
  - 文档的文字在本机取出来，写进提示词的“附件”一段，所以每种接入方式都能看到；这一段最多占 `maxChars` 的一半，新的优先，放不下的只带开头并在回复上注明（`prompt.js` 的 `buildAttachments`，`orchestrator.js` 的 `attachmentNote`）。
  - 图片和取不出文字的 PDF 要把“文件本身”送到，各家不一样（`providers.js` 里“附件里的文件”一节）：Claude Code 打开 Read 工具让它自己读（只在带附件时加 `--tools Read`，不加 `--allowedTools`，所以只能读 workspace）；Codex 图片用 `--image`，其他文件自己打开；agy 只能告诉它路径；HTTP 接口转成 base64 放进请求，对方拒绝时先去掉 PDF、再去掉图片重试（`sendWithFallbacks`），并在回复上注明。Codex 的 `--image` 和 agy 读文件都没有在真机上验证过。
  - 文件是用户从别处拿来的，取文字的代码处处有上限（解压大小、处理时间、输出字数、PDF 的表单展开次数等），没取全的标 `partial`。**改这两个文件时不要用“<a>…</a>”这类会来回试的正则，也不要让 `[ \t]+\n` 这样的正则从一长串空白的每个位置各试一遍**：都用 `indexOf` 顺着扫，或者加 `(?<!…)` 只从开头试一次。`test/attachments.test.js` 里“坏掉的、故意做出来捣乱的文件”一节的每个测试对应一种会卡死旧写法的文件。
  - 文本编码只认 UTF-8、UTF-16（BOM）、GB18030、Windows-1252，拿不准时算中文（`looksWestern`）。Big5、Shift_JIS 等认不出来。
- 没有用 `--safe-mode`：担心它让 Claude Code 忽略 settings.json 里配置的代理等环境变量。

## 测试

- `npm test`：单元测试 + 端到端测试（真实的本地服务，加上 `test/mocks/` 里模拟的 claude/agy/codex 和模拟接口）+ 只在 Windows 上运行的参数传递测试。附件的测试在 `test/attachments.test.js`（取文字、保存、提示词）和 `test/attachments-e2e.test.js`（上传到各家收到的整条路）；样本文档在 `test/fixtures/`（真实软件生成的，说明见那里的 README），其他文件用 `test/files.js` 现做。
- `test/packaged-app.test.js`：测试打包后的桌面版（CI 在 Windows 上跑）。本机可以用 `xvfb-run -a node test/packaged-app.test.js -- node_modules/electron/dist/electron --no-sandbox .` 测开发版。
- 还没有用真实账号测试过真实的 claude / agy / codex / GitHub Models。用户（Windows）的 codex 是用 npm 装的：`%APPDATA%\npm\codex.cmd`。

## 发布

推送到 main 会触发 `.github/workflows/build.yml`：Linux 和 Windows 上跑测试，在 Windows 上打包、测试打包结果、上传安装包（Actions 产物）。

发布 Release 有两种方式：推送 `vX.Y.Z` 标签；或者在 Actions 页面手动运行这个工作流，填 `release` 输入（例如 `1.0.1`），工作流会在打包前用 `npm version` 改版本号，再创建标签和 Release。Claude Code 云端会话推送标签会被拒绝（HTTP 403），所以发布要由用户在 Actions 页面手动触发，不要绕过这个限制。
