"""Offline self-check: python test_sdd.py  (no ADO, no Ollama, temp folder only)."""
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import adowrite
import env
import spec
import sddlib
from sddlib import parse_remote, renumber_bug_phases, slug


def wi(i, title, parent=None, rels=(), desc="", typ="User Story", rev=1, state="Active"):
    r = [{"rel": "System.LinkTypes.Hierarchy-Reverse", "url": f"https://x/_apis/wit/workItems/{parent}",
          "attributes": {"name": "Parent"}}] if parent else []
    r += [{"rel": "System.LinkTypes.Related", "url": f"https://x/_apis/wit/workItems/{d}",
           "attributes": {"name": "Related"}} for d in rels]
    return {"id": i, "relations": r, "fields": {
        "System.TeamProject": "P", "System.WorkItemType": typ, "System.Title": title,
        "System.State": state, "System.Rev": rev, "System.Description": desc}}


def main():
    assert parse_remote("https://Org@dev.azure.com/Org/My.Proj/_git/Repo_1") == ("Org", "My.Proj", "Repo_1")
    assert parse_remote("git@ssh.dev.azure.com:v3/Org/Proj/Repo") == ("Org", "Proj", "Repo")
    assert slug("Help Materials: AI Knowledge!") == "help-materials-ai-knowledge"
    v = env.verdict
    assert v(None, None, []) == "not started in sdd"
    assert v(None, {"progress": {"status": "waiting", "gate": "Approval", "phase": "P5"}}, []) == "waiting on you: Approval"
    merged = [{"pr_live": {"status": "completed"}}]
    assert v(None, {"progress": {"status": "active", "phase": "P10"}}, merged).startswith("PRs merged")
    assert v(None, {"progress": {"status": "done"}, "removed": "x"}, []) == "completed — folder cleaned up"
    assert v(None, {"progress": {"status": "abandoned"}, "removed": "x"}, []) == "abandoned"
    # reopen: back to a done stage, or to the current one while it waits; later recorded gates fall
    item = {"id": 5, "flow": "spec", "gates": {"Claimed": "t", "Requirements agreed": "t", "Design agreed": "t", "Ready to PR": "t"},
            "progress": {"flow": "spec", "phase": "Verify", "status": "waiting"}}
    ok, why, revoke = env.reopen_plan(item, "Design")
    assert ok and revoke == ["Design agreed", "Ready to PR"], (why, revoke)
    assert env.reopen_plan(item, "Specify")[2] == ["Requirements agreed", "Design agreed", "Ready to PR"]
    assert env.reopen_plan(item, "Verify")[:2] == (True, [])
    working = {**item, "progress": {"flow": "spec", "phase": "Verify", "status": "active"}}
    assert not env.reopen_plan(working, "Verify")[0] and env.reopen_plan(working, "Design")[0]
    early = {**item, "progress": {"flow": "spec", "phase": "Design", "status": "waiting"}}
    assert "has not started" in env.reopen_plan(early, "Implement")[1][0]
    assert not env.reopen_plan({**item, "progress": {**item["progress"], "status": "done"}}, "Design")[0]
    bug = {"id": 6, "flow": "bug", "gates": {"Claimed": "t", "Approval": "t", "Red test": "t"},
           "progress": {"flow": "bug", "phase": "Phase 8 — Apply fix", "status": "blocked"}}
    assert env.reopen_plan(bug, "Phase 5")[2] == ["Approval", "Red test"]
    assert not env.reopen_plan(bug, "Phase 8")[0]
    # review stages: wait on the PR once it is raised; a rejected PR goes back to the reworkTo stage
    assert env.PHASE_NEEDS["spec"]["Review"] == ["PR raised"] and env.PHASE_NEEDS["bug"]["Phase 15"] == ["PR raised"]
    assert env.phase_key("bug", "Phase 15 — PR review") == "Phase 15"
    # a record from the old bug numbering (Phase 0 … Phase 13, with 9a) reads in the new one
    old = {"stages": {f"Phase {n}": {"status": "done"} for n in ("0", "1", "5", "9", "9a", "10", "13")},
           "progress": {"flow": "bug", "phase": "Phase 9a — Manual verification", "status": "waiting",
                        "note": "Phase 9a is where we stopped"},
           "history": [{"phase": "Phase 0"}, {"phase": "Phase 12 — Record learnings"}]}
    got = renumber_bug_phases(json.loads(json.dumps(old)))
    assert list(got["stages"]) == ["Phase 1", "Phase 2", "Phase 6", "Phase 10", "Phase 11", "Phase 12", "Phase 15"], got
    assert got["progress"]["phase"] == "Phase 11 — Manual verification"
    assert got["progress"]["note"] == "Phase 9a is where we stopped"          # free text is left as written
    assert [h["phase"] for h in got["history"]] == ["Phase 1", "Phase 14 — Record learnings"]
    new = {"stages": {"Phase 1": {}, "Phase 6": {}}, "progress": {"flow": "bug", "phase": "Phase 6"}, "history": []}
    assert renumber_bug_phases(json.loads(json.dumps(new))) == new           # the new numbering is left alone
    spec_rec = {"stages": {"Design": {}}, "progress": {"flow": "spec", "phase": "Design"}}
    assert renumber_bug_phases(dict(spec_rec)) == spec_rec
    assert env.phase_key("bug", "Phase 9a") is None and env.phase_key("bug", "Phase 0") is None
    review = {"id": 7, "flow": "spec", "gates": {"Requirements agreed": "t", "Design agreed": "t", "Ready to PR": "t"},
              "progress": {"flow": "spec", "phase": "Review", "status": "waiting"}}
    assert env.reopen_plan(review, "Implement")[2] == ["Ready to PR"]
    passed = {**review, "gates": {**review["gates"], "PR approved": "t"}}
    assert env.reopen_plan(passed, "Implement")[2] == ["Ready to PR", "PR approved"]
    bugrev = {"id": 8, "flow": "bug", "gates": {"Approval": "t", "Red test": "t", "Verified": "t", "Manual verification": "t"},
              "progress": {"flow": "bug", "phase": "Phase 15", "status": "waiting"}}
    assert env.reopen_plan(bugrev, "Phase 8")[2] == ["Verified", "Manual verification"]
    assert {s["key"]: s.get("reworkTo") for s in env.FLOWS["flows"]["spec"]["stages"]}["Review"] == "Implement"
    # a waiting gate needs an .html sdd-visual ref, or --no-visual with a reason
    import argparse, contextlib, io

    def gate_error(refs, no_visual=None):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            try:
                env.cmd_progress(argparse.Namespace(status="waiting", ref=refs, no_visual=no_visual, id=0))
            except BaseException:  # past the checks it needs a real workspace; only the message matters
                pass
        return err.getvalue()
    assert "sdd:visual" in gate_error(["design.md"])
    assert "sdd:visual" not in gate_error(["design.md", "visuals/design.html"])
    assert "sdd:visual" not in gate_error([r"C:\x\visuals\bug.html"])
    assert "sdd:visual" not in gate_error(["design.md"], no_visual="plain choice")
    terms = spec.extract_terms("Call `GET /api/chat/{id}` on ChatSession, write dbo.CaseAssignedUser, E200801")
    for t in ("get /api/chat/{id}", "chatsession", "dbo.caseassigneduser", "e200801"):
        assert t in terms, (t, terms)
    assert spec.to_markdown(["<p>a <b>b</b></p>", "", "<ul><li>x</li></ul>"])[2].startswith("- x")

    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        (root / ".claude").mkdir()
        (root / ".claude" / "sdd.json").write_text(json.dumps({"specRoot": "docs/spec", "ado": {"org": "Org"}}))
        os.chdir(root)
        ctx = spec.Ctx()
        items = [wi(1, "Epic One", typ="Epic"), wi(2, "Feature Two", 1, typ="Feature"),
                 wi(3, "Story Three", 2, rels=[4], desc="<p>Uses <code>ChatSession</code></p>"),
                 wi(4, "Story Four", 2, desc="<p>Also ChatSession here</p>")]
        tested = {"rel": "Microsoft.VSTS.Common.TestedBy-Forward",
                  "url": "https://x/_apis/wit/workItems/9", "attributes": {"name": "Tested By"}}

        def with_test(w):
            w["relations"].append(tested)
            return w
        items[2] = with_test(items[2])
        rep, pend = spec.write_items(ctx, items, {9: "Test Case"})
        spec.place_folders(ctx, pend)
        assert sorted(rep["new"]) == [1, 2, 3, 4]
        assert 9 not in {x["id"] for x in spec.links(ctx, 3, 2)}  # non-spec links are never followed
        req = root / "docs/spec/1-EPIC-epic-one/2-FEAT-feature-two/3-US-story-three/requirements.md"
        assert req.is_file(), list((root / "docs/spec").rglob("*"))
        assert "1 × Tested By Test Case" in req.read_text(encoding="utf-8")
        (req.parent / "design.md").write_text("mine")
        first = req.read_text()

        # same ADO state -> identical file; incidental rev bump -> incidental, not material
        rep, pend = spec.write_items(ctx, [with_test(wi(3, "Story Three", 2, rels=[4], rev=2,
                                              desc="<p>Uses <code>ChatSession</code></p>"))], {9: "Test Case"})
        spec.place_folders(ctx, pend)
        assert rep["incidental"] == [3] and req.read_text() == first

        # retitle + reparent to the epic -> material, folder keeps its name, moves, design.md survives
        rep, pend = spec.write_items(ctx, [with_test(wi(3, "Story Renamed", 1, rels=[4], rev=3, desc="<p>Uses <code>ChatSession</code></p>"))], {9: "Test Case"})
        spec.place_folders(ctx, pend)
        moved = root / "docs/spec/1-EPIC-epic-one/3-US-story-three"
        assert rep["material"] == [3] and (moved / "design.md").read_text() == "mine"

        # retype: a story promoted to a tech story is renamed in place, slug kept
        rep, pend = spec.write_items(ctx, [with_test(wi(3, "Story Renamed", 1, rels=[4], rev=4, typ="Tech Story", desc="<p>Uses <code>ChatSession</code></p>"))], {9: "Test Case"})
        spec.place_folders(ctx, pend)
        assert (root / "docs/spec/1-EPIC-epic-one/3-TS-story-three/design.md").read_text() == "mine"
        # an old-style {id}-{slug} folder is renamed, and its children move with it
        (root / "docs/spec/1-EPIC-epic-one").rename(root / "docs/spec/1-epic-one")
        rep, pend = spec.write_items(ctx, [wi(1, "Epic One", typ="Epic", rev=2)], {})
        spec.place_folders(ctx, pend)
        assert (root / "docs/spec/1-EPIC-epic-one/3-TS-story-three/design.md").is_file()
        assert ctx.item(3)["path"] == "1-EPIC-epic-one/3-TS-story-three"
        assert env.spec_state(root, spec.load_config(root), 3)["folder"].endswith("3-TS-story-three")
        assert spec.folder_name(7, "User Story", "Story four", "7-story-four") == "7-US-story-four"
        assert spec.folder_name(8, "Feature", "2026 roadmap", "8-2026-roadmap") == "8-FEAT-2026-roadmap"
        assert spec.folder_name(8, "Feature", "2026 roadmap", "8-US-2026-roadmap") == "8-FEAT-2026-roadmap"
        assert spec.folder_name(9, "Odd Type", "x") == "9-ODDTYPE-x"
        assert {x["id"] for x in spec.links(ctx, 4, 1)} == {2, 3}
        assert [x["id"] for x in spec.overlap(ctx, 4)] == [3]
        # full-spec impact: one entry per pair, never A-B and B-A; scope limits it to a subtree
        import argparse as _ap
        spec.impact_all(ctx, _ap.Namespace(scope=None, hops=2))
        allj = json.loads((root / "docs/spec/.index/impact-all.json").read_text(encoding="utf-8"))
        keys = [(p["a"], p["b"]) for p in allj["pair_list"]]
        assert len(keys) == len(set(keys)) and all(a < b for a, b in keys) and (3, 4) in keys
        assert allj["estimate"]["all"]["tokens_min"] >= allj["estimate"]["strong"]["tokens_min"] > 0
        spec.impact_all(ctx, _ap.Namespace(scope=2, hops=2))
        sub = json.loads(next((root / "docs/spec").rglob("2-FEAT-*/impact-all.json")).read_text(encoding="utf-8"))
        assert all({p["a"], p["b"]} <= {2, 4} for p in sub["pair_list"])  # 3 moved under the epic
        ctx.db.close()

        # decision links: requirements.md always included, a missing ref is an error, never skipped
        lines, send, bad = env.build_refs(root, spec.load_config(root), 4, ["ado", "design.md"])
        assert any("requirements.md" in x for x in lines) and bad == ["ref not found: design.md"]
        lines, send, bad = env.build_refs(root, spec.load_config(root), 3, ["design.md:2-5"])
        assert not bad and any("design.md lines 2-5" in x for x in lines) and len(send) == 2

        # phase guards: offline, from workitem.json alone
        from sddlib import load_config as lc
        cfg = lc(root)
        pk = env.phase_key
        assert pk("bug", "Phase 12 — Pull request") == "Phase 12" and pk("bug", "Phase 11") == "Phase 11"
        assert pk("bug", "Phase 2 — Pick") == "Phase 2" and pk("spec", "Implement (task 3/7)") == "Implement"
        assert env.check_op(root, cfg, 5, "phase", "bug", "Phase 1")[0]            # nothing needed, no folder yet
        assert not env.check_op(root, cfg, 5, "phase", "bug", "Phase 7")[0]        # no folder, needs Approval
        assert not env.check_op(root, cfg, 5, "phase", None, "Phase 1")[0]         # flow unknown
        wdir = root / ".claude/worktrees/5-x"
        wdir.mkdir(parents=True)
        early = {f"Phase {n}": {"at": "t", "status": "done"} for n in range(1, 6)}
        rec = {"id": 5, "flow": "bug", "repos": {}, "gates": {"Claimed": "t"},
              "stages": {**early, "Phase 6": {"at": "t", "status": "worked"}},
              "progress": {"flow": "bug", "phase": "Phase 6", "status": "waiting"}}
        (wdir / "workitem.json").write_text(json.dumps(rec))
        ok, why, _ = env.check_op(root, cfg, 5, "phase", None, "Phase 8 — Apply the fix")
        assert not ok and any("Approval" in w for w in why) and any("Red test" in w for w in why)
        rec["gates"].update({"Approval": "t", "Red test": "t"})
        (wdir / "workitem.json").write_text(json.dumps(rec))
        ok, why, _ = env.check_op(root, cfg, 5, "phase", None, "Phase 8")
        assert not ok and any("Phase 7 was never worked" in w for w in why), why  # no jumping past a stage
        rec["stages"]["Phase 7"] = {"at": "t", "status": "done"}
        (wdir / "workitem.json").write_text(json.dumps(rec))
        assert env.check_op(root, cfg, 5, "phase", None, "Phase 8")[0]
        assert not env.check_op(root, cfg, 5, "phase", None, "Phase 4")[0]         # derived Worktree missing

        # progress: a stage is never skipped silently, only with the user's recorded yes
        import argparse as _ap, contextlib, io

        def progress(phase, status="active", **kw):
            args = dict(id=5, flow="bug", phase=phase, status=status, gate=None, next=None, note=None, ref=[],
                        no_visual=None, passed=[], revoke=[], confirmed=None, caveat=None)
            args.update(kw)
            with contextlib.redirect_stdout(io.StringIO()):
                env.cmd_progress(_ap.Namespace(**args))
            return json.loads((wdir / "workitem.json").read_text(encoding="utf-8"))

        def refused(*a, **kw):
            err = io.StringIO()
            try:
                with contextlib.redirect_stderr(err):
                    progress(*a, **kw)
            except SystemExit:
                return err.getvalue()
            raise AssertionError("progress should have refused")

        msg = refused("Phase 11 — Manual verification")  # the 93347 jump
        assert "Phase 8, Phase 9, Phase 10 were never worked" in msg, msg
        assert "--confirmed" in refused("Phase 8", "skipped")                              # skip needs the user's yes
        assert "unknown bug stage" in refused("Phase 101")
        got = progress("Phase 8 — Apply the fix")
        assert got["stages"]["Phase 8"]["status"] == "worked"
        got = progress("Phase 9 — Verify", "skipped", confirmed="yes, skip it")
        assert got["stages"]["Phase 8"]["status"] == "done"                               # moving on finishes it
        assert got["stages"]["Phase 9"] == {"at": got["stages"]["Phase 9"]["at"], "status": "skipped",
                                            "confirmed": "yes, skip it"}
        progress("Phase 10 — Commit and push")
        got = progress("Phase 5 — Prove the root cause")                                   # going back
        assert "Phase 8" not in got["stages"] and "Phase 10" not in got["stages"]          # later stages are redone
        assert "Phase 6" in refused("Phase 7")
        assert not env.check_op(root, cfg, 5, "phase", None, "Phase 101")[0]        # unknown phase

        # /sdd done after close-out: status "done" must not block the clean-up (ADO and PRs faked)
        pr_state = {"status": "completed"}
        env.pr_live = lambda cfg, r: dict(pr_state)
        env.live_item = lambda cfg, wid: {"state": "Resolved", "board": "Dev Completed"}
        ddir = root / ".claude/worktrees/6-closed"
        ddir.mkdir(parents=True)
        drec = {"id": 6, "flow": "bug", "gates": {"Claimed": "t"},
                "repos": {"app": {"path": "app", "source": "app", "branch": "bug/6", "base": "main", "pr": {"id": 1, "url": "pr/1"}}},
                "progress": {"flow": "bug", "phase": "Phase 13 — Write back to the work item", "status": "done"},
                "history": [{"at": "t", "phase": p} for p in ("Phase 1", "Phase 2", "Phase 3", "Phase 6", "Phase 7",
                                                               "Phase 8", "Phase 9", "Phase 11", "Phase 12", "Phase 13")]}
        (ddir / "workitem.json").write_text(json.dumps(drec))
        ok, why, _ = env.check_op(root, cfg, 6, "done")                             # 93347: stages left out
        assert not ok and any("Phase 4, Phase 5, Phase 10, Phase 14, Phase 15" in w for w in why), why
        drec["stages"] = {k: {"at": "t", "status": "done"} for k in env.BUG_PHASES}
        drec["stages"]["Phase 14"] = {"at": "t", "status": "skipped", "confirmed": "skip it"}
        (ddir / "workitem.json").write_text(json.dumps(drec))
        ok, why, _ = env.check_op(root, cfg, 6, "done")
        assert ok, why
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            env.cmd_remove(_ap.Namespace(id=6, abandon=False, yes=False))
        assert "will remove" in out.getvalue() and ddir.name in out.getvalue() and "dry run" in out.getvalue() and ddir.is_dir(), out.getvalue()
        assert not env.check_op(root, cfg, 6, "resume")[0]                          # resume still refused
        assert not env.check_op(root, cfg, 6, "phase", None, "Phase 8")[0]          # phase still refused
        assert v(None, drec, [{"pr_live": pr_state}]) == "PRs merged — run /sdd done to clean up"
        assert v(None, drec, []) == "closed out — run /sdd done to clean up"
        pr_state["status"] = "active"
        ok, why, _ = env.check_op(root, cfg, 6, "done")
        assert not ok and any("not merged yet" in w for w in why) and not any("the flow is" in w for w in why), why
        (ddir / "workitem.json").write_text(json.dumps({**drec, "progress": {**drec["progress"], "status": "abandoned"}}))
        pr_state["status"] = "completed"
        ok, why, _ = env.check_op(root, cfg, 6, "done")
        assert not ok and "the flow is abandoned" in why, why
        # a real remove: folder gone, record kept, verdict now "completed"
        (ddir / "workitem.json").write_text(json.dumps({**drec, "repos": {}}))
        with contextlib.redirect_stdout(io.StringIO()):
            env.cmd_remove(_ap.Namespace(id=6, abandon=False, yes=True))
        kept = json.loads((env.done_dir(root, cfg) / "6.json").read_text(encoding="utf-8"))
        assert not ddir.exists() and v(None, kept, []).startswith("completed")
        # Open Questions: conditional stage, driven by the unticked boxes in questions.md
        sdir = root / cfg["specRoot"] / "9-US-asks"
        sdir.mkdir(parents=True)
        qfile = sdir / "questions.md"
        assert env.count_questions("- [ ] Q1\n- [x] Q2 - answered\n* [ ] Q3\nplain") == (2, 3)
        qdir = root / ".claude/worktrees/9-asks"
        qdir.mkdir(parents=True)
        qrec = {"id": 9, "flow": "spec", "path": "full", "repos": {}, "gates": {"Claimed": "t"}, "stages": {"Specify": {"at": "t", "status": "done"}},
                "progress": {"flow": "spec", "phase": "Specify", "status": "active"}}

        def spec_progress(phase, status="active", **kw):
            args = dict(id=9, flow="spec", phase=phase, status=status, gate=None, next=None, note=None, ref=[],
                        no_visual=None, passed=[], revoke=[], confirmed=None, caveat=None)
            args.update(kw)
            with contextlib.redirect_stdout(io.StringIO()):
                env.cmd_progress(_ap.Namespace(**args))
            return json.loads((qdir / "workitem.json").read_text(encoding="utf-8"))

        def spec_refused(*a, **kw):
            err = io.StringIO()
            try:
                with contextlib.redirect_stderr(err):
                    spec_progress(*a, **kw)
            except SystemExit:
                return err.getvalue()
            raise AssertionError("progress should have refused")

        (qdir / "workitem.json").write_text(json.dumps(qrec))
        qfile.write_text("- [ ] Q1 who signs off?\n- [ ] Q2 which region?\n", encoding="utf-8")
        assert env.open_questions(root, cfg, 9) == 2
        assert "2 open questions" in spec_refused("Open Questions", "skipped")            # cannot skip real questions
        ok, why, _ = env.check_op(root, cfg, 9, "phase", "spec", "Requirements")
        assert not ok and any("Open Questions" in w for w in why), why                     # questions block Requirements
        got = spec_progress("Open Questions")
        assert got["stages"]["Open Questions"]["status"] == "worked"
        assert "--caveat" in spec_refused("Open Questions", "done", passed=["Open questions"])
        assert not env.check_op(root, cfg, 9, "phase", "spec", "Requirements")[0]
        got = spec_progress("Open Questions", "done", passed=["Open questions"], caveat="Q2 region: unanswered")
        assert got["progress"]["caveat"] == "Q2 region: unanswered" and got["progress"]["openQuestions"] == 2
        ok, why, _ = env.check_op(root, cfg, 9, "phase", "spec", "Requirements")
        assert ok, why                                                                   # continued with a caveat
        assert got["progress"]["status"] == "done"                                       # a done stage hands over, the flow goes on
        assert "only for finishing" in spec_refused("Design", caveat="x")
        # answered everything: nothing to ask, the stage records itself skipped without the user's words
        qrec2 = {**qrec, "gates": {"Claimed": "t"}, "stages": {"Specify": {"at": "t", "status": "done"}}}
        (qdir / "workitem.json").write_text(json.dumps(qrec2))
        qfile.write_text("- [x] Q1 who signs off? - Answer: the PM\n", encoding="utf-8")
        assert env.check_op(root, cfg, 9, "phase", "spec", "Requirements")[0]             # no record needed when no questions
        got = spec_progress("Open Questions", "skipped")
        assert got["stages"]["Open Questions"]["status"] == "skipped" and got["stages"]["Open Questions"]["confirmed"]
        # an item from before the stage existed: Requirements agreed is passed, so Design is not blocked
        old = {**qrec, "gates": {"Claimed": "t", "Requirements agreed": "t"},
               "stages": {"Specify": {"at": "t", "status": "done"}}}
        assert env.unaccounted("spec", old, "Design", 1) == ["Open Questions"]
        assert env.unaccounted("spec", old, "Design", 0) == []
        fin = {**old, "gates": {**old["gates"], "Design agreed": "t", "PR approved": "t"},
               "progress": {"flow": "spec", "phase": "Review", "status": "done"}}
        (qdir / "workitem.json").write_text(json.dumps(fin))
        ok, why, _ = env.check_op(root, cfg, 9, "phase", "spec", "Review")
        assert not ok and "the flow is done" in why, why                                   # the last stage done: flow over
        os.chdir(Path(__file__).parent)
    stage_docs()
    short_path()
    config_upgrade()
    output_style()
    ado_writes()
    print("ok")


