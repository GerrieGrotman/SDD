# sdd — quick guide

Spec-driven work on Azure DevOps items. One folder per work item. Scripts do the mechanics; you
make the decisions.

## The steps

**1. Set up once**
- `/sdd init` — checks tools, config and CLAUDE.md. Asks before each fix.

**2. Pull the specs**
- `/sdd sync <epic id>` — the epic and everything under it.
- `/sdd sync` — refresh everything already synced.
- `/sdd sync all` — every item in every ADO project in `.claude/sdd.json`.

**3. Check the blast radius**
- `/sdd impact <id>` — what else the item touches, and the gap questions that raises.
- `/sdd impact all` — the same for the whole spec (`/sdd impact all <epic id>` for one epic). ⚠️ Costly: it shows a token estimate and asks first.

**4. Do the work**
- `/sdd next <epic or feature id> <version>` — what to take next: the free items with your team version, blocked ones set aside, ranked (bugs and issues first, then by priority, severity and complexity). You pick.
- `/sdd <id>` — Bug or Issue → bug flow. Story, feature or epic → spec flow.
- `/sdd <id>` on an **Ai Agent Request** (a hand-over from another AI agent) — a report on what it says is done and left, and the items it names. You pick spec or bug. The work goes to the open item it belongs to, or to a new Tech Story or Bug. Then that flow runs.
- `/sdd bug <id>` — force the bug flow.
- `/sdd spec <id>` — force the spec flow.
- `/sdd <id> short` — a small spec item: one stop approves the design and the tasks together. `full` keeps every stop. Say neither and the flow asks.

**5. Check on it**
- `/sdd status <id>` — where it stands: ADO state, the step the flow reached, tasks done, PRs.
- Started in another chat? `/sdd <id>` offers to resume where it stopped.

**6. Finish or stop**
- `/sdd done <id>` — after the PRs merge and the work item is closed out. Shows what goes, then asks.
- `/sdd abandon <id>` — stop an item and clean up what it created. Asks before anything outward-facing.
- Both refuse, and say why, when the item is not in the right state.

**Harness**
- `/sdd harness audit` — is the Claude Code setup (CLAUDE.md, allowlists, hooks) complete and current? Reports, changes nothing.
- `/sdd harness create` / `onboard` / `maintain` — set up a repo or workspace, add a new repo to it, or fix drift.

**Help**
- `/sdd help` — this page.
- `/sdd help start` — a page that walks a new user through init, sync, impact, a first bug and a first spec item.

**Update sdd**
Get the newest version from a chat. Type each line with a `!` in front, so it runs as a shell command:
1. `!claude plugin marketplace update sdd` — pulls the newest marketplace list.
2. `!claude plugin update sdd@sdd` — updates the plugin.
3. Run `/reload-plugins`, or start a new chat, so the new version loads.

## Where things live

Work item folder: `.claude/worktrees/<id>-<slug>/`
- `src/<Repo>/` — your code. Every edit, build, test and commit happens here.
- `graph/` — code graph of `src/`. Start with `GRAPH_REPORT.md`.
- `workitem.json` — which repo is on which branch, its PR, and where the flow stopped.

Spec folder: `specRoot` in `.claude/sdd.json`, then `**/<id>-<TYPE>-<slug>/` (TYPE: EPIC, FEAT, US, TS, CR, PBI, BUG, ISSUE)
- `requirements.md` — mirror of ADO. Never edit it; the sync overwrites it.
- `questions.md` — open questions for the item's author, one `- [ ]` line each. While any is open, the flow stops at **Open Questions** and asks them one by one; you can answer "Continue with this open" to go on anyway.
- `design.md`, `tasks.md`, `impact.md` — yours. The sync never touches them.
- `.index/spec.db` (at the spec folder root) — search index.

## Rules

- The flow stops for your approval before code changes, before a PR, and before cleanup.
- Every question comes as a pick-list, with links to the spec documents and code it is about.
- Say **abandon** at any point to stop and clean up.
- Specs change in ADO, not in the files: fix the work item, then `/sdd sync`.
- Never edit in the main checkout. Only in `src/<Repo>/`.

## A typical first session

The full walk-through is `/sdd help start`. In short:

1. `/sdd init` — say yes to the fixes you want.
2. `/sdd sync <your epic id>` — confirm when it says how many folders it writes.
3. `/sdd impact <a story id>` — read `impact.md`, decide what to do with the questions.
4. `/sdd <that story id>` — the flow claims the item and walks you through it.
