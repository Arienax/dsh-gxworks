<!-- SPDX-License-Identifier: AGPL-3.0 -->

# dsh-gxworks

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/arienax/dsh-gxworks)

The complete backend installs automatically as six exact-version npm dependencies,
using your configured npm registry. Mirrors must synchronize the main package and
all six dependencies. Startup never downloads from GitHub. All knowledge is retained;
the total download remains approximately 389 MB.

This plugin brings [GXWorks Agent](https://github.com/Arienax/gxworks-agent) into DeepSeek Harness for Ladder, ST, FBD and SFC tasks. Use chat to read GXW projects, generate program candidates and edit supported program objects offline.

The plugin bundles the MCP backend and registers the `gxworks-mcp-router` skill to select tools for each task. It extracts the backend locally on first use and reuses it on later launches. No separate Python installation is required. Native compilation requires a local GX Works2 installation, and simulation observation requires Simulator2.

## Licensing

**dsh-gxworks code and documentation are AGPL-3.0.** The bundled GXWorks Agent 0.4.4 backend and synchronized upstream skill are AGPL-3.0, with their notices preserved. [Corresponding source](https://github.com/Arienax/gxworks-agent/tree/v0.4.4-20261129) · [License](https://www.gnu.org/licenses/agpl-3.0.html).

Distribution of covered software requires access to its complete Corresponding Source under the license; covered derivative works remain under AGPL-3.0. A modified version used interactively over a network must also offer its Corresponding Source to those remote users free of charge. Independent PLC programs generated with the tool do not automatically become AGPL-licensed merely through use of the tool.

## Install

Requires Windows x64, Node.js ≥ 24.9 and DeepSeek Harness ≥ 0.2.2-rc.3, < 0.3.0. Use a Web or Desktop profile with the MCP manager service; replace `web` below with your profile name.

The host MCP manager registers GXWorks MCP and exposes its connection status. Disabling or uninstalling the plugin also stops its server. The first launch extracts the complete backend locally, with a startup allowance of 10 minutes.

```powershell
dsh plugin --profile web add dsh-gxworks
```

To install from GitHub, use `dsh plugin --profile web add github:Arienax/dsh-gxworks`. To find the plugin in the marketplace, add the [market index](https://arienax.github.io/dsh-gxworks/index.json).

## Use

Open a chat in the same profile and try one of these requests.

The DSH session model calls upstream MCP tools directly. The backend selects Direct or Design; Design proposals are confirmed through the host's question window. The plugin configures whole-document delivery in the upstream MCP server. Referenced facts use the upstream restore tool; the plugin does not assemble pages or rewrite results. DSH may retain a preview of long output with a full-file link; follow the host's instructions to read the complete result.

The plugin no longer provides `gxworks_generate_ladder` or its own generation schema, instruction-selection policy, structural repair loop or mandatory review. Upstream owns Ladder/ST/FBD/SFC contracts, condition expansion, named operand binding, timer conversion and candidate saving. Report compilation and behavior checks from the backend's actual results. [Independent case format](runtime/README.md#independent-io-cases)

- “List my PLC projects.” This calls `mcp__gxworks__list_projects` and lets you check that the plugin is connected.
- “Where is GX Works2 installed, and is a project open?” The `mcp__gxworks__list_gxworks2_sessions` tool reports the executable path detected by the backend and lists open windows and their project state separately.
- “Read this GXW file and explain the start conditions in MAIN.” Include the path to the project file.

To update, run `dsh plugin --profile web update dsh-gxworks`. To uninstall, run `dsh plugin --profile web remove dsh-gxworks`.

[中文](README.md)