def ado_writes():
    """adowrite: the claim, hand-over and sprint decisions, the mention check, the rev-tested retry."""
    me = "me@x.co"
    mine = {"displayName": "Me", "uniqueName": "Me@X.co"}
    ops = lambda o: {x["path"].split("/")[-1]: x["value"] for x in o}
    # claim: unassigned -> all three; mine and started -> nothing; someone else's / resolved -> stop
    assert ops(adowrite.claim_ops({"System.State": "New"}, me)) == {
        "System.AssignedTo": me, "System.State": "Active", "Custom.BoardColumnTitle": "Dev In Progress"}
    assert adowrite.claim_ops({"System.AssignedTo": mine, "System.State": "Active",
                               "Custom.BoardColumnTitle": "Dev In Progress"}, me) == []
    assert ops(adowrite.claim_ops({"System.AssignedTo": "Me <me@x.co>", "System.State": "New"}, me)) == {
        "System.State": "Active", "Custom.BoardColumnTitle": "Dev In Progress"}
    for fields, word in (({"System.AssignedTo": {"displayName": "Ann", "uniqueName": "ann@x.co"}}, "Ann"),
                         ({"System.State": "Resolved"}, "--reopen")):
        try:
            adowrite.claim_ops(fields, me)
            raise AssertionError(f"claim went ahead on {fields}")
        except adowrite.Refused as e:
            assert word in str(e), e
    assert ops(adowrite.claim_ops({"System.State": "Closed"}, me, reopen=True))["System.State"] == "Active"
    ann = {"displayName": "Ann", "uniqueName": "ann@x.co"}
    for busy in ({"System.State": "Active"}, {"System.State": "New", "Custom.BoardColumnTitle": "dev in progress"}):
        try:                                                     # someone's work in progress: never, --take or not
            adowrite.claim_ops({"System.AssignedTo": ann, **busy}, me, take=True)
            raise AssertionError(f"took Ann's work in progress: {busy}")
        except adowrite.Refused as e:
            assert "working on it" in str(e), e
    try:                                                         # on Ann's name, not started: only with --take
        adowrite.claim_ops({"System.AssignedTo": ann, "System.State": "New"}, me)
        raise AssertionError("took Ann's item without --take")
    except adowrite.Refused as e:
        assert "--take" in str(e), e
    assert ops(adowrite.claim_ops({"System.AssignedTo": ann, "System.State": "New"}, me, take=True)) == {
        "System.AssignedTo": me, "System.State": "Active", "Custom.BoardColumnTitle": "Dev In Progress"}
    assert "System.AssignedTo" not in ops(adowrite.claim_ops({"System.AssignedTo": mine, "System.State": "New"}, me))
    # hand-over: an Issue needs both texts; tags are appended; a mention is refused
    try:
        adowrite.handover_ops({"System.WorkItemType": "Issue"})
        raise AssertionError("an Issue handed over without its root cause")
    except adowrite.Refused:
        pass
    got = ops(adowrite.handover_ops({"System.WorkItemType": "User Story", "System.Tags": "a; b"}, tag="2.4"))
    assert got == {"Custom.BoardColumnTitle": "Dev Completed", "System.State": "Resolved", "System.Tags": "a; b; 2.4"}
    assert "System.Tags" not in ops(adowrite.handover_ops({"System.WorkItemType": "Bug", "System.Tags": "2.4"}, tag="2.4"))
    try:
        adowrite.handover_ops({"System.WorkItemType": "Bug"}, root_cause_details="<div>see #80459</div>")
        raise AssertionError("a #mention went through")
    except adowrite.Refused as e:
        assert "ADO 80459" in str(e)
    assert adowrite.mentions("AB#80459 &#8217; url/#123 ADO 80459") == [] and adowrite.mentions("(#80459)") == ["#80459"]
    # an AI Agent Request: the items a hand-over names, the work it says is left, where the work may go
    assert adowrite.referenced_ids("Bug 4474 and ADO 4471, ADO-4471, AB#4472, (#4473), user story 4475, work item "
                                   "4476, .../_workitems/edit/4477, version 1.2.300, 12345 rows, &#8217;, ADO 99",
                                   skip={4476}) == [4474, 4471, 4472, 4473, 4475, 4477]
    assert adowrite.todo_lines("API done. Work still to be done: the UI. Tests are not yet written.\n- TODO: docs\n"
                               "All good.") == ["Work still to be done: the UI.", "Tests are not yet written.", "TODO: docs"]
    fit = lambda typ, flow, state="Active": adowrite.route_fit({"System.WorkItemType": typ, "System.State": state}, flow)
    assert fit("Bug", "bug") is None and fit("Issue", "bug") is None and fit("Tech Story", "spec") is None
    assert "bug flow" in fit("Bug", "spec") and "spec flow" in fit("User Story", "bug")
    assert "not open" in fit("Bug", "bug", "Closed") and "not open" in fit("User Story", "spec", "Removed")
    assert "itself" in fit("AI Agent Request", "spec")
    assert [adowrite.flow_of(t) for t in ("Bug", "Issue", "Tech Story", "AI Agent Request")] == ["bug", "bug", "spec",
                                                                                                "request"]
    url = "https://dev.azure.com/O/_apis/wit/workItems/700"
    assert adowrite.link_op([{"rel": adowrite.RELATED, "url": "https://x/_apis/wit/workItems/700"}], adowrite.RELATED, url) == []
    assert adowrite.link_op([], adowrite.RELATED, url)[0]["value"] == {"rel": adowrite.RELATED, "url": url}
    req = {"System.AreaPath": "P\\Area", "System.IterationPath": "P\\Sprint 2"}
    got = adowrite.create_ops("Bug", "Totals", "<div>drops cents</div>", req, links=[(adowrite.RELATED, url)])
    assert ops([o for o in got if o["path"].startswith("/fields/")]) == {
        "System.Title": "Totals", "Microsoft.VSTS.TCM.ReproSteps": "<div>drops cents</div>",
        "System.AreaPath": "P\\Area", "System.IterationPath": "P\\Sprint 2"}
    assert got[-1] == {"op": "add", "path": "/relations/-", "value": {"rel": adowrite.RELATED, "url": url}}
    got = ops(adowrite.create_ops("Tech Story", "T", "<div>x</div>", {}, acceptance="<div>ac</div>"))
    assert got == {"System.Title": "T", "System.Description": "<div>x</div>",
                   "Microsoft.VSTS.Common.AcceptanceCriteria": "<div>ac</div>"}
    for bad in (("", "<div>x</div>"), ("T", " "), ("T", "<div>see #4471</div>")):
        try:
            adowrite.create_ops("Bug", bad[0], bad[1], {})
            raise AssertionError(f"create_ops took {bad}")
        except adowrite.Refused:
            pass
    # the sprint: the iteration whose dates hold today, the shortest range, path without "Iteration"
    from datetime import date
    tree = {"path": "\\P\\Iteration", "children": [
        {"path": "\\P\\Iteration\\2026", "attributes": {"startDate": "2026-01-01T00:00:00Z", "finishDate": "2026-12-31T00:00:00Z"},
         "children": [{"path": "\\P\\Iteration\\2026\\Sprint 20",
                       "attributes": {"startDate": "2026-10-05T00:00:00Z", "finishDate": "2026-10-16T00:00:00Z"}}]}]}
    assert adowrite.pick_iteration(tree, date(2026, 10, 10)) == "P\\2026\\Sprint 20"
    assert adowrite.pick_iteration(tree, date(2026, 11, 1)) == "P\\2026"
    assert adowrite.pick_iteration(tree, date(2027, 1, 1)) is None
    assert adowrite.iteration_ops({"System.IterationPath": "P\\2026"}, "P\\2026") == []
    # the write: the rev test leads every patch; a 412 means read again, decide again, retry
    reads, sent = [{"id": 5, "rev": 7, "fields": {"System.State": "New"}},
                   {"id": 5, "rev": 8, "fields": {"System.State": "New", "System.AssignedTo": mine}}], []

    def fake_ado(method, url, body=None, content_type=None):
        sent.append(body)
        if len(sent) == 1:
            raise RuntimeError(f"ADO {method} {url} -> HTTP 412: rev mismatch")
    real = adowrite.ado, adowrite.get_items, adowrite.org_url
    adowrite.ado, adowrite.org_url = fake_ado, lambda cfg: "https://dev.azure.com/o"
    adowrite.get_items = lambda cfg, ids, fields=None: [reads.pop(0)]
    try:
        w, done = adowrite.write({}, 5, lambda f: adowrite.claim_ops(f, me))
    finally:
        adowrite.ado, adowrite.get_items, adowrite.org_url = real
    assert sent[0][0] == {"op": "test", "path": "/rev", "value": 7} and sent[1][0]["value"] == 8
    assert "System.AssignedTo" not in ops(done)               # the second read showed it was mine already


