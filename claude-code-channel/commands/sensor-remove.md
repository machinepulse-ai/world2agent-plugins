---
description: Remove a World2Agent sensor
---

Remove sensor `$ARGUMENTS`. `$ARGUMENTS` MUST be a complete npm package name (e.g. `@world2agent/sensor-hackernews`) — **never guess, never auto-prepend a scope**.

If the user gives only a short name, first run `/world2agent:sensor-list` to look up the exact `package` field in `~/.world2agent/config.json`, then proceed.

Steps:

1. Remove the entry with `package === "$ARGUMENTS"` from the `sensors` array in `~/.world2agent/config.json`.
2. Uninstall the npm package:
   ```bash
   npm uninstall $ARGUMENTS --prefix "${CLAUDE_PLUGIN_ROOT}"
   ```
3. Derive `skill_id = packageToSkillId($ARGUMENTS)` (e.g. `@world2agent/sensor-hackernews` → `world2agent-sensor-hackernews`), and ask the user whether to also delete the handler skill at `.claude/skills/<skill_id>/` (if present).
4. Prompt the user to run `/reload-plugins` or restart Claude Code.
