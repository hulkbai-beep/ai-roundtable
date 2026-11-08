# AI 圆桌：给后续开发会话的说明

一个本机运行的群聊：Claude、Gemini、GPT 轮流发言、互相接话，用户是主持人。主要用户在 Windows 上，界面文字和用户沟通都用中文。

## 结构

- `electron/main.js`：桌面版。启动 `lib/app-server.js`（数据在 `%APPDATA%\AI Roundtable`），再用 BrowserWindow 打开 `http://127.0.0.1:<port>`。
- `server.js` + `start.bat`：浏览器版，数据在仓库目录下（`config.json`、`data/`、`workspace/`，已加入 .gitignore）。
- `lib/app-server.js`：HTTP 接口和 SSE 推送，只接受本机 Host/Origin，POST 必须是 JSON。
- `lib/orchestrator.js`：发言队列。新消息会替换还没轮到的发言；@点名只让被点到的人说一次；某人出错后，这一轮里他后面的发言会跳过。
- `lib/providers.js`：各种接入方式。`lib/prompt.js`：人设和聊天记录拼装（太长时保留第一条话题和最近的消息）。
- `lib/spawn.js`：Windows 上启动命令行工具（见下文）。
- `public/`：原生 HTML/CSS/JS，不依赖任何框架；Markdown 渲染是自己写的，先转义再排版。

运行时没有任何第三方依赖，请保持这一点。开发依赖只有 electron 和 electron-builder。

## 关键决定（和理由）

- **订阅只能通过官方命令行工具使用。** Claude 用 `claude -p --output-format json --system-prompt … --tools ""`，提示词从标准输入传。不要换成 Agent SDK 或直接调接口，那样走的不是用户的 Max 订阅。
- **Gemini CLI 从 2026-06-18 起不再支持 AI Pro 登录**，所以 Gemini 默认用 Antigravity CLI（`agy -p "<提示词>"`），提示词作为命令行参数传，Windows 上要求直接启动 .exe（`requireDirect`），长度上限约 30000 字。agy 的参数来自第三方文档，没有在真机上验证过；有用户反馈它被程序调用时可能卡住或没有输出。备选是 `gemini-api`（API Key，不走订阅）。
- **GPT 默认用 Codex CLI**（`codex exec --sandbox read-only -o <文件> -`，提示词从标准输入传），用户用 ChatGPT 账号登录，免费账号也能用（OpenAI 可能只是限时开放）。1.0.1 起默认从 GitHub Models 换成了 Codex：`lib/store.js` 会把 version 1 配置里的 github-models 迁移成 codex-cli。备选是 GitHub Models 免费额度（`https://models.github.ai/inference`，fine-grained token 需要 models:read；免费档每次请求约 8000 token，所以只带 5000 字聊天记录）和自定义 OpenAI 兼容接口。
- **Windows 启动策略**：.exe 直接启动（Node 负责参数转义）；npm 生成的 .cmd 会被解析成“node + 脚本”直接启动（优先用 npm 目录里的 node.exe，其次 PATH 里的 node，桌面版没有 Node 时用 Electron 自带的，设置 `ELECTRON_RUN_AS_NODE=1`）；其他 .cmd 只能经过 cmd.exe，这时只传简单参数，人设并进标准输入。
- **兼容不同版本**：可选参数分组传递，命令行报“不认识的参数”时去掉那一组再试（`runAdaptive`）。
- 没有用 `--safe-mode`：担心它让 Claude Code 忽略 settings.json 里配置的代理等环境变量。

## 测试

- `npm test`：单元测试 + 端到端测试（真实的本地服务，加上 `test/mocks/` 里模拟的 claude/agy/codex 和模拟接口）+ 只在 Windows 上运行的参数传递测试。
- `test/packaged-app.test.js`：测试打包后的桌面版（CI 在 Windows 上跑）。本机可以用 `xvfb-run -a node test/packaged-app.test.js -- node_modules/electron/dist/electron --no-sandbox .` 测开发版。
- 还没有用真实账号测试过真实的 claude / agy / codex / GitHub Models。用户（Windows）的 codex 是用 npm 装的：`%APPDATA%\npm\codex.cmd`。

## 发布

推送到 main 会触发 `.github/workflows/build.yml`：Linux 和 Windows 上跑测试，在 Windows 上打包、测试打包结果、上传安装包（Actions 产物）。

发布 Release 有两种方式：推送 `vX.Y.Z` 标签；或者在 Actions 页面手动运行这个工作流，填 `release` 输入（例如 `1.0.1`），工作流会在打包前用 `npm version` 改版本号，再创建标签和 Release。Claude Code 云端会话推送标签会被拒绝（HTTP 403），所以发布要由用户在 Actions 页面手动触发，不要绕过这个限制。
