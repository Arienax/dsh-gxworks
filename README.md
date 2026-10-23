# dsh-gxworks

仓库：<https://github.com/Arienax/dsh-gxworks> · 市场索引：<https://arienax.github.io/dsh-gxworks/index.json>

把 [GXWorks Agent](https://github.com/Arienax/gxworks-agent) 的 **MCP 服务**和 **路由 Skill** 打包成
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。安装一次，Harness 里的 Agent
就能对三菱 PLC 工程做只读检查、程序生成、离线 `.gxw` 编辑、后台原生编译检查和 Simulator2 观察。

English: [README.en.md](README.en.md)

## 插件做了什么

这一层 bundle patch 插入两行插件，两者互相独立、可分别停用：

| 行 | 插件 | 作用 |
| --- | --- | --- |
| `gxworks-mcp` | `@deepseek-ai/dsh-mcp-client` | 以 stdio 启动本机 GXWorks Agent MCP，工具在会话里呈现为 `mcp__gxworks__<原始工具名>` |
| `gxworks-skills` | `@deepseek-ai/dsh-skill-filesystem` | 注册一个只扫描本包 `skills/` 的独立技能源（`providerName: gxworks`），带进 `gxworks-mcp-router` 技能 |

`launch/mcp-launch.mjs` 负责把 Windows 上的安装形态收敛成一个命令：它先找安装根
（`--agent-root` → `GXWORKS_AGENT_ROOT` → 从工作目录向上找），再依次尝试
`GXWorks-Agent-MCP.exe`、`.venv-mcp`、`.venv`、`py -3`、`python`，并在调用方没有指定模式时补上 `--local`。
它的 stdout 只承载 MCP 协议数据，诊断一律写 stderr。

## 目录结构

```
dsh-gxworks/
├── package.json            bundle 清单（dsh.bundle.patch、locale/icon 导出）
├── cordis.patch.yml        插件行：MCP 连接 + 技能源
├── launch/mcp-launch.mjs   stdio 启动器（安装根解析、模式默认值、arg 透传）
├── skills/
│   └── gxworks-mcp-router/ 上游技能原样副本（SKILL.md + references/）
├── locale/{en,zh}.json     插件管理页的标题与说明
├── icon.svg                插件图标
├── scripts/sync-skill.mjs  从 GXWorks Agent 检出重新同步技能
└── tests/launch.test.mjs   启动器解析顺序的单元测试
```

## 前置条件

- Windows。原生编译、GX Works2 界面交互与 Simulator2 采样依赖本机安装的三菱软件；
  纯 Python Core 的读取、生成与静态检查不需要它们。
- 本机存在 GXWorks Agent：源码检出（含 `.venv` 与 `scripts/mcp_entry.py`）或 MCP 独立发布包（含
  `GXWorks-Agent-MCP.exe`）。
- DeepSeek Harness profile（Web 或 CLI），Node.js ≥ 22.12。

## 安装

先在命令行里登记本机安装根。Harness 的工作目录通常在自身源码或其他工程里，不一定紧邻 GXWorks Agent，
所以这一步是一次性、跨会话生效的。下方 `<..._DIR>` 均为目录占位符，请替换成自己的实际安装或检出目录：

```powershell
node launch/mcp-launch.mjs --set-root "<GXWORKS_AGENT_DIR>"
node launch/mcp-launch.mjs --print-plan      # 核对解析结果
```

它把路径写入 `%USERPROFILE%\.dsh\dsh-gxworks\settings.json`；目录里必须存在
`GXWorks-Agent-MCP.exe` 或 `scripts\mcp_entry.py`，否则直接拒绝。也可以用环境变量
`GXWORKS_AGENT_ROOT` 代替，或把工作目录放在安装目录之内。

然后在 Harness 里装这个包（`--profile` 换成你自己在用的 profile）：

```powershell
dsh plugin --profile web add dsh-gxworks
```

想跟源码走、不用 npm 版本时，用源码安装形式：

```powershell
dsh plugin --profile web add github:Arienax/dsh-gxworks
```

也可以在本机源码检出目录里用插件管理器按绝对路径链装：

```
plugin_manager(action: install_bundle, target: "<DSH_GXWORKS_DIR>")
```

或者手动把本包加入 profile：在 profile 的 `package.json` 里把它登记到 `dsh.profile.bundles`，
让 `cordis.patch.yml` 进入层栈。安装后确认三件事：

1. 插件列表里 `gxworks-mcp`、`gxworks-skills`、`dsh-gxworks` 三行都是 active；
2. 工具列表出现 `mcp__gxworks__*`，例如 `mcp__gxworks__list_projects`；
3. 技能目录出现 `gxworks-mcp-router`。

安装失败时先看 Harness 日志里 `dsh-gxworks` / `mcp-client(gxworks)` 的输出，再按下文排错。

## 配置

启动器读取的环境变量：

| 变量 | 含义 |
| --- | --- |
| `GXWORKS_AGENT_ROOT` | GXWorks Agent 安装根，优先于已记住的路径 |
| `GXWORKS_AGENT_HOME` | 同上，兼容旧名 |
| `GXWORKS_MCP_EXE` | 直接指定 `GXWorks-Agent-MCP.exe`，跳过安装根解析 |
| `GXWORKS_MCP_WORKSPACE_DIR` | `local` 模式的工程工作区；不设时用 GXWorks Agent 的默认 MCP 工作区 |
| `GXWORKS_AGENT_SERVICE_URL` | `service` 模式的本地 Web 源，默认 `http://127.0.0.1:8765` |
| `PLC_WEB_AGENT_TOKEN` | `service` 模式的 Agent 令牌（通常由 GXWorks Agent 写入 Credential Manager） |

安装根的完整解析顺序：`--agent-root` → `GXWORKS_AGENT_ROOT` / `GXWORKS_AGENT_HOME` →
`%USERPROFILE%\.dsh\dsh-gxworks\settings.json` → 工作目录及其上级 → `PATH` 上的
`GXWorks-Agent-MCP.exe`。`--print-plan` 会打印最终命令与 `agentRootSource`。

除环境变量外，其余参数直接写进 `cordis.patch.yml` 的 `args`。`args` 是一个表达式返回的数组，
在数组里追加参数即可，例如连接已启动的 Web 工作台：

```yaml
        args: !!js "(() => { const p = process.getBuiltinModule('node:path'); const u = process.getBuiltinModule('node:url'); return [p.join(u.fileURLToPath(baseUrl), 'launch', 'mcp-launch.mjs'), '--service']; })()"
```

常用的透传参数：

| 参数 | 用途 |
| --- | --- |
| `--local` | 独立工程运行时，编辑直接保存为版本（默认） |
| `--service` | 连接已启动的 Web 工作台，按工作台审批策略出提案 |
| `--workspace <dir>` | 指定工程工作区 |
| `--project <id>` / `--version <id>` | 固定选中的工程与版本 |
| `--state-dir <dir>` | 独立运行时的状态目录（必须在工作区之外） |
| `--approval-mode ask\|auto\|full` | 操作者显式给出的外部操作许可；`full` 还需 `--confirm-full-access` |

此外还有本插件自己的三个参数，只在命令行上使用，不会传给 MCP 服务：
`--set-root <dir>`（记住安装根）、`--agent-root <dir>`（本次使用指定安装根）、`--print-plan`（只打印解析结果）。

`toolCallTimeoutMs` 在 patch 里设为 10 分钟，因为原生编译、冷重开和波形采样都会超过默认的 60 秒；
连接中断由 `reconnect` 自动重试，`failOnStartupError: false` 保证本机没装三菱软件时 Harness 仍能启动。

## 工具与技能

- MCP 工具覆盖工程选择与结果、源码发现与静态分析、生成与离线编辑、FBD/ST/SFC、原生工程与编译分析、
  Simulator2 观察。完整清单与参数以连接后的 `tools/list` 为准。
- `gxworks-mcp-router` 技能记录按任务意图选入口工具、参数要点与调用顺序，覆盖
  `local` / `service` / `context` 三种接入模式的回执判读。它只在需要时加载，不占常驻上下文。

原生写操作、界面交互与 PLC 运行语义分别取证：编译通过不等于运行正确，`local` 模式保存版本也不等于
已经过工作台复核。

## 验证与排错

```powershell
# 登记安装根，并看启动器为当前机器解析出的命令
node launch/mcp-launch.mjs --set-root "<GXWORKS_AGENT_DIR>"
node launch/mcp-launch.mjs --print-plan

# 在 GXWorks Agent 目录里验证 Python 侧运行时
.venv\Scripts\python.exe scripts\mcp_entry.py --local --check
```

| 现象 | 处理 |
| --- | --- |
| 日志提示“未找到本机 GXWorks Agent 安装目录” | 运行 `--set-root`，或设置 `GXWORKS_AGENT_ROOT` |
| 日志提示 Python 运行时不可用 | 在安装目录创建 `.venv` 并 `pip install -r requirements/mcp.txt`，或改用独立发布包 |
| 日志提示 `serverName "gxworks" is already in use` | profile 里还有另一个 `mcp-client` 行用了同名 `serverName`，改成唯一名字 |
| 工具调用超时 | 原生编译等慢操作调大 `toolCallTimeoutMs`；写入状态不明时先用 `get_operation_status` 核对 |
| 技能目录里没有 `gxworks-mcp-router` | 确认 `gxworks-skills` 行处于启用状态，且 `<包目录>/skills/gxworks-mcp-router/SKILL.md` 存在 |

## 卸载

```
plugin_manager(action: remove_bundle, target: "dsh-gxworks")
```

或从 profile 的 `dsh.profile.bundles` 移除本包。卸载只影响 Harness 侧的连接与技能，
不改动 GXWorks Agent 的工程、状态目录或 GX Works2 安装。

## 插件市场

本仓库同时是一份自建插件市场索引，托管在 GitHub Pages：

```
https://arienax.github.io/dsh-gxworks/index.json
```

在 Harness 里打开「插件」页 → 实验性插件里开启 **Custom plugin markets** → 在「发现」的**索引源**里加上这个
URL，就能看到并安装 `dsh-gxworks`。索引只描述本仓库，安装仍走 `plugin_manager` 并需要你确认；条目里的版本
固定到具体 Git 提交，DSH 兼容性由 `engines.dsh` 声明（当前 `>=0.2.0-0 <0.3.0`）。

索引是生成物：`market/plugins.txt` 是来源列表，`docs/index.json` 由 DSH 自带的生成器写出并已通过其校验器。

```powershell
# 在 dsh-gxworks 仓库根目录执行
$bundleDir = (Get-Location).Path
Push-Location "<DEEPSEEK_HARNESS_DIR>"
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start `
  --input (Join-Path $bundleDir 'market/plugins.txt') `
  --output (Join-Path $bundleDir 'docs/index.json') `
  --title "GXWorks Agent Plugins" `
  --description "GXWorks Agent 的 MCP 服务与 PLC 任务路由技能，供 DeepSeek Harness 使用。"
Pop-Location
```

发版顺序是：改 `package.json` 的 `version` → 提交并推送 → 重新生成索引 → 提交 `docs/index.json`。
生成器只读已推送的提交，未推送的改动不会进入索引。

## 开发

```powershell
npm test          # 启动器解析顺序的单元测试
npm run check     # 语法检查 + 测试
npm run sync-skill -- --source "<GXWORKS_AGENT_DIR>"
```

`skills/gxworks-mcp-router/` 是上游技能的原样副本，由 `scripts/sync-skill.mjs` 重新同步并写入来源说明；
上游技能是唯一事实来源，本仓库不在此处改写技能内容。
同步源须为 Git 检出，且技能目录没有未提交改动；`COPYING.md` 记录该检出的实际 `HEAD`，技能元数据中的 `source-commit` 仍表示其对应的产品源码版本。

## 许可与来源

本仓库中由本项目作者编写的源码、文档与配置采用 [Apache License 2.0](LICENSE)。
`skills/gxworks-mcp-router/` 来自 `Arienax/gxworks-agent`（Apache-2.0），来源与同步提交记录在
[COPYING.md](skills/gxworks-mcp-router/COPYING.md)。

本插件不分发 GX Works2、Mitsubishi Electric 软件、厂商手册或商标内容；原生功能依赖用户自备的合法安装。
