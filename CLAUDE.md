# AI 圆桌：给后续开发会话的说明

一个本机运行的群聊：Claude、Gemini、GPT 轮流发言、互相接话，用户是主持人。主要用户在 Windows 上。界面有中文和英文两种语言；项目负责人 Tim 用英文沟通。

## 结构

- `electron/main.js`：桌面版。启动 `lib/app-server.js`（数据在 `%APPDATA%\AI Roundtable`），再用 BrowserWindow 打开 `http://127.0.0.1:<port>`。
- `server.js` + `start.bat`：浏览器版，数据在仓库目录下（`config.json`、`data/`、`workspace/`，已加入 .gitignore）。
- `lib/app-server.js`：HTTP 接口和 SSE 推送，只接受本机 Host/Origin，POST 必须是 JSON。
- `lib/orchestrator.js`：发言队列。新消息会替换还没轮到的发言；@点名只让被点到的人说一次；某人出错后，这一轮里他后面的发言会跳过。
- `lib/providers.js`：各种接入方式。`lib/prompt.js`：人设和聊天记录拼装（太长时保留第一条话题和最近的消息）。
- `lib/spawn.js`：Windows 上启动命令行工具（见下文）。
- `lib/attachments.js`：附件的类型判断（看文件开头的字节，不信扩展名）、保存和取用，文件在 `workspace/attachments/`。`lib/doc-text.js`（zip + docx / xlsx / pptx + 文本编码）和 `lib/pdf-text.js` 负责取文字，全部自己解析。
- `public/`：原生 HTML/CSS/JS，不依赖任何框架；Markdown 渲染是自己写的，先转义再排版。

- `lib/i18n.js`：中英文两种界面语言（设置里的 `lang`，留空 = 跟随系统）。服务端的提示和错误写成 `tr('中文', 'English')`；接入方式的说明写成 `L('中文', 'English')`，发给界面前用 `loc()` 选一种。网页里固定文字的英文写在 `index.html` 的 `data-en*` 属性里，`app.js` 里用 `T('中文', 'English')`。新增任何给用户看的文字，都要两种语言一起写。

运行时没有任何第三方依赖，请保持这一点。开发依赖只有 electron 和 electron-builder。

## 关键决定（和理由）

