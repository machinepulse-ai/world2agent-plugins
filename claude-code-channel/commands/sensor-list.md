---
description: List currently enabled World2Agent sensors
---

Read `~/.world2agent/config.json` and show each sensor as a table:

| package | key config | status |
|---|---|---|

If the file doesn't exist or `sensors` is empty, tell the user: "No sensors installed yet. Use `/world2agent:sensor-add <full-package-name>` to add one, where `<full-package-name>` is the full npm package name, e.g. `@world2agent/sensor-hackernews`."
