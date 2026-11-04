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
