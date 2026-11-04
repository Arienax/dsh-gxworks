# dsh-gxworks

将 [GXWorks Agent](https://github.com/Arienax/gxworks-agent) 封装为 DeepSeek Harness 插件。你可以在对话中读取 GXW 工程、生成程序候选、离线修改支持的程序对象，处理梯形图（Ladder）、ST、FBD 和 SFC 任务。

插件内置 MCP 后端，并注册 `gxworks-mcp-router` 技能，为当前任务选择工具。后端首次启动时在本地解压，后续直接复用，无需另装 Python。原生编译需要本机安装 GX Works2，仿真观察需要 Simulator2。

## 安装

需要 Windows x64、Node.js ≥ 22.12 和 DeepSeek Harness 0.2.x（含预发布版）。将 `web` 换成你使用的 profile。

```powershell
dsh plugin --profile web add dsh-gxworks
```

从 GitHub 安装可用 `dsh plugin --profile web add github:Arienax/dsh-gxworks`。使用插件市场时，添加[市场索引](https://arienax.github.io/dsh-gxworks/index.json)即可找到本插件。

## 使用

安装后可以在同一 profile 的对话中试试下面两条指令。

- “列出我的 PLC 工程。”—— 调用 `mcp__gxworks__list_projects`，也可用来确认插件已连接。
- “读取这个 GXW 文件，说明 MAIN 程序的启动条件。”—— 在对话中提供工程文件路径。

更新用 `dsh plugin --profile web update dsh-gxworks`，卸载用 `dsh plugin --profile web remove dsh-gxworks`。

[English](README.en.md)
