---
name: sync
description: Mirror Azure DevOps work items into the workspace spec folder and keep the spec index current — an epic or feature with everything under it, one item with its parents and links, everything already synced, or every item in every configured ADO project (all states). Deterministic script, no tokens. Invoked by the sdd skill for `/sdd sync <id>`, `/sdd sync` and `/sdd sync all`, and by the sdd:spec and sdd:bug flows before they read a spec.
---

# sdd:sync — ADO → spec folder, by script

One script does all of it:

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py sync --id <id>   # a scope
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py sync             # refresh what is synced
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py sync --all       # every project in sdd.json
```

## Decision briefs — links before every question (mandatory)

Before any question to the user, run `env.py refs --id <id> --ref <ref> ...` (or the waiting
checkpoint, which requires `--ref`), paste its "Links" block directly above the question, with no gap, send the files it
lists with `SendUserFile` (`display: "render"`) when that tool exists, and quote any code lines
marked "not pushed". Full rule: "Decision briefs" in `${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`. No links, no question.

For this skill: before the first big sync, `env.py refs --id <scope root> --ref ado`.

## What each form pulls

| Form | Pulls |
| --- | --- |
| `--id <epic or feature>` | The item, **everything under it** (recursive), its parents up to the top, and 1 hop of links out of that tree |
| `--id <story, bug, ...>` | Same rule — the item, its children, its parents, 1 hop of links |
| no id | Every item already synced, plus every earlier scope root again (so new children added in ADO come in) |
| `--all` | Every item of a `specTypes` type in every project in `ado.projects`, **all states** including Closed and Removed |

The scope root is remembered, so a plain `sync` later refreshes it. Only the types in
`specTypes` (in `.claude/sdd.json`) are mirrored; Tasks are not.

## What it writes

- `{specRoot}/{ancestor folders}/{id}-{TYPE}-{slug}/requirements.md` (TYPE: EPIC, FEAT, US, TS, CR, PBI, BUG, ISSUE) — frontmatter (id, type, project,
  state, parent, fields_hash, links), then title, ADO link, metadata table, Description,
  Acceptance criteria, Repro steps (HTML converted by pandoc) and the link list.
- `{specRoot}/.index/spec.db` — SQLite: items, links, key terms, full-text index, embeddings,
  scopes. Rebuilt per item only when the item changed.
- `{specRoot}/.index/metrics.json` — every synced work item with what a decision needs (state,
  board column, assignee, planning fields, versions, its epic/feature chain, child counts, what
  blocks it and what it blocks, its last change), and **what this sync changed**: `changes`, each
  with the fields before and after (`diff`) and, for a new or MATERIAL item, what it likely affects
  (`affects`: links two hops out, the strongest shared-term matches). No model, no tokens.
  `spec.py metrics` rebuilds it from the index without a sync. Fields in `references/metrics.md`.
- Nothing else. `design.md`, `tasks.md`, `questions.md` and `impact.*` are never touched. A folder
  keeps its slug when the title changes, is renamed when the type changes, and moves (with those
  files) when the item is reparented. An old `{id}-{slug}` folder gets its type code on the next sync.

Removed items are kept and flagged `[REMOVED]`. An item ADO no longer returns is flagged
`MISSING` — deleted, moved to a project not in the list, or no access.

## Before you run it

- **First `--all` in a workspace, or the first sync of a large epic: tell the user what it will
  write and where, and get a yes.** It creates many folders under `{specRoot}`.
- **Meaning search needs Ollama with the embeddings model.** If the sync prints `model ... not
  pulled`, ask the user before running `ollama pull nomic-embed-text` (a download of about
  274 MB). If it prints `Ollama is not running`, say so; everything except meaning search still
  works, and `spec.py embed` fills the gap later.
- `could not get an ADO token` → ask the user to run `az login`.

## Reading the result

The script prints counts, then one line per problem:

| Line | Means | Do |
| --- | --- | --- |
| `new` | First time synced | Nothing |
| `incidental` | Rev changed, material fields did not (state, tags, iteration, comments) | Nothing |
| `MATERIAL <id> ...: <fields>` | Title, Description, AcceptanceCriteria, ReproSteps, type or links changed | Tell the user. If a flow is in progress on this item or its parent, stop and review `design.md` / `tasks.md` against the new text before going on |
| `MISSING <id>` | ADO no longer returns it | Tell the user; a human decides |
| `moved N folders` | Items reparented in ADO | Nothing; files moved with them |

Report the counts and every MATERIAL / MISSING line to the user in plain words. For what changed
beyond the requirement text — a state, a board column, an assignee, a priority — read `changes` in
`metrics.json`: each incidental change there names the fields and their old and new values. A
change worth a closer look (a MATERIAL item under an epic someone works on, a new item that names
another): offer `/sdd impact <id>`, which judges the `affects` candidates. Never run it unasked on
every change — it costs tokens. Never edit a
`requirements.md` to fix something — fix the work item in ADO and sync again.

## Querying afterwards

`spec.py query links|overlap|term|search|similar|show` — see the docstring at the top of
`spec.py`. `sdd:impact` uses these for you.
