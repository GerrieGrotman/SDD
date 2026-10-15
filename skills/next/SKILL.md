---
name: next
description: >-
  Picks the work item to take next under the epic or feature a developer is assigned — invoked by
  the `sdd` skill for `/sdd next <epic or feature id> [version]`. Syncs the scope, lists the items
  tagged with the dev's team version that nobody else is working on, judges from the requirements
  (never ADO's Blocked field) which ones are blocked by another item, estimates complexity where ADO
  has no effort, and ranks them: bugs and issues first, then by a dev priority weighted from
  priority, severity and complexity. The user picks; the chosen item then starts in its flow,
  claim first. Reads only — it writes nothing to ADO.
---

> Plugin root: `${CLAUDE_PLUGIN_ROOT}`. `spec.py` and `env.py` are
> `python ${CLAUDE_PLUGIN_ROOT}/scripts/<name>.py`.

# sdd:next — which item to take next

A developer is assigned an epic or a feature. They may take any item under it that has their team
version and is not someone else's work in progress. This skill finds those items, decides which
are blocked, and ranks the rest. **It never picks for the user, and it writes nothing to ADO**: the
claim is the first step of the flow the user starts with the item they choose.

## The rules (from `.claude/sdd.json` "next", defaults in `scripts/sddlib.py`)

| Rule | What it means |
| --- | --- |
| In scope | A Bug, Issue, User Story, Tech Story, Change Request or PBI anywhere under the epic or feature |
| Version | The item carries the dev's team version as a tag (`1.1.0`) |
| Free to take | Not done (`doneStates`, Removed), not past dev on the board (`pastDev`), and not on someone else's name while `Active` or in `Dev In Progress` (`inProgress`). On someone else's name but not started: free, and the claim takes it over with `--take` |
| Blocked | **Your judgement from the requirements, never ADO's Blocked field.** The script lists the evidence: a predecessor link, or another item named in the text, that is not done |
| Order | Bugs and issues first, then the rest (`types`); within each, the dev priority, highest first |
| Dev priority | 0–100: priority × 50, severity × 30, complexity × 20 (`weights`); complex first (`complexity`). A missing priority or severity counts as the middle |
| Complexity | The ADO effort (story points, effort, size) on a 1–5 scale; with none, your estimate |

## Steps

1. **Scope and version.** The epic or feature id comes with the command. The version too
   (`/sdd next 600 1.1.0`); if it did not, ask with `AskUserQuestion` — the team versions are the
   `team/*` branches of the workspace repos (`git branch -r`), two options at most plus "Other".
   Paste the Links block from `env.py refs --id <scope> --ref ado` directly above the question, with no gap.
2. **The list.** `spec.py next --scope <scope> --version <version>`. It **syncs the scope first**
   (others claim items all day: it never ranks from an old mirror), then prints what is ready, what
   needs a judgement first, what is blocked and what is not available, with why. The sync fails (no
   `az` login, ADO down)? It stops: tell the user, and do not fall back to `--no-sync` unless they
   say to rank from the last sync. For more context on any item — what it blocks, what changed on it
   last, its epic chain — read its entry in `{specRoot}/.index/metrics.json` (the sync just wrote
   it) rather than asking ADO. The sync report's MATERIAL lines matter here too: a requirement that
   just changed is worth a word to the user before they pick it.
3. **Judge what it asks for**, every one, then record it — one sentence that cites what you read:
   - **blocked?** Read the item's `requirements.md` and the `requirements.md` of each item in its
     evidence (resolve them by glob: `{specRoot}/**/<id>-*/`). Blocked means this item **cannot be
     built or tested** until the other lands: it needs code, data, a contract or a decision the
     other one delivers. Sharing a topic, a screen or a file is not blocking; two items touching the
     same code is a merge to plan, not a block. When it turns on the code (does this item change
     what the other one changes?), ask **`sdd:investigator`** with the main checkout's repo path —
     reading is fine there; nothing is edited.
     `spec.py next-judge --scope <scope> --id <id> --blocked yes|no --reason "<why>"`
   - **complexity?** Estimate 1–5 from the requirement and a look at the code it touches:
     1 a line or a setting · 2 one function and its test · 3 several functions in one module ·
     4 several modules, or a contract or data change · 5 several repos, a migration, or real unknowns.
     `spec.py next-judge --scope <scope> --id <id> --complexity <n> --reason "<why>"`
     Never write an estimate back to ADO: it is yours, and the team owns the effort field.

   A judgement holds while its evidence holds: once a blocker is done, or the item's requirement
   changes, the script asks again.
4. **The list again.** `spec.py next --scope <scope> --version <version> --no-sync` — nothing left to
   judge. `--no-sync` here: step 2 synced a moment ago, and your judgements are about that state.
5. **Let the user pick.** In chat: the top five ready items as a short table — id, type, title,
   dev priority, P / S / C, and a note (yours, unassigned, or on someone else's name and not
   started) — then one line on each blocked item and why. Paste the Links block (`env.py refs --id
   <scope> --ref ado`), then ask with `AskUserQuestion`: the top three as options, best first, and
   "None of these". Say in one sentence which you would take and why — usually the first.
6. **Start it.** On a pick, hand over to `/sdd <id>` (the `sdd` skill routes it to its flow). The
   flow's first step is the claim. When the item is on someone else's name and not started, the
   user's pick is the yes the claim needs: tell the flow so, and it claims with `--take`.

## Never

- Trust ADO's Blocked field. Read the requirements and decide.
- Pick for the user, or start a flow nobody chose.
- Write to ADO from this skill — no claim, no effort, no tag. The flow claims; the team owns the rest.
- Take an item someone is working on. `claim` refuses it anyway, `--take` or not.
