# sdd — spec-driven development for Claude Code

One Claude Code plugin for working Azure DevOps work items end to end: the spec flow (stories, tech
stories, change requests, features, epics) and the bug flow (bugs, issues), each with approval gates,
a git worktree per work item, an ADO spec mirror, impact analysis and visual pages. A side pane, the
**sdd view**, shows where the work item stands and what was decided at each stage, and why.

## Install

```
/plugin marketplace add ruadrauflessa/SDD
/plugin install sdd@sdd
```

Then, in each workspace (the folder above your repos), run `/sdd init` once. It checks Python 3, Node,
git, the Azure CLI login and the rest, and writes `.claude/sdd.json`.

The plugin also installs the **ELI5** output style (plain, short replies in ASD-STE100 Simplified
Technical English) as your global style: `~/.claude/output-styles/ELI5.md`, and `"outputStyle": "ELI5"`
in `~/.claude/settings.json`. It does this at the first session after the plugin is installed or
updated, and on `/sdd init`. Restart Claude Code to see it. It sets the style once: pick another in
`/config` and the plugin leaves your choice alone (`/sdd init` sets it again). A style file you edit
is kept; an unedited one is updated with the plugin.

Needs: Python 3.9+, Node 18+, git, the Azure CLI (`az login`). Optional: graphify (code graphs),
pandoc, Ollama (meaning search).

**Moving from the loose skills** (`~/.claude/skills/sdd*`): remove those folders and the two
`question_guard.py` entries from `~/.claude/settings.json`, or every question is checked twice.
`/sdd init` warns while the old entries are there.

## Use

| You type | What happens |
| --- | --- |
| `/sdd next <epic or feature id> [version]` | Syncs the epic or feature from ADO, then ranks what to take next under it: items with your version that nobody is working on, blocked ones judged from the requirements, bugs and issues first, then a dev priority from priority, severity and complexity |
| `/sdd <id>` | Starts or resumes the work item, in the bug or spec flow by its type |
| `/sdd <id>` on an Ai Agent Request | Reports on the hand-over (what is done, what is left, the items it names) and asks spec or bug. The work goes to the open item it belongs to, or to a new Tech Story or Bug linked to the request; then that flow runs |
| `/sdd <id> short` / `full` | A spec item on the short path (one stop approves design and tasks together) or the full one; without it, the flow asks |
| `/sdd:help` (or `/sdd:sdd`, `/sdd help`) | One help page: a first-time walk-through (init, sync, impact, a first bug and spec item) and every command |
| `/sdd status <id>` | Where the item stands |
| `/sdd <id> feedback <stage>: <text>` | Back to a done or waiting stage with your feedback |
| `/sdd-view [id]` | Opens the sdd view for this chat's work item (or the one given) |
| `/sdd-bugs [mine]` | The bug manager (Claude Desktop app): triage the bugs and issues of your ADO projects in a pane. See below |
| `/sdd-worktrees` | Lists every work item that still has worktrees, with each worktree's live state (needs the repowatch plugin, which installs with sdd). Read-only. Each work item is a header; each worktree under it is one line (a colour dot, `repo · branch`, a state word, its age). Press a line to open its facts, 📋 copy folder and a **History** button that asks repowatch to draw that branch against its base. Clean-up is in `/repowatch worktrees` |

The sdd view opens by itself the first time a chat takes up a work item. In it:

- the header tags the flow and, for the spec flow, the path: `[Spec flow] [short path]`, or
  `[path not chosen]` while the flow still has to ask (`[Bug flow]` for a bug);
- each stage opens to its **Stage log**, its **gates** (what you were asked, what you answered, what
  was revoked), its documents and a **Give feedback** box;
- the band above the prompt shows the same tag (`[spec · short]`) for as long as the chat's work item
  is in progress, and turns amber when it waits on you;
- the same band is a launcher: **sdd view**, **Worktrees** and **repowatch** buttons are always there (with no item running it reads "Open a panel"), so a panel opens without a command;
- the review stage (spec: Review, bug: Phase 15) has **Approved**, **Merged** and **Rejected**;
- a worktree opens in File Explorer or VS Code from its box. The spanner (🔧) opens it in repowatch, on that one worktree (needs repowatch 0.1.1 or newer; older ones just open their normal pane).
- the pane lists the flow's stages as one vertical rail: a small picture of the node and the rail for each stage, joined
  into one line, and the stage's name as a button. Each row has the same height: name, its state in a word (none for done
  or next: the colour says it), and the cost. A pane wider than about 60 columns adds a cost bar and the last activity.
  Press a stage to open its detail under its own row: latest note, cost split, Stage log, each gate's story, documents,
  Approve and feedback. One stage is open at a time; press the open one to close it. The pane opens on the stage the item
  is at, and follows the item when it moves on;
