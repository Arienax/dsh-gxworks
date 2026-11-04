# Bundled GXWorks Agent backend

`GXWorks-Agent-MCP-windows-x64.zip` is the complete, unmodified MCP asset from
[GXWorks Agent 0.4.0](https://github.com/Arienax/gxworks-agent/releases/tag/v0.4.0-20261104).
The exact release and source commit are recorded in [backend.json](backend.json).

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

To update, download the full MCP ZIP from the selected upstream release, update
`backend.json`, sync the skill from the matching public source checkout, run
`npm run check`, pack, and run `npm run check-install -- <unpacked-package>`.
