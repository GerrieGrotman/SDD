---
name: impact
description: Blast-radius analysis of one Azure DevOps work item over the locally synced specs — which other items it affects or is affected by (through links, shared key terms and similar meaning), and what questions that raises about gaps, contradictions or missing links in the spec. A script finds the candidates with no tokens; the agent judges only those. Writes impact.md next to the item's requirements.md. `/sdd impact all [<scope id>]` runs it over the whole synced spec (or one epic/feature) as deduplicated pairs, behind a token-cost warning. Invoked by the sdd skill for `/sdd impact <id>` and `/sdd impact all`, and by the sdd:spec flow before its requirements gate.
---

# sdd:impact — what else does this item touch?

The scan only sees what `sdd:sync` has pulled into `{specRoot}`. That is deliberate: the
sync is what keeps the local specs complete. So every report says which scopes it covered.

## Decision briefs — links before every question (mandatory)

Before any question to the user, run `env.py refs --id <id> --ref <ref> ...` (or the waiting
checkpoint, which requires `--ref`), paste its "Links" block in the chat directly above the question, with no gap (never a link inside the question or its options), send the files it
lists with `SendUserFile` (`display: "render"`) when that tool exists, and quote any code lines
marked "not pushed". Build the `sdd:visual` **impact** page first (`visuals/impact.html`, or
`visuals/impact-all.html`) and pass it as a `--ref`. Full rule: "Decision briefs" in `${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`. No links, no question.

For this skill the refs are the target's `impact.md` (or `impact-all.md`) and the
`requirements.md` of every Direct item the questions name, as paths taken from `impact.json`.

## After a sync — the delta

Every sync writes `{specRoot}/.index/metrics.json`. Its `changes` list is the delta: each new,
MATERIAL, incidental or MISSING item, with the fields before and after, and for new and MATERIAL
items the candidates they likely affect (`affects`, the script half of Step 2 below). Asked "what
does the last sync change?", start there: report the delta from the file (no tokens), then run
this skill's full analysis only on the items the user picks.

## Step 1 — make sure the item is synced and current

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py sync --id <id>
```

Skip this only when the user says the sync was just run. Report any MATERIAL line first.

## Step 2 — find the candidates (script, no tokens)

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py impact --id <id>
```

It writes `impact.json` in the item's spec folder and prints a summary. Candidates come from:

| Signal | From |
| --- | --- |
| `link` | ADO links, both directions, 2 hops (`--hops N` to change) |
| `terms` | Shared key terms — code in backticks, API routes, table names, PascalCase names, error codes — rare terms weigh more |
| `meaning` | Embedding similarity (Ollama). Off if Ollama or the model is missing; say so in the report |

It also lists removed items with signals, and **linked items that are not synced** (outside every
scope).

## Step 3 — judge them (agent)

Read the target's `requirements.md` (and `design.md` if it exists). Then for each candidate, read
its `requirements.md` — the folder is `{specRoot}/<path>` from `impact.json`. Work strongest
signals first; one weak signal alone (a single common term, cosine under about 0.6) is usually
noise — say "no impact" and move on rather than reading deeply.

Class each candidate:

| Class | Means |
| --- | --- |
| **Direct** | Changes or depends on the same behaviour, data, API or screen |
| **Indirect** | Shares a component or entity, but the behaviour does not overlap |
| **None** | The signal was noise |

Then write the **gap questions**. Only questions the specs actually raise, each naming the items
and quoting the words that cause it:

- Two items state acceptance criteria that cannot both be true.
- One item changes an entity, route or table another item relies on, and neither says what
  happens to the other.
- Direct impact but no ADO link between the items — should they be linked?
- A closed item describes today's behaviour and this item changes it without saying so.
- A removed item covered the same ground — was that intent dropped on purpose?
- A linked item is not synced, so it could not be checked — offer `/sdd sync <id>`.

Never invent a requirement to fill a gap. A gap is a question for the item's author.

## Step 4 — write impact.md

In the item's spec folder, next to `impact.json`:

```markdown
# Impact — <id> <title>

Scanned: <scope roots and their synced_at>, <item_count> items. Meaning search: on|off.

## Direct
| Item | Type | State | Why |
## Indirect
| Item | Type | State | Why |
## Gap questions
1. ... (items: A, B)
## Not checked
- <unsynced linked ids>, <removed items>, anything skipped and why
```

