---
'mergeid': patch
---

`deploy-commands` now empties the command scope it is not deploying to whenever `DISCORD_DEV_GUILD_ID` is set, so a stale global set no longer shows up as duplicate entries next to the guild set. A new `--scope=global|guild` flag overrides the scope implied by the environment.