- **订阅只能通过官方命令行工具使用。** Claude 用 `claude -p --output-format json --system-prompt … --tools ""`，提示词从标准输入传。不要换成 Agent SDK 或直接调接口，那样走的不是用户的 Max 订阅。
- **Gemini CLI 从 2026-06-18 起不再支持 AI Pro 登录**，所以 Gemini 默认用 Antigravity CLI（`agy -p "<提示词>"`），提示词作为命令行参数传，Windows 上要求直接启动 .exe（`requireDirect`），长度上限约 30000 字。agy 的参数来自第三方文档，没有在真机上验证过；有用户反馈它被程序调用时可能卡住或没有输出。备选是 `gemini-api`（API Key，不走订阅）。
- **GPT 默认用 Codex CLI**（`codex exec --sandbox read-only -o <文件> -`，提示词从标准输入传），用户用 ChatGPT 账号登录，免费账号也能用（OpenAI 可能只是限时开放）。1.0.1 起默认从 GitHub Models 换成了 Codex：`lib/store.js` 会把 version 1 配置里的 github-models 迁移成 codex-cli。备选是 GitHub Models 免费额度（`https://models.github.ai/inference`，fine-grained token 需要 models:read；免费档每次请求约 8000 token，所以只带 5000 字聊天记录）和自定义 OpenAI 兼容接口。
- **Windows 启动策略**：.exe 直接启动（Node 负责参数转义）；npm 生成的 .cmd 会被解析成“node + 脚本”直接启动（优先用 npm 目录里的 node.exe，其次 PATH 里的 node，桌面版没有 Node 时用 Electron 自带的，设置 `ELECTRON_RUN_AS_NODE=1`）；其他 .cmd 只能经过 cmd.exe，这时只传简单参数，人设并进标准输入。
- **兼容不同版本**：可选参数分组传递，命令行报“不认识的参数”时去掉那一组再试（`runAdaptive`）。
- **用量和额度用完**（`lib/usage.js`，数据在 `usage.json`）：每次发言记录 token。Claude 读 JSON 里的 `usage`（输入 + 缓存 + 输出），Codex 读输出末尾的 `tokens used`，接口读 `usage` / `usageMetadata`；agy 不报用量，按字数估算并标 ≈。额度用完靠报错识别（`providers.js` 的 `detectLimit` / `parseResetAt`，HTTP 429 也算），错误带 `e.limit = { resetAt }`。标记跟着接入方式走（换了接入方式就不算），读不出恢复时间时一小时后自动再试；被标记的成员在轮流发言里跳过、也不写进其他人的人设，@点名或连接测试成功会清掉标记。各家真实的报错文字没有在真机上核对过，`test/mocks/` 里的写法来自公开资料。
- **附件**（图片、PDF、docx / xlsx / pptx、纯文本；每个 15 MB、每条消息 10 个）：先上传（`POST /api/upload`，base64 放在 JSON 里）再随 `/api/send` 的 `attachments: [id]` 发出。
  - 文档的文字在本机取出来，写进提示词的“附件”一段，所以每种接入方式都能看到；这一段最多占 `maxChars` 的一半，新的优先，放不下的只带开头并在回复上注明（`prompt.js` 的 `buildAttachments`，`orchestrator.js` 的 `attachmentNote`）。
  - 图片和取不出文字的 PDF 要把“文件本身”送到，各家不一样（`providers.js` 里“附件里的文件”一节）：Claude Code 打开 Read 工具让它自己读（只在带附件时加 `--tools Read`，不加 `--allowedTools`，每次都加 `--permission-mode default`，所以只能读 workspace，理由见下面“Claude Code 的权限”）；Codex 图片用 `--image`，其他文件自己打开；agy 只能告诉它路径；HTTP 接口转成 base64 放进请求，对方拒绝时先去掉 PDF、再去掉图片重试（`sendWithFallbacks`），并在回复上注明。Codex 的 `--image` 和 agy 读文件都没有在真机上验证过。
  - 文件是用户从别处拿来的，取文字的代码处处有上限（解压大小、处理时间、输出字数、PDF 的表单展开次数等），没取全的标 `partial`。**改这两个文件时不要用“<a>…</a>”这类会来回试的正则，也不要让 `[ \t]+\n` 这样的正则从一长串空白的每个位置各试一遍**：都用 `indexOf` 顺着扫，或者加 `(?<!…)` 只从开头试一次。`test/attachments.test.js` 里“坏掉的、故意做出来捣乱的文件”一节的每个测试对应一种会卡死旧写法的文件。
  - 文本编码只认 UTF-8、UTF-16（BOM）、GB18030、Windows-1252，拿不准时算中文（`looksWestern`）。Big5、Shift_JIS 等认不出来。
  - Claude Code 的权限（依据官方文档 code.claude.com/docs/en 的 permission-modes、headless、tools-reference、cli-reference 和更新日志，2026-11 查的，没有在真机上试过）：
    - `-p` 运行在 default（界面上叫 Manual）模式时，需要批准的调用一律拒绝，读运行目录以外的文件就属于这一类。不加 `--permission-mode` 的话，模式跟着用户设置里的 `defaultMode` 走；2.1.285～2.1.301 在第三方平台或者关了遥测时还会自己用 auto 模式。auto 模式下读别处的文件只在第一次问一下（答案会记住），bypassPermissions 模式下完全不问，所以要明说。选 `default` 是因为这个值一直都有；`dontAsk` 更贴切，但不清楚旧版本认不认，不认的话报的多半是“值不对”而不是“不认识的参数”，`runAdaptive` 接不住。用户自己写的 allow 规则仍然有效。
    - `permission_denials` 官方只说 stream-json 的结果里有，json 格式里有没有没写。回复上“Claude Code 没有权限打开附件”那句注明是能读到就写，读不到不算错。
    - Read 工具读图片不需要别的东西；超过 10 页的 PDF 要按页读，靠 poppler 的 `pdftoppm`，Windows 上要用户自己装（README 里写了）。
    - `--tools` 管不到 MCP 工具，靠 `--strict-mcp-config`（不给 `--mcp-config`）让它一个都不加载。
  - Office 文档读哪些内容（`doc-text.js`）：
    - 标签认命名空间、不认前缀：`canonical` 把 `ns0:p`、`x:row` 这类写法换回通常的前缀。它在解码成字符串之前、直接在字节上顺着换一遍（`zip.text(name, want)`）。不要改成解码以后再 `replaceAll`：几百万个标签会让内存涨到原文的十几倍，测试里有一个限制了内存的子进程专门查这一点。
    - Word：脚注、尾注、批注在正文里留 `[^1]`、`[^e1]`、`[^c1]`，内容附在最后；页眉页脚各写一遍（重复的、只有页码的不要）；修订里挪走的文字（`w:moveFrom`）不算；符号字体（`w:sym`）按 Symbol / Wingdings 换成普通字符。
    - Excel：数字格式只分日期、累计的时长（`[h]:mm`）、百分比三类，`formatKind` 把格式代码顺着扫一遍来判断；隐藏的工作表标出来；第 2000 列以后的不读，只标 `partial`。
    - PowerPoint：演讲者备注跟在那一页后面；隐藏的幻灯片标出来；页码占位符不算内容。
    - “备注：”“（隐藏）”“页眉：”“页脚：”这几个小标题跟着界面语言走，由 `attachments.js` 通过 `info.labels` 传进去。一个字都没读出来的表格和幻灯片返回空字符串，按“没有找到文字”拒绝。
  - PDF 的两种特殊情况（`pdf-text.js`）：
    - 图片页：一页上画出来的图片面积占到页面的十分之一、文字又不到 20 个字，就算图片页，在文字里写上“（图片，没有能读出来的文字）”（连着的几页并成 `--- 2-3 ---`）。图片页占到全部页数的五分之一时，`attachments.js` 把它算成 `pdf`（文件本身也交出去）并标 `partial`。
    - 从右往左写的文字：PDF 里是按画的顺序存的，每页最后按行转回阅读的顺序（`readingOrder`，简化的双向排序）。行的方向看这一行里哪种字多，拿不准时看整页；括号的朝向看哪一种配得上对。已知的不足：分开画的元音符号可能落在相邻的字母上；LibreOffice 导出的文件里这些符号没有 ToUnicode，会变成零星的拉丁字母。测试里的例子取自 Chromium 和 LibreOffice 生成的 PDF。
  - 输入区（`public/app.js`）：内容是 PNG / JPG / GIF / WebP、浏览器却打不开的图片，在添加时就拒绝（`prepareImage`，看文件开头的字节）；一批文件里的错误攒在一起显示（`uploadErrors`）；重画附件列表时保住键盘焦点（`renderPending`）。这些没有自动测试（仓库里没有浏览器测试的依赖），改动后要在浏览器里手动过一遍。
