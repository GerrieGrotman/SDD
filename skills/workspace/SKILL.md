---
name: workspace
description: Shared scripts behind the /sdd workflows — create a work item's isolated environment (one folder holding a git worktree per repo plus a graphify code graph), rebuild its graph, show its status, push and open its pull requests, and tear it down once the PRs merge. Called by sdd, sdd:bug, sdd:spec, sdd:sync and sdd:impact; not started on its own. Use only when one of those skills sends you here, or when the user explicitly asks for an sdd environment command ("sdd env status 4471", "tear down the 4471 worktrees").
---

# sdd:workspace — the scripts every sdd flow shares

All scripts are Python 3, in `scripts/` next to this file. They find the workspace by walking up
from the current directory to the first folder that holds `.claude/sdd.json`, so they run from
anywhere inside it, including from inside a worktree. Run them with the Bash or PowerShell tool:

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/env.py  <command> ...
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py <command> ...
```

ADO access uses the `az` login (`az account get-access-token`), never a PAT. If a script says
`could not get an ADO token`, ask the user to run `az login`. Scripts never need the ADO MCP.

## Layout they produce

```
<workspace>/.claude/worktrees/{id}-{slug}/     one folder per work item
    workitem.json    id, type, title; per repo: source, ADO project/repo, base branch, dev branch, PR;
                     progress + history (where the flow stands, for resuming in another session)
    CLAUDE.md        generated; says "work only here" and lists the paths
    src/{Repo}/      a git worktree per repo, with a copy of that repo's CLAUDE.md
    graph/           graphify code graph of src/ (graph.json, GRAPH_REPORT.md, graph.html)

<workspace>/{specRoot}/**/{id}-{TYPE}-{slug}/  ADO mirror, see sdd:sync (TYPE: EPIC, FEAT, US, TS, CR, PBI, BUG, ISSUE, AIR)
    requirements.md  written by the sync, never by hand
    design.md, tasks.md, questions.md, impact.json, impact.md   yours; the sync never touches them
    request.md, request.json, route.json   an Ai Agent Request's hand-over and where it was routed