def output_style():
    """The ELI5 style: written to the global output-styles folder and set once in settings.json."""
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        home = Path(tmp)
        os.environ["CLAUDE_CONFIG_DIR"] = tmp
        try:
            style, settings = home / "output-styles" / "ELI5.md", home / "settings.json"
            text = sddlib.STYLE_SRC.read_text(encoding="utf-8")
            assert "\nname: ELI5\n" in text.split("---")[1]                 # file named after its name field
            changed, notes = sddlib.install_output_style()                  # fresh: folder, file, settings
            assert changed == [style, settings] and not notes
            assert style.read_text(encoding="utf-8") == text
            assert json.loads(settings.read_text()) == {"outputStyle": "ELI5"}
            assert sddlib.install_output_style() == ([], [])                # nothing to do the second time
            settings.write_text(json.dumps({"model": "opus", "outputStyle": "Explanatory"}))
            assert sddlib.install_output_style() == ([], [])                # the person's later pick stays
            assert json.loads(settings.read_text()) == {"model": "opus", "outputStyle": "Explanatory"}
            assert sddlib.install_output_style(force=True)[0] == [settings]  # env.py init sets it again
            assert json.loads(settings.read_text()) == {"model": "opus", "outputStyle": "ELI5"}
            style.write_text("my own words", encoding="utf-8")              # an edited style file stays
            changed, notes = sddlib.install_output_style()
            assert changed == [] and "kept your version" in notes[0]
            assert style.read_text(encoding="utf-8") == "my own words"
            state = home / "sdd" / "state.json"                             # an unedited old copy updates
            old = "---\nname: ELI5\n---\nold words\n"
            style.write_text(old, encoding="utf-8")
            st = json.loads(state.read_text())
            state.write_text(json.dumps({**st, "styleHash": sddlib._sha(old)}))
            assert sddlib.install_output_style()[0] == [style] and style.read_text(encoding="utf-8") == text
            settings.write_text('{"a": 1,')                                  # broken JSON is never written
            state.unlink()
            changed, notes = sddlib.install_output_style()
            assert settings.read_text() == '{"a": 1,' and "not valid JSON" in notes[0]
        finally:
            del os.environ["CLAUDE_CONFIG_DIR"]


