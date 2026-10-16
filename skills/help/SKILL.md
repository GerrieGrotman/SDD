---
name: help
description: 'The sdd help page: a first-time walk-through (init, sync, impact, a first bug, a first spec item) and every command, in one page. `/sdd:help` does exactly what `/sdd:sdd` with no arguments and `/sdd help` do. Use when the user types /sdd:help or asks how to get started with sdd or which sdd commands exist.'
---

# /sdd:help — the sdd help page

This is the same as `/sdd:sdd` with no arguments and `/sdd help`. The steps are in the `sdd` skill, section
"`/sdd:sdd`, `/sdd:help` and `/sdd help` — the help page": `${CLAUDE_PLUGIN_ROOT}/skills/sdd/SKILL.md`. Read that section and
follow it. Change nothing and run nothing else.

In short:

1. Run `python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py help`. It copies the page into
   `<workspace>/.claude/sdd/help/` and prints the path. The plugin folder is a cache the Desktop app
   cannot open files from, so never send or link the page from there.
2. Send the copy with `SendUserFile` (`display: "render"`, `status: "normal"`) when that tool exists.
   Otherwise give its link and a one-line outline.