<workspace>/{specRoot}/.index/spec.db          the spec index
```

**All investigation, edits, builds, tests and commits for a work item happen inside its
`src/{Repo}/` worktrees.** Never edit or `git checkout` in the main checkout.

## First use in a workspace — `init`

Prefer `/sdd init` — it runs `doctor` and walks every missing requirement, this included. By hand:
no `.claude/sdd.json` yet? Show the user this, get a yes, then run it from the workspace root:

```
python .../env.py init --spec-root <folder>      # default docs/spec
```

It discovers the repos (`.gitmodules` plus any child or grandchild folder with a `.git`) and
reads the ADO org and projects from each `origin` remote. Show the user the file it wrote, and
ask them to remove any ADO project that holds no specs (a tooling repo's project, for example).
Other keys: `worktreeRoot` (default `.claude/worktrees`), `repoDirs` (explicit repo list,
overrides discovery), `specTypes`, `branchTemplate`, `embeddings`, `agents`, `agentRequest`
(the Ai Agent Request types, and the type created per flow: `{"bug": "Bug", "spec": "Tech Story"}`),
`bugs` (the bug manager, `/sdd-bugs`: see below).

`agents.models` sets the model each sdd sub-agent runs on — `sonnet`, `opus` or `haiku`:

```json
"agents": { "models": { "investigator": "sonnet", "skeptic": "opus" } }
```

A workspace that lacks these keys gets the defaults above written into its `sdd.json` at the next
session start after a plugin update (`env.py upgrade-config`, run by the plugin's SessionStart hook).
A value already there is never changed. `env.py doctor` warns on a value the Agent tool would not
take.

## env.py commands

| Command | Does | Notes |
| --- | --- | --- |
| `doctor [--json]` | Checks Python, SQLite FTS5, git, az + login, graphify, pandoc, Ollama + model, `sdd.json`, repos, ADO projects, worktree ignore, agent models, the output style, the CLAUDE.md block | Read-only. `/sdd init` acts on it |
| `upgrade-config` | Installs the ELI5 output style globally (the style file, and `outputStyle` in `~/.claude/settings.json`, once), then writes the defaults of new settings (`agents.models`) missing from `sdd.json` into it | Run by the SessionStart hook. Never changes a set value, never writes a settings file that is not valid JSON; prints only what changed |
| `run --id N --gate G --expect pass\|fail [--repo R] [--repeat N] [--suite] -- CMD` | Runs a test command in the worktree and records the exit code, output and a fingerprint of the code | The proof `Red test` and `Verified` need (flows.json `proofs`) |
| `revert-check --id N --fix F [--fix F] -- CMD` | Puts the fix files back to the base branch: the test must fail; restores them: it must pass | Restores the files byte for byte in every case |
| `verify --id N` | Runs every backticked Verify command in `tasks.md`, in its repo | The proof `Ready to PR` needs; a failure blocks the PR |
| `type --id N` | Prints type, title, state, project and `flow` (`bug` for Bug/Issue, `request` for an Ai Agent Request, else `spec`) | Read-only |
| `new --id N --repos A,B --version 1.1.0` | Creates the folder, fetches each repo, adds `src/{Repo}` on a new branch from `origin/team/{version}`, writes `workitem.json` and `CLAUDE.md`, builds the graph | Run it again with another `--repos` to **add** a repo later — existing repos are skipped |
| `new ... --base Repo=main` | Per-repo base branch, repeatable. Overrides `--version` for that repo | For repos without `team/*` branches |
| `new ... --branch <name>` | Overrides the branch name | Default is `branchTemplate`: `dev/{developer}/{version}/{type}/{id}-{slug}` |
| `new ... --no-graph` | Skips the graph | |
| `status --id N [--json]` | Verdict, live ADO state, recorded progress and history, spec files and tasks done, per-repo branch/ahead/dirty, live PR status and votes | Read-only. Works before start and after cleanup (record in `.done/`) |
| `progress --id N --flow bug\|spec --phase P --status S [--gate G] [--next X] [--note T] [--ref R] [--caveat T] [--passed G] [--revoke G]` | Checkpoints the flow in `workitem.json` (last 50 kept) and records or revokes gates | Creates the folder if missing. `S`: active, waiting, blocked, done, abandoned. **`waiting` requires `--ref`** and prints the links |
| `graph --id N` | Rebuilds `graph/` from `src/` | AST only, no LLM, seconds. Run after edits |
| `pr --id N --title T --description-file F` | For each repo with commits ahead and a clean tree: `git push -u origin <branch>`, opens the PR against its base, links the work items, records the PR in `workitem.json` | `--repos A` limits it, `--work-items 1,2` links more items (default `--id`), `--draft`. Refuses a description over 4,000 chars. Re-running is safe: repos with a PR are skipped, and an already-open PR is picked up |
| `refs --id N --ref <file[:line[-end]]\|ado> ...` | The "Links" block for a question to the user: ADO item, `requirements.md`, each ref (ADO web link for code on a pushed branch), and the files to send | Errors on a ref that does not exist |
| `can --id N --op start\|resume\|phase\|pr\|done\|abandon [--flow F --phase P] [--json]` | Is the operation allowed in the item's current state? Exit 0 yes, 3 no, with reasons and notes | Read-only. The single source of truth for state guards — `pr` and `remove` enforce it themselves |
| `remove --id N` | **Dry run.** Lists what it would remove | |
| `remove --id N --yes` | Removes each worktree, prunes, deletes the local branch, deletes the folder | Refuses unless `can --op done` allows it: clean, every PR merged, ADO item in `doneStates` |
| `remove --id N --abandon --yes` | Same, but without the merged-PR check | Leaves pushed remote branches and open PRs alone and says so — deleting those is the user's call |

Version resolution is case-insensitive (`HealthCodeIndex_V2` uses `Team/1.1.0`). When a
`team/{version}` does not exist the script stops and lists the team branches and the default
branch it did find — pass `--base` for that repo.

## Rules the scripts do not enforce — you do

- **Show the user `remove` without `--yes` first**, then run it with `--yes` only after they agree.
- **Never pass `--abandon` unless the user said abandon** (or similar).
- **PR text:** never write a work item as `#12345` in a description or comment — ADO turns it
  into a mention comment on that item. Write `ADO 12345`. `AB#12345` is fine in titles and commits.
- **Attribution in commits and PRs follows the calling skill and the user's instructions.** The
  script adds none.
- **A UI worktree needs `npm install`** before it builds; the script says so when it sees
  `package.json`.
- **Ports are machine-wide.** Two work items cannot run the same service at once.
- Report every PR as a clickable link; `pr` prints the full URL.

## Querying the code graph

```
graphify query "<question>" --graph <folder>/graph/graph.json
graphify explain "<node>"    --graph <folder>/graph/graph.json
graphify affected "<node>"   --graph <folder>/graph/graph.json   # what depends on it
graphify path "A" "B"        --graph <folder>/graph/graph.json
```

Read `graph/GRAPH_REPORT.md` first for the community overview. The graph is a map, not the
truth: confirm anything it says by reading the file it points at.

## Self-check

`python ${CLAUDE_PLUGIN_ROOT}/scripts/test_sdd.py` runs offline (temp folder, no ADO, no Ollama) and prints `ok`.
Run it after changing a script.

## Hooks — questions carry their links

`${CLAUDE_PLUGIN_ROOT}/hooks/question_guard.py` runs as two hooks that the plugin ships in `hooks/hooks.json`:

- **PreToolUse on `AskUserQuestion`** — blocks the question unless this turn ran `env.py refs` or a
  `--status waiting` checkpoint, or the chat already shows a Links block (the chat text is not always
  in the transcript yet when the hook runs, so the script run is the reliable signal), and blocks any question whose
  text or options contain a link: links go in the chat directly above the question (no gap), never inside it.
- **Stop** — when a turn ends with a plain-text question, sends the agent back to ask it with
  `AskUserQuestion` and its Links block. It fires once per turn, so it can never loop.

Both stay silent unless an sdd flow is running: this turn ran an sdd script (other than `doctor`,
`init`, `type`), or an earlier turn of this same session ran one (other sessions' work items do not count).
Only a real run counts — `python …/scripts/env.py <command>` as the program. A `grep` or `cat` that names
the script does not. Installing the plugin installs the hooks.
Self-check: `python ${CLAUDE_PLUGIN_ROOT}/hooks/test_question_guard.py`.

## The bug manager (`/sdd-bugs`)

`"bugs"` in `.claude/sdd.json` over `scripts/bugs/defaults.json` (an object one level down is merged key
by key; a list, such as `categories`, replaces the default whole). `folder` and `categories` are
written into the file at the next session after a plugin update, so they are there to tune. The **⚙ Config**
panel of the bug manager edits all of these (and the dev team file) and writes only the keys that differ from the
defaults, so nobody has to open the files.

| Key | What |
| --- | --- |
| `folder` | Where the synced bugs live, under `specRoot` (default `.bugs`) |
| `types` | The work item types it pulls (default `Bug`, `Issue`) |
| `query` | `projects` (empty: `ado.projects`), `excludeStates`, `areaPaths` and `iterationPaths` (UNDER), `where` (a WIQL clause), `top` |
| `developersFile` | The dev team's file, from the workspace root (default `.claude/developers.json`): `{ "areaPath": "A; A\\B\\*", "developers": ["Display Name", ...] }`, or a plain list of developers. The **Dev team** filter shows the items assigned to a developer (name or e-mail, case aside). `areaPath` is a gate on everything shown, with no filter on too: an item outside it is never listed or counted. `A` is that area only, `A\B\*` that area and everything under it. No `areaPath`, no gate |
| `doneStates` | The states **Hide resolved/closed** hides (default `Resolved`, `Closed`, `Done`, `Removed`) |
| `extraFields` | More fields to keep on each item, for a category rule (`fields`) or `eachField` |
| `states`, `severities`, `priorities` | What the triage pickers offer |
| `categories` | `{ id, label, icon, color }` plus a rule. Every key given must hold: `states`, `notStates`, `types`, `boardColumns`, `tags`, `allTags`, `severity` (prefixes: `"1"`), `priority`, `assigned` (`me`, `none`, `anyone`), `areaUnder`, `iterationUnder`, `maxEffort`, `minEffort`, `titleMatches`, `hasPullRequest`, `hasCommits`, `olderThanDays`, `newerThanDays`, `fields`. `any: [rule, ...]`: one of them must hold too. `eachTag: "<regex>"` or `eachField: "<field>"`: one category per value, `{value}` in the label |
| `analysis` | The probable cause's `model` (default `haiku`), `maxTokens`, `effort` |
| `me` | Your ADO e-mail, when `git config user.email` is not it |
| `powershell` | The PowerShell to run the scripts with (default `pwsh`, else `powershell`) |

The scripts are `scripts/bugs/*.ps1`: `Sync-Bugs`, `Get-BugDetail`, `Save-BugChanges`, `Find-BugEvidence`. Each prints one JSON line. They run by hand too, from the workspace:
`pwsh -NoProfile -File <plugin>/scripts/bugs/Sync-Bugs.ps1`.

## The sdd view

In a workspace with `.claude/sdd.json` the view (`/sdd-view`) opens by itself once per session: the one
item in progress, or the list when there are several. `"view": { "autoOpen": false }` turns that off.

### Colours

`/sdd-view` reads its colours from `env.py view`, which takes them from `.claude/sdd.json` over the
defaults in `scripts/sddlib.py`. Set only the ones to change; a value is a CSS colour (`#4f8fd6`).

```json
"view": { "colors": { "now": "#c98a12", "hoverText": "#ffffff" } }
```

Keys: `done` (stage done, gate passed), `now` (waiting on you), `work` (working, the stage log icon),
`revoked` (revoked, blocked), `gate` (a gate at rest), `dim` (quiet text), `line` (borders),
`hoverText` (the text of the line under the pointer; its icon turns a lighter shade of its own colour). The view picks a change up on its next refresh.

