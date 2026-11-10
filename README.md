# AI 圆桌

**English:** A local group chat where Claude, Gemini and GPT take turns and reply to each other, using your own subscriptions through their official command-line tools. The app follows your system language; switch any time in Settings → 语言 / Language. This guide is in Chinese for now.

把 Claude、Gemini、GPT 拉进同一个群聊：你出题，它们轮流发言、互相接话。程序完全在你自己的电脑上运行。

| 成员 | 默认接入方式 | 用的是 |
|---|---|---|
| Claude | Claude Code 命令行（`claude`） | 你的 Claude Max 订阅 |
| Gemini | Antigravity CLI 命令行（`agy`） | 你的 Google AI Pro 订阅 |
| GPT | Codex CLI 命令行（`codex`） | 你的 ChatGPT 账号，免费账号也能用（不需要 ChatGPT 订阅） |

---

## 一、安装 AI 圆桌

1. 下载安装包 `AI-Roundtable-Setup-x.y.z.exe`，两个地方都可以：
   - 本仓库的 **[Releases 页面](https://github.com/hulkbai-beep/ai-roundtable/releases)**（发布过的正式版本）；
   - 仓库的 **[Actions 页面](https://github.com/hulkbai-beep/ai-roundtable/actions)** → 最近一次带绿色勾的「测试和打包」→ 页面底部 Artifacts 里的 `AI-Roundtable-Windows`。下载下来是一个 zip，解压出来就是安装包。每次改代码都会自动生成，保留 90 天。
2. 双击安装。安装包没有做代码签名，Windows 可能弹出“Windows 已保护你的电脑”，点「更多信息」→「仍要运行」。
3. 装好后，开始菜单和桌面上会有 **AI 圆桌** 的图标。

---

## 二、准备三位成员（只需要做一次）

### 1. Claude：安装并登录 Claude Code

已经在用 Claude Code 的话可以跳过。打开 PowerShell，运行：

```powershell
irm https://claude.ai/install.ps1 | iex
```

装好后运行一次 `claude`，按提示用 **Max 账号**登录。登录成功后输入 `/exit` 退出。

### 2. Gemini：安装并登录 Antigravity CLI

> 2026 年 6 月 18 日起，Gemini CLI 不能再用 AI Pro 订阅登录，订阅用户需要改用 Google 的 Antigravity CLI（命令叫 `agy`）。

在 PowerShell 里运行下面任意一个（安装方式以 Google 官方页面为准）：

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

```powershell
winget install Google.AntigravityCLI
```

装好后运行一次 `agy`，用**开通了 AI Pro 的 Google 账号**登录，然后退出。

### 3. GPT：安装并登录 Codex CLI（免费）

先在 PowerShell 里检查一下是不是已经装过：

```powershell
where.exe codex
```

能看到类似 `C:\Users\你的用户名\AppData\Roaming\npm\codex.cmd` 的路径，就说明装好了，跳到最后一步登录。没装的话，先安装 Node.js（https://nodejs.org 下载 LTS 版），再运行：

```powershell
npm i -g @openai/codex
```

最后运行一次 `codex`，选择用 **ChatGPT 账号**登录（免费账号也可以），登录成功后退出。

> OpenAI 目前允许免费的 ChatGPT 账号使用 Codex，但额度比较小，也可能只是限时开放。哪天用不了了，可以把 GPT 换成「GitHub Models」，同样免费，步骤见下面「常见问题」。

---

## 三、第一次设置

1. 打开 AI 圆桌，点右上角的齿轮「设置」。
2. 给每位成员点一下「保存并测试」，看到 **✓ 连上了** 就说明能用。命令行工具的输入框下面会显示「已找到：…」，说明 AI 圆桌找到了它们。

---

## 四、怎么玩

- **模式**
  - 自由讨论：像朋友聊天，可以有分歧
  - 辩论：各自亮明立场，互相反驳
  - 合作：一起完成一个任务，最后一位会总结
  - 各自回答：这一轮互相看不到对方的回答，适合对比三家
- **轮数**：每位成员发言几次。选 2 轮以上，它们会回应彼此的观点。
- **篇幅**：简短 / 适中 / 详细
- **@点名**：消息里写 `@Claude`、`@Gemini`、`@GPT`，只有被点到的成员回答；`@所有人` 表示全员。
- **继续聊**：不发新消息，让大家再聊一轮。
- **停止**：打断正在发言的成员，取消后面排队的发言。
- 它们说话的时候你也可以插话：新消息会被后面发言的成员看到，并替换掉还没轮到的发言安排。
- 右上角按钮：历史对话、导出 Markdown、新对话、设置。
- 每位成员可以在设置里选 **模型** 和 **思考强度**（低 / 中 / 高……）。思考强度越高，回复越慢、越耗额度。每条回复旁边会标出用的模型和思考强度。
- 界面有中文和英文两种语言：默认跟随系统，也可以在设置的「语言 / Language」里切换。切到英文后，AI 默认也用英文回复。
- 设置里还可以：调整发言顺序、暂时关掉某位成员、给某位加「额外人设」（比如“你是一位挑剔的投资人”）。

---

## 五、常见问题

**某位成员测试失败？** 先看红字里的“建议”。常见原因：

- **找不到命令**：刚装完的话，关掉 AI 圆桌再重新打开；还不行就在设置里填 `.exe` 的完整路径（比如 `C:\Users\你的用户名\.local\bin\claude.exe`）。
- **Claude 提示登录 / 认证问题**：在 PowerShell 里运行一次 `claude` 重新登录。
- **Gemini（agy）没有输出或者一直超时**：有用户反馈 agy 被别的程序调用时可能卡住。先确认 agy 是最新版本；还不行的话，在设置里把 Gemini 的接入方式换成「Gemini API Key」。这需要在 Google AI Studio（https://aistudio.google.com）申请 API Key，而且**不走 AI Pro 订阅**，费用和免费额度以官网为准。
- **GPT（Codex）提示登录问题**：在 PowerShell 里运行一次 `codex` 重新登录。**提示额度用完**：免费账号的额度比较小，过一阵再试，或者暂时换成 GitHub Models。
- **Codex 回复比较慢**：在设置里把 GPT 的「思考强度」选成「低」，让它少想一点、回复快一些。

**连不上 GitHub / Google 的接口？** 如果你平时要开代理（比如 Clash），在设置里填代理地址，例如 `http://127.0.0.1:7890`。

**每条 Claude 回复都会触发我给 Claude Code 配的 hooks（比如提示音）？** 在设置里勾选「显示高级选项」，在 Claude 的「额外命令行参数」里填 `--safe-mode`。

**想换一种方式接 GPT？** 设置里 GPT 的接入方式还可以选：

- **GitHub Models（免费）**：用 GitHub 账号自带的免费额度。
  1. 打开 https://github.com/settings/personal-access-tokens/new （Fine-grained token），Token name 随便填，选一个有效期。
  2. 在权限（Permissions）里找到 **Models**，设为 **Read-only**，点 Generate token。
  3. 把以 `github_pat_` 开头的 token 粘贴到设置里 GPT 卡片的「GitHub Token」，点「保存并测试」。

  免费额度大约每天几十到一百多次请求，每次请求最多约 8000 token。报 401 是 token 不对或过期，403 是没给 Models 权限，429 是今天的额度用完了。
- **自定义 OpenAI 兼容接口**：比如 OpenRouter，或者本机 Ollama 跑的开源模型（接口地址 `http://localhost:11434/v1`）。

**额度怎么算？** 每次发言都会把聊天记录发给对应的 AI，聊得越久越耗额度。Claude 和 Gemini 用的是你的订阅额度，和你平时在网页、App 上的用量是同一份。轮数开得越多，消耗越快。

**出了问题想看日志？** 菜单「文件」→「打开日志」（按 Alt 键显示菜单）。把日志里的报错发给开发者就行。

---

## 六、数据和隐私

- 程序只在你的电脑上运行，只接受本机（127.0.0.1）的访问，局域网里的其他设备连不上。
- 设置、聊天记录和日志保存在 `%APPDATA%\AI Roundtable`（菜单「文件」→「打开数据文件夹」）。API Key、Token 等设置保存在其中的 `config.json`（明文），不要发给别人。卸载程序时这些数据会保留。
- 三个命令行工具都在数据目录里一个空的 `workspace` 文件夹里运行。Claude 的工具被关掉了，Codex 是只读模式，另外也会要求它们只聊天、不读写文件、不运行命令。

---

## 七、开发者说明

| 路径 | 作用 |
|---|---|
| `electron/main.js` | 桌面版入口：启动本地服务，在窗口里显示界面 |
| `server.js`、`start.bat` | 浏览器版入口：不装桌面版也能用（需要 Node.js 18+） |
| `lib/` | 后台：调度谁发言（`orchestrator.js`）、三家的接入方式（`providers.js`）、Windows 上启动命令行工具（`spawn.js`） |
| `lib/prompt.js` | 群聊规则（AI 的“人设”），想调整说话风格改这里 |
| `public/` | 网页界面，桌面版和浏览器版共用 |
| `test/` | 自动测试，用模拟的命令行工具和接口，不会真的调用 AI |

```bash
npm install            # 安装开发依赖（Electron 和打包工具）
npm start              # 浏览器版
npm run app            # 桌面版（开发模式）
npm test               # 自动测试
npm run dist:win       # 打包 Windows 安装包（需要在 Windows 上运行）
```

每次推送到 `main`，GitHub Actions 会在 Linux 和 Windows 上跑测试，再在 Windows 上打包安装包并测试打包结果。

**发布一个正式版本：** 打开仓库的 Actions 页面 → 左边选「测试和打包」→ 右边点「Run workflow」→ 在「要发布的版本号」里填比如 `1.0.0` → 点绿色的「Run workflow」。大约 10 分钟后，Releases 页面就会出现 `v1.0.0`，里面附带安装包。（推送 `v` 开头的标签也能触发发布。）
