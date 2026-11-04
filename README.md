# dsh-gxworks

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 GXWorks Agent 插件，
**内置完整 MCP 后端和 PLC 路由技能**。Windows x64 安装即用，无需另装 Python、
GXWorks Agent，也无需设置后端路径。

[GitHub 仓库](https://github.com/Arienax/dsh-gxworks) · [English](README.en.md)

## 安装

在自己的 Harness profile 中安装（将 `web` 换成实际 profile）：

```powershell
dsh plugin --profile web add github:Arienax/dsh-gxworks
```

本地完整仓库也可交给插件管理器：

```text
plugin_manager(action: install_bundle, target: "<DSH_GXWORKS_DIR>")
```

发布到 npm 后可用 `dsh plugin --profile web add dsh-gxworks` 安装。
Git、本地目录和完整 npm 包均包含同一份后端 ZIP。安装只需获取插件本身，
首次启动在本地解压后端，后续直接复用，无需再次联网下载或执行依赖安装脚本。

需要 Windows x64、Harness `>=0.2.0-0 <0.3.0` 和 Node.js ≥ 22.12。
原生编译、GX Works2 界面操作与 Simulator2 观察需要用户自备合法安装的三菱软件；
读取、生成、离线编辑及静态检查使用包内后端。

## 包内内容与启动

| 内容 | 用途 |
| --- | --- |
| `runtime/GXWorks-Agent-MCP-windows-x64.zip` | 完整 GXWorks Agent 0.4.0 MCP 成品，约 79 MB，含 Python、检索资源、工程模板、仿真查看器、原生辅助程序和许可声明 |
| `runtime/backend.json` | 固定版本、发布来源及源码提交 |
| `launch/bundled-runtime.mjs` | 首次解压，检查配套资源和版本，后续复用 |
| `launch/mcp-launch.mjs` | stdio 启动器，默认 `--local`；stdout 仅传 MCP 数据 |
| `skills/gxworks-mcp-router/` | 与后端源码对应的上游技能原样副本 |
| `cordis.patch.yml` | MCP 连接、技能来源及安装完整性检查 |

后端来自 [GXWorks Agent 0.4.0 发布](https://github.com/Arienax/gxworks-agent/releases/tag/v0.4.0-20261104)，
完整来源与许可见 [runtime/README.md](runtime/README.md)。默认解压位置：

```text
%LOCALAPPDATA%\dsh-gxworks\runtime\v0.4.0-20261104\GXWorks-Agent-MCP
```

缺少 `LOCALAPPDATA` 时使用用户目录下的 `AppData\Local`。
插件目录可以只读；工程、配置与 MCP 状态使用 GXWorks Agent 的用户数据目录，
不写入插件或后端缓存。

安装后确认 `gxworks-mcp`、`gxworks-skills`、`dsh-gxworks` 三行启用，
工具列表出现 `mcp__gxworks__list_projects`，技能目录出现 `gxworks-mcp-router`。
在插件目录查看启动计划（只显示结果，不启动后端）：

```powershell
node launch/mcp-launch.mjs --print-plan
```

默认 `agentRootSource` 为 `bundled`。以前通过 `--set-root` 保存的外部后端仍优先使用；
删除 `%USERPROFILE%\.dsh\dsh-gxworks\settings.json` 中的 `agentRoot` 可恢复内置默认值。

MCP 工具覆盖工程管理、源码读取、生成、GXW 离线编辑、Ladder/ST/FBD/SFC、原生编译与诊断、
Simulator2 观察；实际工具和参数以连接后的 `tools/list` 为准。
原生编译、保存和冷重开、仿真观察与实际 PLC 行为分别判断。

## 可选配置

普通安装无需指定后端。使用开发检出或自选后端时：

```powershell
node launch/mcp-launch.mjs --set-root "<GXWORKS_AGENT_DIR>"
node launch/mcp-launch.mjs --agent-root "<GXWORKS_AGENT_DIR>" --print-plan
```

`GXWORKS_MCP_EXE` 直接指定入口；否则依次选择 `--agent-root` →
`GXWORKS_AGENT_ROOT` / `GXWORKS_AGENT_HOME` → 已记住的路径 → 内置后端 → 当前目录及上级 → `PATH`。
显式无效路径报错，失效历史路径跳过。

| 配置 | 用途 |
| --- | --- |
| `GXWORKS_MCP_WORKSPACE_DIR` / `--workspace <dir>` | 工程工作区 |
| `--state-dir <dir>` | MCP 状态目录，须在工作区外 |
| `--project <id>` / `--version <id>` | 选择工程及版本 |
| `--service` | 连接已启动的 Web 工作台 |
| `GXWORKS_AGENT_SERVICE_URL` | Web 地址，默认 `http://127.0.0.1:8765` |
| `PLC_WEB_AGENT_TOKEN` | `service` 模式 Agent 令牌 |
| `--approval-mode ask\|auto\|full` | 操作者显式选择外部操作许可；`full` 还需 `--confirm-full-access` |

其余参数可追加到 `cordis.patch.yml` 的 `args` 返回数组中。工具调用超时为 10 分钟；
连接失败写入 Harness 日志，不阻止整个 Harness 启动。

## 排错

| 现象 | 处理 |
| --- | --- |
| 提示插件缺少内置后端 | 重新安装完整插件并检查 `runtime/`，无需安装 Python |
| 解压失败 | 检查用户缓存写入权限、磁盘空间及安全软件记录 |
| 仍指向旧开发目录 | 检查入口/根目录环境变量和已记住的路径 |
| 提示需要 Windows x64 | 使用 Windows x64 Harness；其他平台须显式提供兼容外部后端 |
| `serverName "gxworks" is already in use` | 将同名 MCP 连接改为唯一名称 |
| 原生操作找不到 GX Works2 | 安装用户自备的 GX Works2，插件不包含三菱软件 |
| 技能不可见 | 确认 `gxworks-skills` 启用且包内技能完整 |

## 开发与打包

```powershell
npm run check
npm pack --pack-destination "<OUTPUT_DIR>"
npm run check-install -- "<UNPACKED_PACKAGE_DIR>"
npm run sync-skill -- --source "<PUBLIC_GXWORKS_AGENT_CHECKOUT>"
```

`npm pack` 会拒绝缺少实际后端的插件。`check-install` 使用临时用户目录，隐藏 Python 路径、
清除外部后端配置，从无关目录启动安装包，检查首次解压、MCP 初始化、工具发现、工程创建、
检索与生成上下文；不执行 GX Works2 编译或写入 PLC。

后端 ZIP 是普通 Git 文件，不使用 Git LFS，保证 Git 安装得到实际内容。
更新时同步 `runtime/backend.json`、对应公开源码的技能并保留全部后端许可证。
技能来源见 [COPYING.md](skills/gxworks-mcp-router/COPYING.md)。

市场索引由 `market/plugins.txt` 与 Harness 的 `dsh-plugin-market-generator` 生成。
发布源码后，再生成并发布固定到该提交的 `docs/index.json`。
旧 `0.1.x` 索引条目不含后端，不应用于安装本次修复。

使用 `plugin_manager(action: remove_bundle, target: "dsh-gxworks")` 卸载。
卸载不删除工程、个人配置或三菱软件；后端缓存可在相关进程停止后手动删除。

## 许可

项目作者编写的源码、文档及配置采用 [Apache-2.0](LICENSE)。
包内 GXWorks Agent 和路由技能采用 Apache-2.0；第三方许可声明保留在后端归档中。
本插件不分发 GX Works2、其他 Mitsubishi Electric 软件或厂商手册。
