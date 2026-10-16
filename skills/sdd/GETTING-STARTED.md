# sdd — getting started

A walk-through from a fresh workspace to your first merged bug fix and your first spec item. Do the
steps in order. Each one says what to type, what happens, and what you decide. Every step that
changes something asks you first.

The workspace is the folder above your repos. Run every command from it.

## Step 1 — Set up: `/sdd init`

Run it once per workspace.

1. Type `/sdd init`.
2. sdd shows a table of checks: Python, Node, git, the Azure CLI login, `.claude/sdd.json`,
   the CLAUDE.md block, and the rest. Each is ok, missing, or missing but optional.
3. For each missing one, sdd shows the fix and asks **Yes** or **Skip**. Required ones come first.
4. Two things to know:
   - `az login` is yours to run. Type `! az login` at the prompt, then let sdd re-check.
   - When `.claude/sdd.json` is missing, sdd asks which folder holds the specs (default
     `docs/spec`) and which ADO projects to keep. Drop any project that holds no specs.

Done when: every required check is ok and `.claude/sdd.json` exists. Restart Claude Code once, so
the ELI5 output style loads.

## Step 2 — Pull the specs: `/sdd sync <epic id>`

Sync copies work items from ADO into your spec folder. It is a script, so it costs no tokens.

1. Pick the epic or feature your team works under. Type `/sdd sync <its id>`.
2. sdd says how many folders it will write, and asks. Say yes.
3. You get one folder per item: `<spec folder>/…/<id>-<TYPE>-<slug>/requirements.md`.
   It mirrors ADO. **Never edit it.** The next sync overwrites it.

Later:
- `/sdd sync` refreshes everything already synced.
- `/sdd sync all` pulls every item in every project in `sdd.json`. Use it rarely.

A spec is wrong? Fix the work item in ADO, then sync again.

## Step 3 — Check the blast radius: `/sdd impact <id>`

Impact finds what else an item touches, so you catch gaps before you write code.

1. Pick a story. Type `/sdd impact <story id>`.
2. A script finds the candidates; Claude judges only those.
3. Open `impact.md` next to the item's `requirements.md`. It lists the items that are affected, and
   the questions that raise: gaps, contradictions, missing links.
4. Decide what to do with each question. Ask the author in ADO, or note it and go on.

`/sdd impact all` does this for the whole spec. It costs tokens, so it shows an estimate and asks first.

## Step 4 — Your first bug: `/sdd <bug id>`

Use a small Bug or Issue for the first one. sdd reads the type and starts the **bug flow**.

What the flow does, and where it stops for you:

| Stage | What happens | You |
| --- | --- | --- |
| 1 Load and claim | Mirrors the bug, assigns it to you, asks which team version to base on | Pick the version |
| 2 Branch and worktree | Makes the work item folder, with a git worktree per repo and a code graph | Nothing |
| 3–5 Validate, reproduce, root cause | Checks the bug against its story, reproduces it, traces the real cause | Answer questions |
| **6 Approval** | Shows a written problem / cause / fix summary | **Approve, or send it back.** No code changes before this |
| 7–10 Red test, fix, verify, push | Writes a failing test, fixes it, proves red to green, pushes | Nothing |
| **11 Manual verification** | Asks you to check the fix yourself | **Say it works** (or choose to skip) |
| 12–14 PR and write-back | Raises the PR. Writes root cause and resolution back to ADO | Nothing |
| **15 PR review** | Waits for the review | **Say `approved`, `merged` or `rejected: <why>`** |

All edits happen in `.claude/worktrees/<id>-<slug>/src/<Repo>/`, never in your main checkout.
After the PR merges, run `/sdd done <id>` to clean up.

## Step 5 — Your first spec item: `/sdd <story id>`

Use a story or tech story. sdd starts the **spec flow**.

First it asks for the **path**: **full** or **short**. Short merges the design and tasks stops into
one. You can say it up front: `/sdd <id> short` or `/sdd <id> full`. For a first run, pick `full`.

| Stage | What happens | You |
| --- | --- | --- |
| Specify | Claims the item, mirrors it, runs impact | Pick the path |
| Open Questions | Asks the questions raised in `questions.md`, one by one | Answer, or say "Continue with this open" |
| **Requirements** | Shows the requirements as understood | **Approve** |
| **Design** | Writes `design.md` after reading the real code (skipped on the short path) | **Approve** |
| **Decompose** | Writes `tasks.md`, and may propose tech stories | **Approve** |
| Implement | One task at a time, each with its tests | Nothing |
| **Verify** | Checks drift from the spec and overlap with other work | **Approve** |
| **Review** | Raises the PR and waits | **Say `approved`, `merged` or `rejected: <why>`** |

`requirements.md` is the ADO mirror. `design.md` and `tasks.md` are yours; sync never touches them.

## While you work

- **See where it stands:** `/sdd status <id>`, or the sdd view in the Claude Desktop app.
- **Come back later:** `/sdd <id>` offers to resume where it stopped, even from a new chat.
- **Send it back:** `/sdd <id> feedback <stage>: <text>` returns to that stage. Its gates and later ones are revoked.
- **Stop:** say **abandon** at any time. sdd cleans up what it created, and asks before anything outward-facing.
- **Pick the next item:** `/sdd next <epic or feature id> <version>` ranks what is free to take.

## When it goes wrong

- A command refuses and says why: the item is not in the right state. Read the reason; it names the fix.
- `az` errors: run `! az login` again.
- The spec looks stale: fix it in ADO, then `/sdd sync <id>`.
- Lost: `/sdd help` shows every command. `/sdd status <id>` shows where an item is.