def short_path():
    """The spec flow's short path lifts Design agreed from Decompose, and only that."""
    full = env.stage_needs("spec", {"path": "full"}, "Decompose")
    short = env.stage_needs("spec", {"path": "short"}, "Decompose")
    assert "Design agreed" in full and "Design agreed" not in short and set(full) - set(short) == {"Design agreed"}
    assert env.stage_needs("spec", {"path": "short"}, "Implement") == env.stage_needs("spec", {"path": "full"}, "Implement")
    assert "Design agreed" in env.stage_needs("spec", {"path": "short"}, "Implement")
    assert env.flow_path("spec", {}) is None and env.flow_path("bug", {}) is None
    assert env.flow_path("spec", {"gates": {"Design agreed": "t"}}) == "full"      # started before paths existed


def stage_docs():
    """Every stage names its own file, the file exists, and starts with the stage's heading."""
    plugin = Path(__file__).resolve().parent.parent
    for flow, f in env.FLOWS["flows"].items():
        for st in f["stages"]:
            doc = env.stage_doc(flow, st["key"])
            assert doc and Path(doc).is_file(), (flow, st["key"], doc)
            first = Path(doc).read_text(encoding="utf-8").split("\n", 1)[0]
            assert first.startswith("# ") and (st["key"] in first or st["key"].split()[-1] in first), (doc, first)
            assert str(plugin) in doc
    assert env.stage_doc("bug", "Phase 9 — Verify").endswith("09-verify.md")
    assert env.stage_doc("spec", "Implement (task 3/7)").endswith("implement.md")
    assert env.stage_doc("bug", "Phase 99") is None


