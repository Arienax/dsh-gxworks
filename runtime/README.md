<!-- SPDX-License-Identifier: AGPL-3.0 -->

# Bundled GXWorks Agent backend

`GXWorks-Agent-MCP-windows-x64.zip` is built with the upstream release script
from [GXWorks Agent](https://github.com/Arienax/gxworks-agent)'s `v0.4.2-20261117` release.
[backend.json](backend.json) records the exact source commit and cache directory identifier.

The archive is stored as ordered `.zip.partNNN` files, each below GitHub's single-file
limit. Git retains all parts. npm installs them as six exact-version runtime
dependencies listed in `backend.json`; the main plugin package contains no archive
parts. Every dependency uses the user's npm registry, including mainland mirrors
once they have synchronized these packages. The launcher joins the installed parts
locally before extraction. No Git LFS, GitHub download or install script is needed.

It contains the Python runtime, MCP server, authored runtime facts, engineering
templates, simulator viewer, native helpers, and all upstream license notices.
The archive's `LICENSE`, `NOTICE`, `LICENSE-SCOPE.md`, `THIRD_PARTY_NOTICES.md`, and
`THIRD_PARTY_LICENSES/` remain intact. It contains no GX Works2 installation or
Mitsubishi manuals.

The FX5/GX Works3 PWM software extension remains frozen. Its dedicated contract
files are neither bundled nor required for this GX Works2 backend.

On Windows x64 the launcher extracts it to
`%LOCALAPPDATA%\dsh-gxworks\runtime\<release>\GXWorks-Agent-MCP` on first use.
Later launches reuse that release. Projects and MCP state use GXWorks Agent's
normal data directories and are not stored in this cache or the plugin directory.

To update, obtain the complete MCP ZIP for the selected upstream commit, update
`backend.json` and the exact dependencies in `package.json`, and sync the skill
from the matching public source checkout. Run `npm run pack-runtime -- <absolute-output-directory>`
to prepare the six dependency packages outside the repository. Pack and publish
all dependencies before publishing the main plugin. Run `npm run check` and
`npm run check-install -- <installed-package>` with dependencies installed.

## Independent I/O cases

Set `GXWORKS_ACCEPTANCE_CASES_FILE` in the environment of the MCP backend to a local JSON file you control. Use the actual ID returned by `create_project` and the project's CPU. The backend reads the file when a Ladder candidate is submitted. The cases are kept out of the generation request.

```json
{
  "schema_version": 1,
  "project_id": "replace-with-project-id",
  "plc_model": "FX3U",
  "cases": [{"case_id": "lamp", "scan_ms": 10, "steps": [
    {"at_ms": 0, "set": {"X0": 0}, "expect": {"Y0": 0}},
    {"at_ms": 10, "set": {"X0": 1}, "expect": {"Y0": 1}}
  ]}]
}
```

`behavior_result` keeps the first definite mismatch and other distinct output failures observed in the same input sequence. A repair request carries the shared inputs once and includes the affected submitted networks. Confirmed machine-readable behavior conditions can also supply checks. A model-proposed `io_example` has its own `io_example_result`.

The operator's cases share up to 24 seconds of local replay. If the time allowance expires, the result includes the last simulated time reached for that case. Replay uses the specified scan interval. Use Simulator2 to check the delivered project's actual timing.
