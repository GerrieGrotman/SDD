# Phase 6 — Approval gate  🛑 **STOP HERE**

> Part of the `sdd:bug` flow. Its rules (`../SKILL.md`) and the shared flow rules
> (`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`) hold here too. Paths like
> `references/…` are in the bug skill's folder.

The branch and work item folder already exist — Phase 2 created them so Phases 3–5 could investigate against
the right code. What is still missing is permission to touch anything in that worktree.

Build the `sdd:visual` **bug** page (`visuals/bug.html`) from the summary below, pass it as a
`--ref` on the waiting checkpoint and send it. The summary below goes **on the page, not in chat** —
the chat gets one line naming the page, then the Links block, then — directly after it, with no gap — ask with `AskUserQuestion` — "Approve — write the failing test" / "Needs changes" — and **wait for that explicit approval**. Do not edit a file or write a test
until the user says go. If they ask for changes, revise and re-present.

Write each line in the house style — one idea per sentence, active voice, small words. One or two
sentences per heading is enough. The user is deciding "yes or no", not reading a report.

```markdown
## ADO {id} ({Bug|Issue}) — {title}

**Reported symptom** — what the reporter saw, in their terms.
**Requirement basis** — linked story/CR (`ADO {id} — title`) and the Gate 1 verdict. State "no linked
  requirement" explicitly when there is none.
**Reproduction** — how, and on what. Say **observed** or **not reproduced — cause inferred**.
**Root cause** — the mechanism, anchored to `path/to/File.cs:123`.
**Evidence** — what proves it (failing assertion, log line, query result, blame).
**Ruled out** — alternatives considered and why each is not it.
**Blast radius** — repos/services affected; other call sites with the same flaw.
**Proposed fix** — what changes and where. Note anything deliberately *not* changed.
**Regression test** — what will be asserted, in which test project, and what it would have done
  before the fix.
**Branch** — `dev/{dev}/{version}/bug/{id}-{slug}` → PR target `team/{version}` — already created
  in the work item folder at Phase 2.
**Out of scope** — related defects and requirement gaps found but not fixed here (each needs its
  own work item).
```

Where Gate 1 returned **Unspecified**, state the behaviour you intend to implement and get it agreed
here; that is a product call, and this is the moment to make it explicit rather than bury it in a
diff.
