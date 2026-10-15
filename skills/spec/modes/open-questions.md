# Mode: Open Questions (conditional)

> Part of the `sdd:spec` flow. Its rules (`../SKILL.md`) and the shared flow rules
> (`${CLAUDE_PLUGIN_ROOT}/skills/sdd/references/flow-rules.md`) hold here too. Paths like
> `references/…` and `assets/…` are in the spec skill's folder.

Runs only when Specify left open questions: any `- [ ]` line in `questions.md`. That file holds the
gaps in the work item **and** the blast-radius gaps from `impact.md`, which Specify copied there.
With none, the stage is skipped. The script refuses a skip while a question is open, and refuses to
start Requirements until this stage is done.

1. **Start the stage:** `env.py progress --phase "Open Questions" --status active --note "<N> open"`.
2. **List and explain first. Ask nothing yet.** Build an `sdd:visual` page
   (`visuals/open-questions.html`) that lists every open question, where it came from (work item gap
   or impact gap), and the situation: what the requirement says, what is unclear, and what each
   answer would change. Send it, and open the chat
   with a short intro: how many questions there are, and that you will ask them one at a time. Then
   paste the Links block (see "Decision briefs") and ask the first one directly after it, with
   nothing in between.
3. **Ask one question at a time** with `AskUserQuestion`: one question per call, never batched. Offer
   the likely answers as options when there are any (the built-in "Other" takes anything else), and
   **always end with the option "Continue with this open"**. Checkpoint each ask:
   `--status waiting --gate "Q<n> of <N>: <question>" --ref questions.md --ref visuals/open-questions.html`.
4. **Record each answer at once.** Tick the line in `questions.md` and put the answer on it:
   `- [x] Q1: <question> — Answer: <the user's words>`. Never write an answer into `requirements.md`
   (ground rule 1), and never answer an unclear point yourself.
5. **"Continue with this open"** ends the questioning. Do not ask the rest. Say in one line which
   questions stay open, then record `env.py progress --phase "Open Questions" --status done
   --passed "Open questions" --caveat "<each open question, a few words each>"`. Leave those lines
   `- [ ]`. Carry them forward: the requirements page, the design and the PR description each list
   them as **open questions the work continues with**. The script refuses a finish with open
   questions and no `--caveat`.
6. **All answered?** Record `--status done --passed "Open questions" --note "all <N> answered"`.
7. A question that arises while asking is added as a new `- [ ]` line and asked in turn. One that an
   earlier answer made moot is ticked with "— moot after Q<n>".