- 没有用 `--safe-mode`：担心它让 Claude Code 忽略 settings.json 里配置的代理等环境变量。

## 测试

- `npm test`：单元测试 + 端到端测试（真实的本地服务，加上 `test/mocks/` 里模拟的 claude/agy/codex 和模拟接口）+ 只在 Windows 上运行的参数传递测试。附件的测试在 `test/attachments.test.js`（取文字、保存、提示词）和 `test/attachments-e2e.test.js`（上传到各家收到的整条路）；样本文档在 `test/fixtures/`（真实软件生成的，说明见那里的 README），其他文件用 `test/files.js` 现做。
- `test/packaged-app.test.js`：测试打包后的桌面版（CI 在 Windows 上跑）。本机可以用 `xvfb-run -a node test/packaged-app.test.js -- node_modules/electron/dist/electron --no-sandbox .` 测开发版。
- 还没有用真实账号测试过真实的 claude / agy / codex / GitHub Models。用户（Windows）的 codex 是用 npm 装的：`%APPDATA%\npm\codex.cmd`。

## 发布

推送到 main 会触发 `.github/workflows/build.yml`：Linux 和 Windows 上跑测试，在 Windows 上打包、测试打包结果、上传安装包（Actions 产物）。

发布 Release 有两种方式：推送 `vX.Y.Z` 标签；或者在 Actions 页面手动运行这个工作流，填 `release` 输入（例如 `1.0.1`），工作流会在打包前用 `npm version` 改版本号，再创建标签和 Release。Claude Code 云端会话推送标签会被拒绝（HTTP 403），所以发布要由用户在 Actions 页面手动触发，不要绕过这个限制。