def config_upgrade():
    """agents.models: defaults in load_config, written into an existing sdd.json by upgrade-config."""
    plugin = Path(__file__).resolve().parent.parent
    for name, model in sddlib.DEFAULTS["agents"]["models"].items():  # the agent file's own default agrees
        head = (plugin / "agents" / f"{name}.md").read_text(encoding="utf-8").split("---")[1]
        assert f"\nmodel: {model}\n" in head, (name, model)
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        root = Path(tmp)
        (root / ".claude").mkdir()
        path = root / ".claude" / "sdd.json"
        before = {"specRoot": "docs/spec", "ado": {"org": "Org", "projects": ["P"]}}
        path.write_text(json.dumps(before))
        assert sddlib.load_config(root)["agents"]["models"] == {"investigator": "sonnet", "skeptic": "opus"}
        assert sddlib.upgrade_config(root) == ["agents.models.investigator", "agents.models.skeptic"] + ["next.weights.priority", "next.weights.severity", "next.weights.complexity", "next.complexity"]
        got = json.loads(path.read_text())
        assert got["agents"] == {"models": {"investigator": "sonnet", "skeptic": "opus"}}
        assert got["next"] == {"weights": {"priority": 50, "severity": 30, "complexity": 20}, "complexity": "complex-first"}
        assert {k: got[k] for k in before} == before                    # nothing else written or changed
        assert "view" not in got
        assert sddlib.upgrade_config(root) == []                         # second run: nothing to do
        path.write_text(json.dumps({**before, "agents": {"models": {"skeptic": "sonnet"}, "x": 1},
                                    "next": {"weights": {"priority": 70}, "complexity": "simple-first"}}))
        assert sddlib.upgrade_config(root) == ["agents.models.investigator", "next.weights.severity",
                                               "next.weights.complexity"]
        assert json.loads(path.read_text())["next"]["weights"]["priority"] == 70     # a tuned weight stays
        assert sddlib.load_config(root)["next"]["complexity"] == "simple-first"
        got = json.loads(path.read_text())
        assert got["agents"] == {"models": {"skeptic": "sonnet", "investigator": "sonnet"}, "x": 1}  # set value kept
        path.write_text(json.dumps({**before, "agents": "opus", "next": dict(sddlib.DEFAULTS["next"])}))
        assert sddlib.upgrade_config(root) == [] and json.loads(path.read_text())["agents"] == "opus"
        assert sddlib.load_config(root)["agents"]["models"]["skeptic"] == "opus"
        path.write_text(json.dumps({**before, "agents": {"models": {"investigator": "gpt-4"}}}))
        assert sddlib.bad_agent_models(sddlib.load_config(root)) == ["investigator=gpt-4"]
        assert sddlib.load_config(root)["agentRequest"] == sddlib.DEFAULTS["agentRequest"]
        path.write_text(json.dumps({**before, "agentRequest": {"create": {"spec": "User Story"}}}))
        assert sddlib.load_config(root)["agentRequest"] == {"types": ["AI Agent Request"],
                                                            "create": {"bug": "Bug", "spec": "User Story"}}


if __name__ == "__main__":
    main()
