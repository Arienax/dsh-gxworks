# dsh-gxworks

Repository: <https://github.com/Arienax/dsh-gxworks> · Market index: <https://arienax.github.io/dsh-gxworks/index.json>

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that packages the
**MCP server** and **task-routing skill** of [GXWorks Agent](https://github.com/Arienax/gxworks-agent).
Install it once and the agent in the Harness can inspect, generate, edit offline, natively compile, and
simulate Mitsubishi PLC projects.

中文: [README.md](README.md)

## What the bundle does

One patch layer inserts two independent rows:

| Row | Plugin | Effect |
| --- | --- | --- |
| `gxworks-mcp` | `@deepseek-ai/dsh-mcp-client` | Starts the local GXWorks Agent MCP server over stdio; its tools appear as `mcp__gxworks__<rawName>` |
| `gxworks-skills` | `@deepseek-ai/dsh-skill-filesystem` | Registers an isolated skill source (`providerName: gxworks`) that scans only this package's `skills/`, adding `gxworks-mcp-router` |

`launch/mcp-launch.mjs` collapses the Windows install layouts into one command line: it resolves the
installation root (`--agent-root`, then `GXWORKS_AGENT_ROOT`, then a walk up from the working directory),
prefers `GXWorks-Agent-MCP.exe`, then `.venv-mcp`, `.venv`, `py -3`, and `python`, and adds `--local` when
the caller selected no mode. Its stdout carries only MCP protocol data; diagnostics go to stderr.

## Layout

```
dsh-gxworks/
├── package.json            bundle manifest (dsh.bundle.patch, locale/icon exports)
├── cordis.patch.yml        rows: MCP connection + skill source
├── launch/mcp-launch.mjs   stdio launcher (root resolution, mode default, pass-through)
├── skills/
│   └── gxworks-mcp-router/ verbatim upstream skill (SKILL.md + references/)
├── locale/{en,zh}.json     plugin title and description
├── icon.svg                plugin icon
├── scripts/sync-skill.mjs  re-sync the skill from a GXWorks Agent checkout
└── tests/launch.test.mjs   unit tests for the resolution order
```

## Requirements

- Windows for native compilation, GX Works2 UI driving, and Simulator2 sampling; the Python Core paths
  (read, generate, static checks) do not need those installs.
- A local GXWorks Agent: a source checkout with `.venv` and `scripts/mcp_entry.py`, or the standalone MCP
  release package containing `GXWorks-Agent-MCP.exe`.
- A DeepSeek Harness profile (Web or CLI) on Node.js ≥ 22.12.

## Install

First record the local installation root once. The Harness working directory is usually inside the
Harness checkout or another project, not next to GXWorks Agent, so this step is what makes discovery work
across sessions:

```powershell
node launch/mcp-launch.mjs --set-root D:\gxworks-agent
node launch/mcp-launch.mjs --print-plan      # confirm the resolved command
```

The root is written to `%USERPROFILE%\.dsh\dsh-gxworks\settings.json`, and the directory must contain
either `GXWorks-Agent-MCP.exe` or `scripts\mcp_entry.py`. Setting `GXWORKS_AGENT_ROOT`, or working inside
the installation, achieves the same thing.

Then install this directory through the plugin manager in a Harness session:

```
plugin_manager(action: install_bundle, target: "D:\\dsh-gxworks")
```

Or register the package in the profile's `dsh.profile.bundles` so its `cordis.patch.yml` joins the layer
stack. After installation, confirm that the `gxworks-mcp` and `gxworks-skills` rows are active, that
`mcp__gxworks__*` tools are listed (for example `mcp__gxworks__list_projects`), and that
`gxworks-mcp-router` appears in the skill catalog.

## Configuration

| Variable | Meaning |
| --- | --- |
| `GXWORKS_AGENT_ROOT` | Installation root, preferred over the remembered path |
| `GXWORKS_AGENT_HOME` | Same, legacy name |
| `GXWORKS_MCP_EXE` | Direct path to `GXWorks-Agent-MCP.exe`, bypassing root resolution |
| `GXWORKS_MCP_WORKSPACE_DIR` | Engineering workspace for `local` mode |
| `GXWORKS_AGENT_SERVICE_URL` | Local Web origin for `service` mode, default `http://127.0.0.1:8765` |
| `PLC_WEB_AGENT_TOKEN` | Agent token for `service` mode (normally published to Credential Manager) |

Root resolution order: `--agent-root`, then `GXWORKS_AGENT_ROOT` / `GXWORKS_AGENT_HOME`, then the
remembered `settings.json`, then the working directory and its parents, then `GXWorks-Agent-MCP.exe` on
`PATH`. `--print-plan` reports the final command together with `agentRootSource`.

Otherswise, append arguments to the `args` array expression in `cordis.patch.yml`. Common ones:

| Argument | Purpose |
| --- | --- |
| `--local` | Independent engineering runtime that saves versions directly (default) |
| `--service` | Connect to a running Web workbench and produce proposals under its approval policy |
| `--workspace <dir>` | Engineering workspace |
| `--project <id>` / `--version <id>` | Pin the selected project and version |
| `--state-dir <dir>` | State directory for the independent runtime (must live outside the workspace) |
| `--approval-mode ask\|auto\|full` | Operator-granted consent for external actions; `full` also requires `--confirm-full-access` |

Three launcher-only flags, never forwarded to the server: `--set-root <dir>`, `--agent-root <dir>`, and
`--print-plan`.

`toolCallTimeoutMs` is ten minutes because native compilation, cold reopen, and waveform sampling exceed
the 60-second default. `failOnStartupError: false` keeps the Harness bootable on machines without the
Mitsubishi toolchain, and `reconnect` retries a dropped server.

## Tools and skill

MCP tools cover project selection, source discovery and static analysis, generation and offline editing,
FBD/ST/SFC, native engineering and compiled-code analysis, and Simulator2 observation; the connected
`tools/list` is authoritative. The `gxworks-mcp-router` skill records tool selection, key parameters, and
call sequences per task, including how to read receipts across the `local`, `service`, and `context` modes.
It loads only when needed.

Native writes, UI interaction, and PLC run semantics are evidenced separately: a successful compile does
not prove runtime behaviour, and a saved version in `local` mode does not mean a workbench review happened.

## Verify and troubleshoot

```powershell
node launch/mcp-launch.mjs --set-root D:\gxworks-agent
node launch/mcp-launch.mjs --print-plan
.venv\Scripts\python.exe scripts\mcp_entry.py --local --check   # in the GXWorks Agent directory
```

Typical failures: an unresolved installation root (run `--set-root` or set `GXWORKS_AGENT_ROOT`), a
missing Python runtime (create `.venv` and `pip install -r requirements/mcp.txt`), a duplicate
`serverName: gxworks` row in the profile, tool-call timeouts on slow native operations, or a missing
`skills/gxworks-mcp-router/SKILL.md` under the installed package.

## Uninstall

```
plugin_manager(action: remove_bundle, target: "dsh-gxworks")
```

Uninstalling only removes the Harness-side connection and skill; GXWorks Agent projects, state
directories, and the GX Works2 installation are untouched.

## Plugin market

This repository also serves a self-hosted plugin market index through GitHub Pages:

```
https://arienax.github.io/dsh-gxworks/index.json
```

In the Harness, open **Plugins**, switch on **Custom plugin markets** under the experimental plugins, then add
that URL as an index source in **Discover** to find and install `dsh-gxworks`. The index only describes this
repository, installation still goes through `plugin_manager` with your confirmation, and every version pins
an exact Git commit; DSH compatibility comes from `engines.dsh` (`>=0.2.0-0 <0.3.0` today).

The index is generated: `market/plugins.txt` lists the sources and `docs/index.json` is written by the
generator that ships with DSH and checked by its validator.

```powershell
cd D:\dsh\deepseek-harness
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start `
  --input D:\dsh-gxworks\market\plugins.txt `
  --output D:\dsh-gxworks\docs\index.json `
  --title "GXWorks Agent Plugins" `
  --description "GXWorks Agent MCP server and PLC task-routing skill for DeepSeek Harness."
```

The release order is: bump `version` in `package.json`, commit and push, regenerate the index, then commit
`docs/index.json`. The generator reads pushed commits only.

## Development

```powershell
npm test          # launcher resolution order
npm run check     # syntax check plus tests
npm run sync-skill -- --source D:\gxworks-agent
```

`skills/gxworks-mcp-router/` is a verbatim copy produced by `scripts/sync-skill.mjs`, which also records
provenance. The upstream skill remains the single source of truth.

## License and provenance

Project-authored source, documentation, and configuration are [Apache License 2.0](LICENSE).
`skills/gxworks-mcp-router/` comes from `Arienax/gxworks-agent` (Apache-2.0); the version and synchronised
commit are recorded in [COPYING.md](skills/gxworks-mcp-router/COPYING.md).

This bundle redistributes no GX Works2 or Mitsubishi Electric software, manuals, or trademarks; native
features rely on the user's own licensed installation.
