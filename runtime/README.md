# Bundled GXWorks Agent backend

`GXWorks-Agent-MCP-windows-x64.zip` is built with the upstream release script
from [GXWorks Agent](https://github.com/Arienax/gxworks-agent)'s `fix-rag` branch.
[backend.json](backend.json) records the exact source commit and cache directory identifier.

The archive is committed as a normal Git file so Git-based Harness installs receive
the actual backend without Git LFS or a separate download step. It is also included
in npm tarballs. Do not replace it with a Git LFS pointer or omit it from `files`.

It contains the Python runtime, MCP server, authored runtime facts, engineering
templates, simulator viewer, native helpers, and all upstream license notices.
The archive's `LICENSE`, `NOTICE`, `LICENSE-SCOPE.md`, `THIRD_PARTY_NOTICES.md`, and
`THIRD_PARTY_LICENSES/` remain intact. It contains no GX Works2 installation or
Mitsubishi manuals.

On Windows x64 the launcher extracts it to
`%LOCALAPPDATA%\dsh-gxworks\runtime\<release>\GXWorks-Agent-MCP` on first use.
Later launches reuse that release. Projects and MCP state use GXWorks Agent's
normal data directories and are not stored in this cache or the plugin directory.

To update, obtain the complete MCP ZIP for the selected upstream commit, update
`backend.json`, sync the skill from the matching public source checkout, run
`npm run check`, pack, and run `npm run check-install -- <unpacked-package>`.

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
