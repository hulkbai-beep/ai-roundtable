# AI 圆桌

把 Claude、Gemini、GPT 拉进同一个群聊：你出题，它们轮流发言、互相接话。程序完全在你自己的电脑上运行。

| 成员 | 默认接入方式 | 用的是 |
|---|---|---|
| Claude | Claude Code 命令行（`claude`） | 你的 Claude Max 订阅 |
| Gemini | Antigravity CLI 命令行（`agy`） | 你的 Google AI Pro 订阅 |
| GPT | GitHub Models 接口 | GitHub 账号自带的免费额度（不需要 ChatGPT 订阅） |

---

## 一、安装 AI 圆桌

1. 打开本仓库的 **[Releases 页面](https://github.com/hulkbai-beep/ai-roundtable/releases)**，下载最新的 `AI-Roundtable-Setup-x.y.z.exe`。
2. 双击安装。安装包没有做代码签名，Windows 可能弹出“Windows 已保护你的电脑”，点「更多信息」→「仍要运行」。
3. 装好后，开始菜单和桌面上会有 **AI 圆桌** 的图标。

> 想看最新的开发版：仓库的 Actions 页面 → 最近一次成功的「测试和打包」→ 页面底部的 `AI-Roundtable-Windows`（下载下来是一个 zip，里面是安装包）。

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

### 3. GPT：创建 GitHub Token（免费）

1. 打开 https://github.com/settings/personal-access-tokens/new （Fine-grained token）
2. **Token name** 随便填，比如 `ai-roundtable`；**Expiration** 选一个有效期。
3. 在权限（Permissions）里找到 **Models**，设为 **Read-only**。
4. 点 **Generate token**，复制以 `github_pat_` 开头的那串字符，等下粘贴到 AI 圆桌的设置里。

免费额度大约每天几十到一百多次请求，每次请求最多约 8000 token，具体以 GitHub 官方说明为准。

---

## 三、第一次设置

1. 打开 AI 圆桌，点右上角的齿轮「设置」。
2. 在 GPT 卡片里，把 GitHub Token 粘贴进去。
3. 给每位成员点一下「保存并测试」，看到 **✓ 连上了** 就说明能用。

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
- 设置里还可以：调整发言顺序、暂时关掉某位成员、给某位加「额外人设」（比如“你是一位挑剔的投资人”）。

---

## 五、常见问题

**某位成员测试失败？** 先看红字里的“建议”。常见原因：

- **找不到命令**：刚装完的话，关掉 AI 圆桌再重新打开；还不行就在设置里填 `.exe` 的完整路径（比如 `C:\Users\你的用户名\.local\bin\claude.exe`）。
- **Claude 提示登录 / 认证问题**：在 PowerShell 里运行一次 `claude` 重新登录。
- **Gemini（agy）没有输出或者一直超时**：有用户反馈 agy 被别的程序调用时可能卡住。先确认 agy 是最新版本；还不行的话，在设置里把 Gemini 的接入方式换成「Gemini API Key」。这需要在 Google AI Studio（https://aistudio.google.com）申请 API Key，而且**不走 AI Pro 订阅**，费用和免费额度以官网为准。
- **GPT 报 401**：Token 不对或过期。**403**：Token 没给 Models 权限。**429**：今天的免费额度用完了，或者请求太频繁。**模型不存在**：在设置里点「加载可用模型」换一个。

**连不上 GitHub / Google 的接口？** 如果你平时要开代理（比如 Clash），在设置里填代理地址，例如 `http://127.0.0.1:7890`。

**每条 Claude 回复都会触发我给 Claude Code 配的 hooks（比如提示音）？** 在设置里勾选「显示高级选项」，在 Claude 的「额外命令行参数」里填 `--safe-mode`。

**想换一种方式接 GPT？** 设置里 GPT 的接入方式还可以选：

- **Codex CLI**：用免费的 ChatGPT 账号登录。先运行 `npm i -g @openai/codex`，再运行一次 `codex` 登录。OpenAI 目前允许免费账号用 Codex，但额度很小，也可能只是限时开放。
- **自定义 OpenAI 兼容接口**：比如 OpenRouter，或者本机 Ollama 跑的开源模型（接口地址 `http://localhost:11434/v1`）。

**额度怎么算？** 每次发言都会把聊天记录发给对应的 AI，聊得越久越耗额度。Claude 和 Gemini 用的是你的订阅额度，和你平时在网页、App 上的用量是同一份。轮数开得越多，消耗越快。

**出了问题想看日志？** 菜单「文件」→「打开日志」（按 Alt 键显示菜单）。把日志里的报错发给开发者就行。

---

## 六、数据和隐私

- 程序只在你的电脑上运行，只接受本机（127.0.0.1）的访问，局域网里的其他设备连不上。
- 设置、聊天记录和日志保存在 `%APPDATA%\AI Roundtable`（菜单「文件」→「打开数据文件夹」）。GitHub Token 等设置保存在其中的 `config.json`（明文），不要发给别人。卸载程序时这些数据会保留。
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

每次推送到 `main`，GitHub Actions 会在 Linux 和 Windows 上跑测试，再在 Windows 上打包安装包并测试打包结果。推送 `v` 开头的标签（比如 `v1.0.1`）会自动发布一个 Release。
