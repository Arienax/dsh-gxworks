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

安装后可以在同一 profile 的对话中试试这些指令。

新建程序默认先走 Design，选定方案后按规格生成。说“直接生成”即可走 Direct。新建 Ladder 时，Desktop 按 CPU 查手册，在适用的梯级复用移位或搬运片段，一次生成一份程序。开始验证时会在聊天中提示一次。片段检查无法判断外部写入的触发关系时保留候选并提示未验证，不因保护条件写法不同而拒绝。后端按已确认的行为条件或独立 I/O 用例回放，只在发现明确反例时追加一次局部修正。结果会单列尚未验证的行为。[独立用例格式](runtime/README.md#independent-io-cases)

- “列出我的 PLC 工程。”—— 调用 `mcp__gxworks__list_projects`，也可用来确认插件已连接。
- “GX Works2 安装在哪里？有打开的工程吗？”—— `mcp__gxworks__list_gxworks2_sessions` 返回后端检测到的可执行文件路径，并单独列出窗口与工程状态。
- “读取这个 GXW 文件，说明 MAIN 程序的启动条件。”—— 在对话中提供工程文件路径。

更新用 `dsh plugin --profile web update dsh-gxworks`，卸载用 `dsh plugin --profile web remove dsh-gxworks`。

[English](README.en.md)
