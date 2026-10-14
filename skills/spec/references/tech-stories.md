# The tech story gate

Tech stories are the **only upward write** in this workflow, and they are created only when
technical work exists that the product-level items do not already imply:

- a new solution, service or project
- a new endpoint or public contract
- component scaffolding required by an architectural design
- technical debt deliberately taken on
- work that would otherwise have no work item at all — release preparation, dependency bumps,
  build and pipeline fixes (raised directly by a developer, not by this gate)

One other path creates a tech story: the work left in an Ai Agent Request, when the user picks the
spec flow and no open item takes it (`sdd:request`, `spec.py route`). It is not this gate.

This runs at the **end of Design, not during Specify**. What a change creates that didn't exist
before is only visible once the *how* has been worked out.

## Procedure

1. **Enumerate what the design creates.** Walk the design's anchors: new solutions or projects,
   new endpoints, new scaffolding, debt accepted. Existing things being modified don't count.
2. **Search ADO before proposing anything.** "Not already evident in existing user stories,
   issues and bugs" is a coverage query, not a judgment call. WIQL across the parent feature's
   children and its linked bugs, matching on the endpoint, component or solution name:

   ```
   SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State]
   FROM WorkItems
   WHERE [System.TeamProject] = @project
     AND [System.AreaPath] UNDER '<area path from frontmatter scope>'
     AND ([System.Title] CONTAINS '<component name>'
          OR [System.Description] CONTAINS '<component name>')
     AND [System.State] <> 'Removed'
   ```

   Run it once per candidate name. A hit means the work is already covered — link to it in
   `design.md` and drop the candidate.
3. **Write a proposal** for what survives, from `assets/tech-story.md.template`: title,
   rationale, parent link, acceptance criteria drawn from the architectural decision.
4. **A human approves before anything is created.** Present the proposals together as one
   `AskUserQuestion` call — `multiSelect: true`, one option per proposal, each option's
   description holding the title, rationale and parent link so the user can decide from the
   question itself. The agent never opens a work item unprompted, and never asks about proposals
   one at a time. Picking none of the options (or "Other" with a reason) means nothing gets
   created — that's a valid, common answer, not an error.

Step 2 is what keeps the board clean. A gate that proposes duplicates gets switched off within a
sprint.

## Writing the item itself

- **Parent it to the feature**, not to the story that surfaced it. The scaffolding usually
  outlives the story.
- **Acceptance criteria are observable**, even for infrastructure: "the endpoint returns 202 and
  writes a row to `outbox`" rather than "middleware is implemented".
- **Rationale names the design decision** that forced it, with a link to the `design.md` section.
  Six months later that link is the only thing that explains the item.
- Keep the title free of solution jargon a PM can't parse — the item sits on a shared board.

## After approval

A create has no prior revision, so this path needs no rev test — the concurrency machinery guards
updates, not creates. Once created:

1. Record the new id in the design's tech story section.
2. The tech story gets its own spec folder and branch when someone picks it up; it is an ordinary
   work item from that point on.