Link every item as `[ADO <id>](https://dev.azure.com/<org>/<project>/_workitems/edit/<id>)`
(`org` from `.claude/sdd.json`, `project` from `impact.json`). Keep it short: one line of reason
per row.

## Step 5 — the questions gate

Send the `sdd:visual` **impact** page — the Direct list and the gap questions are on it, not repeated in chat — then ask with `AskUserQuestion`:

- "Keep them local" — `impact.md` only.
- "Post as ADO comments" — one comment on the target item listing the questions. Write
  `ADO <id>`, never `#<id>`, so ADO does not add mention comments. Post only after this choice.
- "Sync more and re-run" — when unsynced linked items matter; run `/sdd sync <id>` for them, then
  start again at Step 2.

Called from `sdd:spec`? Return to its Specify step with the Direct list and the questions; it adds
the open ones to `questions.md` as unticked `- [ ]` lines, so the Open Questions stage counts them.

## Whole spec at once — `/sdd impact all [<scope id>]`

Runs the analysis over every synced item, or every item under one epic, feature or story. The
script finds and **deduplicates** the pairs first (A–B and B–A are one pair, judged once), so
the agent reads each pair once instead of once per side.

### Step A — scan and estimate (script, no tokens)

```
python ${CLAUDE_PLUGIN_ROOT}/scripts/spec.py impact --all [--scope <id>]
```

It writes `impact.json` for every item, and one `impact-all.json` — in `{specRoot}/.index/`, or
in the scope item's folder — holding every candidate pair (strongest first), which are `strong`,
and a token estimate. A pair is **strong** when the items are directly linked, share two or more
kinds of signal, share rare terms (score ≥ 10), or are very close in meaning (cosine ≥ 0.80).

### Step B — ⚠️ the cost warning, then the choice

**Always show this before any agent work, with the numbers from Step A filled in:**

> ⚠️ **Token cost.** This run judges **<pairs> pairs** (<strong> strong) across <items> specs.
> Estimated at **at least ~<all> tokens** for all pairs, or ~<strong-est> for strong pairs only.
> That is a floor: every turn re-sends the growing context, so real use is often **3–5×** higher,
> and a large run can take a long time and outlast one session. One item's `/sdd impact <id>`
> costs a few thousand tokens by comparison. To cut it: run strong pairs only, scope it to one
> epic or feature (`/sdd impact all <id>`), or run `/sdd impact <id>` on the items you care about.

Then ask with `AskUserQuestion`, cheapest first:

- "Strong pairs only (~<strong-est>+ tokens)" — recommended.
- "All pairs (~<all>+ tokens)".
- "Cancel" — the `impact.json` files and `impact-all.json` stay; nothing else runs.

If the estimate is over 1,000,000 tokens, say plainly that a full run is not advisable and
suggest a scope first; still let the user choose.

### Step C — judge in batches

- Work down `pair_list` in its order (strongest first), only the chosen set, **20 pairs a batch**.
  Group a batch so each `requirements.md` is read once where you can.
- Class each pair **Direct / Indirect / None** and write gap questions exactly as in Step 3 above.
  "None" needs no reasoning beyond one line.
- Do not write per-item `impact.md` files in this mode — one combined report costs far less.
- **After every batch, append to `impact-all.md`** (next to `impact-all.json`) and update its
  progress line: `Judged: <n> of <total> pairs (<mode>), in impact-all.json order`. A new session
  resumes from that number instead of starting again — confirm with the user before resuming.

### Step D — the report

`impact-all.md`, kept short and phone-readable:

```markdown
# Impact — whole spec (<scope or "all synced">)

Scanned <date>: <items> items, <pairs> pairs (<strong> strong). Judged: <n> of <total> (<mode>).

## Direct pairs
- [ADO A](link) ↔ [ADO B](link) — one line why

## Gap questions
1. ... (items: A, B)

## Not checked
- pairs not judged (weak, or run stopped), unsynced links, removed items
```

### Step E — the questions gate

Ask with `AskUserQuestion`: "Keep them local" / "Post on selected items". Never post a comment on
every item in one go — list the items with questions and let the user pick (`multiSelect: true`),
then post one comment per picked item, writing `ADO <id>`, never `#<id>`.