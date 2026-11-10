# AI 圆桌：给后续开发会话的说明

一个本机运行的群聊：Claude、Gemini、GPT 轮流发言、互相接话，用户是主持人。主要用户在 Windows 上。界面有中文和英文两种语言；项目负责人 Tim 用英文沟通。

## 结构

- `electron/main.js`：桌面版。启动 `lib/app-server.js`（数据在 `%APPDATA%\AI Roundtable`），再用 BrowserWindow 打开 `http://127.0.0.1:<port>`。
- `server.js` + `start.bat`：浏览器版，数据在仓库目录下（`config.json`、`data/`、`workspace/`，已加入 .gitignore）。
- `lib/app-server.js`：HTTP 接口和 SSE 推送，只接受本机 Host/Origin，POST 必须是 JSON。
- `lib/orchestrator.js`：发言计划，是一串“步骤”，每一步里的成员同时调用（`plan` / `runStep`）。「各自回答」把同一轮的人放进同一步，一起回答；其他模式一步只有一个人，后面的人能看到前面的发言。新消息会替换还没轮到的发言；@点名只让被点到的人说一次；某人出错后，这一轮里他后面的发言会跳过。`typing` 事件和 `state().typing` 是数组，因为可能有好几位同时在说；每位说完（或出错）都会推一次 `state`，界面上“还有几次发言在排队”才不会过时。
- `lib/providers.js`：各种接入方式。`lib/prompt.js`：人设和聊天记录拼装（太长时保留第一条话题和最近的消息）。
- `lib/spawn.js`：Windows 上启动命令行工具（见下文）。
- `public/`：原生 HTML/CSS/JS，不依赖任何框架；Markdown 渲染是自己写的，先转义再排版。

- `lib/i18n.js`：中英文两种界面语言（设置里的 `lang`，留空 = 跟随系统）。服务端的提示和错误写成 `tr('中文', 'English')`；接入方式的说明写成 `L('中文', 'English')`，发给界面前用 `loc()` 选一种。网页里固定文字的英文写在 `index.html` 的 `data-en*` 属性里，`app.js` 里用 `T('中文', 'English')`。新增任何给用户看的文字，都要两种语言一起写。

运行时没有任何第三方依赖，请保持这一点。开发依赖只有 electron 和 electron-builder。

## 关键决定（和理由）

- **订阅只能通过官方命令行工具使用。** Claude 用 `claude -p --output-format json --system-prompt … --tools ""`，提示词从标准输入传。不要换成 Agent SDK 或直接调接口，那样走的不是用户的 Max 订阅。
- **Gemini CLI 从 2026-06-18 起不再支持 AI Pro 登录**，所以 Gemini 默认用 Antigravity CLI（`agy -p "<提示词>"`），提示词作为命令行参数传，Windows 上要求直接启动 .exe（`requireDirect`），长度上限约 30000 字。agy 的参数来自第三方文档，没有在真机上验证过；有用户反馈它被程序调用时可能卡住或没有输出。备选是 `gemini-api`（API Key，不走订阅）。
- **GPT 默认用 Codex CLI**（`codex exec --sandbox read-only -o <文件> -`，提示词从标准输入传），用户用 ChatGPT 账号登录，免费账号也能用（OpenAI 可能只是限时开放）。1.0.1 起默认从 GitHub Models 换成了 Codex：`lib/store.js` 会把 version 1 配置里的 github-models 迁移成 codex-cli。备选是 GitHub Models 免费额度（`https://models.github.ai/inference`，fine-grained token 需要 models:read；免费档每次请求约 8000 token，所以只带 5000 字聊天记录）和自定义 OpenAI 兼容接口。
- **发言顺序**：只有「各自回答」是大家同时回答（用量不变，只需要等最慢的那一位）。自由讨论和辩论还是轮流说，但默认每条消息随机换一个顺序（`lineup` / `shuffled`，设置项 `shuffleOrder`；上一次先说的那位、「继续聊」时刚说完话的那位、发新消息时还在说话的那位尽量不排第一个；同一条消息的几轮顺序相同），人设里让后说的人先用一两句话说出自己的看法再接话（`prompt.js` 的 `REPLY_RULES` / `turnPosition`），减少跟风。考虑过“所有模式都同时回答”，没有采用：只聊一轮时它和「各自回答」没有区别，大家也没法互相接话；要互相回应就得多聊一轮，用量翻倍。合作模式要在前面的人的成果上接着做，所以始终按设置里排的顺序。@点名按点名的顺序一个一个说，「各自回答」模式下点了两位以上也是这样（这时按自由讨论来，不然后面的人看不到前面的回答）。
- **Windows 启动策略**：.exe 直接启动（Node 负责参数转义）；npm 生成的 .cmd 会被解析成“node + 脚本”直接启动（优先用 npm 目录里的 node.exe，其次 PATH 里的 node，桌面版没有 Node 时用 Electron 自带的，设置 `ELECTRON_RUN_AS_NODE=1`）；其他 .cmd 只能经过 cmd.exe，这时只传简单参数，人设并进标准输入。
- **兼容不同版本**：可选参数分组传递，命令行报“不认识的参数”时去掉那一组再试（`runAdaptive`）。
- **用量和额度用完**（`lib/usage.js`，数据在 `usage.json`）：每次发言记录 token。Claude 读 JSON 里的 `usage`（输入 + 缓存 + 输出），Codex 读输出末尾的 `tokens used`，接口读 `usage` / `usageMetadata`；agy 不报用量，按字数估算并标 ≈。额度用完靠报错识别（`providers.js` 的 `detectLimit` / `parseResetAt`，HTTP 429 也算），错误带 `e.limit = { resetAt }`。标记跟着接入方式走（换了接入方式就不算），读不出恢复时间时一小时后自动再试；被标记的成员在轮流发言里跳过、也不写进其他人的人设，@点名或连接测试成功会清掉标记。各家真实的报错文字没有在真机上核对过，`test/mocks/` 里的写法来自公开资料。
- 没有用 `--safe-mode`：担心它让 Claude Code 忽略 settings.json 里配置的代理等环境变量。

## 测试

- `npm test`：单元测试 + 端到端测试（真实的本地服务，加上 `test/mocks/` 里模拟的 claude/agy/codex 和模拟接口）+ 只在 Windows 上运行的参数传递测试。
- `test/packaged-app.test.js`：测试打包后的桌面版（CI 在 Windows 上跑）。本机可以用 `xvfb-run -a node test/packaged-app.test.js -- node_modules/electron/dist/electron --no-sandbox .` 测开发版。
- 还没有用真实账号测试过真实的 claude / agy / codex / GitHub Models。用户（Windows）的 codex 是用 npm 装的：`%APPDATA%\npm\codex.cmd`。

## 发布

推送到 main 会触发 `.github/workflows/build.yml`：Linux 和 Windows 上跑测试，在 Windows 上打包、测试打包结果、上传安装包（Actions 产物）。

发布 Release 有两种方式：推送 `vX.Y.Z` 标签；或者在 Actions 页面手动运行这个工作流，填 `release` 输入（例如 `1.0.1`），工作流会在打包前用 `npm version` 改版本号，再创建标签和 Release。Claude Code 云端会话推送标签会被拒绝（HTTP 403），所以发布要由用户在 Actions 页面手动触发，不要绕过这个限制。
