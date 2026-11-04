# dsh-gxworks

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin with the
**complete GXWorks Agent MCP backend and PLC routing skill included**.
On Windows x64, no separate Python/backend installation or path configuration is needed.

[GitHub repository](https://github.com/Arienax/dsh-gxworks) · [中文](README.md)

## Install

Replace `web` with your Harness profile:

```powershell
dsh plugin --profile web add github:Arienax/dsh-gxworks
```

A complete local checkout also works:

```text
plugin_manager(action: install_bundle, target: "<DSH_GXWORKS_DIR>")
```

Once published to npm, use `dsh plugin --profile web add dsh-gxworks`.
Git, local-directory and complete npm-package installs contain the same backend ZIP.
The first launch extracts it locally; later launches reuse that release. There is
no separate backend download or dependency install script.

Requires Windows x64, Harness `>=0.2.0-0 <0.3.0`, and Node.js ≥ 22.12.
Native compilation, GX Works2 UI operations and Simulator2 observation require the
user's own licensed Mitsubishi software. Reading, generation, offline editing and
static checks use the bundled backend.

## Components and launch

| Component | Purpose |
| --- | --- |
| `runtime/GXWorks-Agent-MCP-windows-x64.zip` | Complete GXWorks Agent 0.4.0 MCP release, about 79 MB, including Python, retrieval resources, templates, simulator viewer, native helpers and license notices |
| `runtime/backend.json` | Pinned version, release origin and source commit |
| `launch/bundled-runtime.mjs` | Extracts on first use, checks the release and required resources, then reuses the cache |
| `launch/mcp-launch.mjs` | stdio launcher, defaults to `--local`, reserves stdout for MCP data |
| `skills/gxworks-mcp-router/` | Verbatim upstream skill matching the backend source |
| `cordis.patch.yml` | MCP connection, skill source and installation check |

The backend comes from the published
[GXWorks Agent 0.4.0 release](https://github.com/Arienax/gxworks-agent/releases/tag/v0.4.0-20261104).
See [runtime/README.md](runtime/README.md) for provenance and licensing.
Default extraction location:

```text
%LOCALAPPDATA%\dsh-gxworks\runtime\v0.4.0-20261104\GXWorks-Agent-MCP
```

Without `LOCALAPPDATA`, the launcher uses `AppData\Local` under the user directory.
The plugin directory can be read-only. Projects, configuration and MCP state use
GXWorks Agent's normal user-data directories, outside the plugin and backend cache.

Enable `gxworks-mcp`, `gxworks-skills` and `dsh-gxworks`. Tools such as
`mcp__gxworks__list_projects` and the `gxworks-mcp-router` skill should appear.
Inspect the launch plan from the plugin directory without starting the backend:

```powershell
node launch/mcp-launch.mjs --print-plan
```

The default `agentRootSource` is `bundled`. A backend recorded with `--set-root`
still takes precedence. Remove its `agentRoot` from
`%USERPROFILE%\.dsh\dsh-gxworks\settings.json` to restore the bundled default.

Tools cover project management, source inspection, generation, offline GXW editing,
Ladder/ST/FBD/SFC, native compilation and diagnostics, and Simulator2 observation.
The connected `tools/list` defines actual tools and arguments. Compilation,
save/reopen, simulation observation and physical PLC behavior are separate results.

## Optional configuration

Normal installations need no backend settings. To use an external backend:

```powershell
node launch/mcp-launch.mjs --set-root "<GXWORKS_AGENT_DIR>"
node launch/mcp-launch.mjs --agent-root "<GXWORKS_AGENT_DIR>" --print-plan
```

`GXWORKS_MCP_EXE` selects an executable directly. Otherwise the root order is
`--agent-root` → `GXWORKS_AGENT_ROOT` / `GXWORKS_AGENT_HOME` → remembered settings →
bundled backend → working directory and parents → `PATH`.
Invalid explicit roots fail; stale remembered roots are skipped.

| Setting | Purpose |
| --- | --- |
| `GXWORKS_MCP_WORKSPACE_DIR` / `--workspace <dir>` | Engineering workspace |
| `--state-dir <dir>` | MCP state directory, outside the workspace |
| `--project <id>` / `--version <id>` | Select a project and version |
| `--service` | Connect to an already running Web workbench |
| `GXWORKS_AGENT_SERVICE_URL` | Web address, default `http://127.0.0.1:8765` |
| `PLC_WEB_AGENT_TOKEN` | Agent token for service mode |
| `--approval-mode ask\|auto\|full` | Explicit external-operation permission; `full` also needs `--confirm-full-access` |

Append other arguments to the array returned by `args` in `cordis.patch.yml`.
Tool calls allow ten minutes. Connection errors are logged without preventing
the rest of Harness from starting.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing bundled backend | Reinstall the complete plugin and check `runtime/`; Python installation is unnecessary |
| Extraction fails | Check user-cache write access, disk space and security-software logs |
| Launch uses an old development path | Check executable/root environment overrides and remembered settings |
| Windows x64 required | Use Windows x64 Harness or explicitly provide a compatible external backend |
| Duplicate `serverName "gxworks"` | Give the other MCP connection a unique server name |
| Native operation cannot find GX Works2 | Install your own GX Works2; Mitsubishi software is not bundled |
| Skill missing | Enable `gxworks-skills` and check the installed skill files |

## Development and packaging

```powershell
npm run check
npm pack --pack-destination "<OUTPUT_DIR>"
npm run check-install -- "<UNPACKED_PACKAGE_DIR>"
npm run sync-skill -- --source "<PUBLIC_GXWORKS_AGENT_CHECKOUT>"
```

`npm pack` refuses to build a plugin missing the actual backend. `check-install`
uses a temporary user directory, hides Python from PATH, removes external backend
settings, starts the installed package from an unrelated directory and checks
first-use extraction, MCP initialization, tool discovery, project creation,
retrieval and generation context. It does not compile in GX Works2 or write a PLC.

The ZIP is an ordinary Git file, so Git installs receive actual content without
Git LFS. Update `runtime/backend.json`, sync the skill from matching public source
and retain all backend licenses when updating. Skill provenance is in
[COPYING.md](skills/gxworks-mcp-router/COPYING.md).

The market index is generated from `market/plugins.txt` with Harness's
`dsh-plugin-market-generator`. After pushing the source, regenerate and
publish `docs/index.json` pinned to that commit. Old `0.1.x` entries do not include
the backend and must not be used to install this fix.

Uninstall with `plugin_manager(action: remove_bundle, target: "dsh-gxworks")`.
Projects, personal settings and Mitsubishi software remain. The backend cache can
be removed manually after its processes stop.

## License

Project-authored source, documentation and configuration use [Apache-2.0](LICENSE).
GXWorks Agent and the routing skill are Apache-2.0; third-party notices remain
inside the backend archive. GX Works2, other Mitsubishi software and vendor manuals
are not distributed by this plugin.
