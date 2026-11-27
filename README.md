<!-- SPDX-License-Identifier: AGPL-3.0 -->

# dsh-gxworks

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/arienax/dsh-gxworks)

将 [GXWorks Agent](https://github.com/Arienax/gxworks-agent) 封装为 DeepSeek Harness 插件。你可以在对话中读取 GXW 工程、生成程序候选、离线修改支持的程序对象，处理梯形图（Ladder）、ST、FBD 和 SFC 任务。

插件内置 MCP 后端，并注册 `gxworks-mcp-router` 技能，为当前任务选择工具。后端首次启动时在本地解压，后续直接复用，无需另装 Python。原生编译需要本机安装 GX Works2，仿真观察需要 Simulator2。

完整后端通过六个固定版本的 npm 依赖包随插件自动安装，全部使用你配置的 npm 源。使用大陆镜像时，镜像需同步主包和这六个依赖；启动时不从 GitHub 下载。分包保留全部知识，总下载量约 386 MB。

## 许可与开源义务

**dsh-gxworks 自有代码和文档采用 AGPL-3.0**；内置 GXWorks Agent 0.4.2 后端及同步的上游技能采用 AGPL-3.0，其许可与版权声明随包保留。[对应源码](https://github.com/Arienax/gxworks-agent/tree/v0.4.2-20261117) · [AGPL-3.0 全文](https://www.gnu.org/licenses/agpl-3.0.html)。

AGPL-3.0 是强 copyleft 许可证：分发受其约束的程序或修改版时，必须按许可提供完整对应源码，并让受许可覆盖的衍生作品继续采用 AGPL-3.0；修改后通过网络向用户提供交互服务，也必须向这些用户免费提供该版本的对应源码。不能把受其覆盖的修改或衍生部分闭源再分发，或以网络服务方式规避上述义务。仅使用工具生成的独立 PLC 程序，不会因此自动适用 AGPL-3.0。具体范围以许可证为准。

## 安装

需要 Windows x64、Node.js ≥ 24.9 和 DeepSeek Harness ≥ 0.2.2-rc.3、< 0.3.0。使用带有 MCP 管理服务的 Web 或 Desktop profile；下面的 `web` 换成你的 profile。

GXWorks MCP 由宿主的 MCP 管理服务注册，可在宿主中查看连接状态；禁用或卸载插件会同时停止服务。首次启动需要本地解压完整后端，启动等待上限为 10 分钟。

```powershell
dsh plugin --profile web add dsh-gxworks
```

从 GitHub 安装可用 `dsh plugin --profile web add github:Arienax/dsh-gxworks`。使用插件市场时，添加[市场索引](https://arienax.github.io/dsh-gxworks/index.json)即可找到本插件。

## 使用

安装后可以在同一 profile 的对话中试试这些指令。

DSH 会话模型直接调用上游 MCP 工具。新建程序按后端选择 Direct 或 Design；Design 方案通过宿主窗口确认。插件配置后端整份读取容量，由上游 MCP 一次交付完整文档；资料引用沿用上游的恢复工具。插件不拼装分页或改写返回内容。DSH 对较长结果可能显示摘要并提供完整文件，按宿主提示读取全文。

插件不再提供 `gxworks_generate_ladder`，也不自行改写生成格式、指令选择、结构修复或审查要求。Ladder、ST、FBD、SFC 的生成与编辑合同、输入电平展开、命名操作数绑定、定时节拍换算和候选保存均由上游后端负责。编译与行为检查以本次后端返回的结果为准。[独立用例格式](runtime/README.md#independent-io-cases)

- “列出我的 PLC 工程。”—— 调用 `mcp__gxworks__list_projects`，也可用来确认插件已连接。
- “GX Works2 安装在哪里？有打开的工程吗？”—— `mcp__gxworks__list_gxworks2_sessions` 返回后端检测到的可执行文件路径，并单独列出窗口与工程状态。
- “读取这个 GXW 文件，说明 MAIN 程序的启动条件。”—— 在对话中提供工程文件路径。

更新用 `dsh plugin --profile web update dsh-gxworks`，卸载用 `dsh plugin --profile web remove dsh-gxworks`。

[English](README.en.md)