- the view is for the Claude Desktop app. In a terminal, the VS Code extension or a phone it does nothing;
- a **Work item** dropdown switches the pane to another open item, and after `/sdd ` the prompt box
  offers your open items by id or a word of the title;
- an **Agents** section lists the session's sub-agents and what each one is doing;
- while Claude works, the spinner names the item, its stage and what it works toward, and a system
  notification tells you once when the item waits on you;
- **cost and context**: each turn's cost is recorded against the work item and the stage the turn began in,
  in dollars and in tokens: uncached input, output, cache read and cache write (`env.py cost`, one line in
  `cost.jsonl` in the item's folder; the totals stay in the record after the folder is removed). The header
  shows `Spent $x on this item` and the token split, each stage row its own cost, and an open stage the
  full line (`$1.23 over 4 turns · in 12k · out 3k · cache read 1.2M · cache write 80k`). The context fill
  shows beside it, in the band too from 80 percent. Chats and sessions on the same item add up. A turn is
  charged to the item the chat took up with `/sdd <id>`; a sub-agent's tokens count with the turn that ran it.
  After `/clear`, `/resume` or `/branch` the next turn starts a fresh measurement.

## Bugs and issues (`/sdd-bugs`)

A pane in the Claude Desktop app for triaging bugs and issues; the **Bugs** button on the band opens it too.
It costs no tokens to use: PowerShell scripts (`scripts/bugs/*.ps1`) do the ADO and git work, and the pane
reads the files they write. Only **Find probable cause** calls a model, once, with a short prompt.

- **⚙ Config**, beside Sync, opens the workspace's `.claude/sdd.json` in the app the computer uses for it:
  the categories and the other `bugs` settings are in it.
- **Sync from ADO** (`Sync-Bugs.ps1`) pulls the bugs and issues of your ADO projects into the spec folder:
  `<specRoot>/.bugs/index.json` (the list), `items/<id>.json` (repro steps, description, comments).
- **Categories** sort the list: quick wins, high severity, in progress, ready for deployment, and one per
  team branch version tag (`1.1.0`). They are rules in `.claude/sdd.json` `"bugs.categories"`: change them,
  add your own. Filter by words, type, state, **Assigned to me** (`/sdd-bugs mine` opens that way), **Hide resolved/closed** (every state in `bugs.doneStates`), and **Dev team**: the items assigned to a developer listed in `.claude/developers.json`, or in one of its area paths, e.g. `{ "areaPath": "Proj; Proj\\Team\\*", "developers": ["Ann Bee", "Raj Patel"] }`. Developers are display names, as ADO shows them, or e-mails. `areaPath` is split at `;`: `Proj` is that area only, `Proj\Team\*` is that area and everything under it. Either is enough, so an unassigned item in the team's area shows up for triage. The category chips and the header count what the filters leave: with **Dev team** on, `All 94` and `94 of 173 items` are the team's items, and each chip counts its own items among those.
- **Triage** a row: state, severity, priority, assignee, area path, iteration path, tags, a comment. Each
  change is staged, not sent: the row shows `✎n`, and the yellow box counts what is unsaved. **Save all to
  ADO** (`Save-BugChanges.ps1`) writes the batch; **Save this item** writes one item. **↶** reverts one
  change, **Revert item** one item, **Revert all** the batch (it asks first). Tick rows (☐) to change
  several at once. A save reads each item again first: a field someone else changed since is not
  overwritten; it stays staged with a ⚠ and **Keep mine** if you want yours anyway. Every write is
  rev-tested. A comment may not name `#1234` (ADO posts a mention there): write `ADO 1234`.
- **Links** back to ADO: the item, its pull requests (title and status), its commits, its other links.
- **Probable cause**: **Evidence only** (`Find-BugEvidence.ps1`, no tokens) takes the files, stack frames,
  exceptions and names in the report, looks for them in your repos with `git grep`, and reads the
  history of what it finds and the commits linked to the item. **Find probable cause** sends the report
  and that evidence to `haiku` once (about 1-2k tokens in, 500 out at most) and keeps the answer, with
  its cost, in `items/<id>.analysis.json`.
- **▶ Start sdd in a new chat** (`Start-SddChat.ps1`) opens a new Claude Code session in the Desktop app,
  with `/sdd:sdd <id>` in its prompt box and the workspace as its folder (the app's
  [`claude://code/new` link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link):
  it asks you to confirm the folder, and nothing is sent until you press Enter). `"newChat": {"mode": "terminal"}`
  opens `claude "/sdd:sdd <id>"` in a new terminal window instead. An item already in a flow says
  **Continue sdd** and resumes where it stopped. **In this chat** puts the command in this chat's prompt box.

Needs PowerShell (Windows PowerShell 5.1 or PowerShell 7) and `az login`; a personal access token in
`AZURE_DEVOPS_EXT_PAT` works too.

## Configure (`.claude/sdd.json`)

```json
"view": {
  "autoOpen": true,
  "colors": { "done": "#3f9a63", "now": "#c98a12", "hoverText": "#ffffff" }
}
```

```json
"agents": { "models": { "investigator": "sonnet", "skeptic": "opus" } }
```

```json
"agentRequest": { "types": ["Ai Agent Request"], "create": { "bug": "Bug", "spec": "Tech Story" } }
```

`agentRequest` names the hand-over type(s) `/sdd <id>` triages, and the type it creates for the work
on each flow when no open item takes it.

```json
"bugs": {
  "query": { "excludeStates": ["Closed", "Removed"], "areaPaths": ["Proj\\Payments"] },
  "categories": [
    { "id": "mine-urgent", "label": "My urgent", "icon": "🔥", "assigned": "me", "severity": ["1", "2"] },
    { "id": "version", "label": "Team branch {value}", "icon": "🌿", "eachTag": "^\\d+(\\.\\d+){1,3}$" }
  ],
  "analysis": { "model": "haiku", "maxTokens": 500 },
  "newChat": { "mode": "desktop" }
}
```

`bugs` sets the bug manager: what it pulls, the categories (a list you give replaces the default one),
the probable cause's model, and how a new chat opens. `skills/workspace/SKILL.md` lists every key and
every rule a category takes; `scripts/bugs/defaults.json` holds the defaults.

`agents.models` picks the model of each sub-agent (`sonnet`, `opus` or `haiku`). A workspace without
it gets these defaults written into its `sdd.json` at the first session after the plugin updates;
values already set are kept. `skills/workspace/SKILL.md` lists every key.

## Layout

| Path | What |
| --- | --- |
| `skills/` | `sdd` (entry; `references/flow-rules.md` holds the rules both flows share), `spec` (outline + `modes/`), `bug` (outline + `phases/`), `next` (what to take next), `request` (Ai Agent Request triage), `sync`, `impact`, `harness`, `visual`, `workspace` |
| `agents/` | `investigator` (read-only code search) and `skeptic` (independent review of a root cause, a test or a design), used by the bug and spec flows; models from `agents.models` |
| `scripts/` | `env.py` (work item folders, state guards, progress, config upgrades), `spec.py` (ADO mirror, impact, rev-tested writes: claim, handover, sprint, comment, route; an Ai Agent Request's report), `adowrite.py` (those writes), `proof.py` (recorded test runs that gates need), `nextpick.py` (the next-item rules), `metrics.py` (`.index/metrics.json`: every item's decision facts and what the last sync changed), `flows.json` (the stages of each flow) |
| `hooks/` | `hooks.json`, `question_guard.py` (links before every question), `agent_guard.py` (keeps the sdd agents read-only: no git writes, no `env.py` / `spec.py` runs), `edit_guard.py` (no edits in the main checkout during a flow), `register.tsx` + `view/` (the sdd view) |
| `assets/output-styles/` | `ELI5.md`, the output style the plugin installs globally |
| `types/` | The view's state contract |

## Develop

```
python scripts/test_sdd.py
python hooks/test_question_guard.py
python hooks/test_agent_guard.py
python hooks/test_edit_guard.py
python scripts/test_proof.py
python scripts/test_fakeado.py
python scripts/check_evals.py
claude plugin validate .
claude plugin test .
```

`skills/visual` is a fork of visual-explainer 0.11.0 (MIT, see `skills/visual/LICENSE`).

### Evals

`evals/` holds scenario tests that run the real flows with a model: a bug that contradicts its
change request must stop at Gate 1; the regression test must fail on record before the fix; a spec
item must ask full or short; a spec item started with `short` must record it and go on. Each case
builds its own workspace (`evals/_fixtures/workspace.py`) and talks to an offline ADO
(`scripts/fakeado.py`, switched on by `SDD_FAKE_ADO`), so no ADO login is needed and the graders
can read what the flow wrote.

```
claude plugin eval . --runs 1 --scaffold --no-publish      # one run per case, to try it
claude plugin eval . --scaffold --ablation with-without    # the full suite, with and without the plugin
```

`--scaffold` runs each case's `scaffold.sh`, and the first run asks you to trust this plugin
directory. Each case is a full agent run, so a run costs real tokens: run the suite before a
release, not on every commit. `python scripts/check_evals.py` checks the case files without
running anything.

