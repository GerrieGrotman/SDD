"""Self-check for repowatch.py on real git repos in temp folders.

    python repowatch/scripts/test_repowatch.py      (needs git)
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import repowatch as rw  # noqa: E402

PY = sys.executable


def sh(args, cwd, check=True):
    r = subprocess.run(args, cwd=str(cwd), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise AssertionError("%s failed:\n%s\n%s" % (args, r.stdout, r.stderr))
    return r


def commit(repo, name, text="x\n", msg=None):
    (Path(repo) / name).write_text(text, encoding="utf-8")
    sh(["git", "add", name], repo)
    sh(["git", "commit", "-qm", msg or ("add " + name)], repo)


def make_repo(ws, origins, name):
    """A repo `name` in the workspace with a bare origin and one pushed commit."""
    origin = origins / (name + ".git")
    sh(["git", "init", "-q", "--bare", str(origin)], origins)
    repo = ws / name
    sh(["git", "clone", "-q", str(origin), str(repo)], ws)
    commit(repo, "a.txt")
    sh(["git", "push", "-q", "-u", "origin", "main"], repo)
    sh(["git", "remote", "set-head", "origin", "main"], repo)
    return repo


def run_cli(ws, *args):
    r = subprocess.run([PY, str(HERE / "repowatch.py")] + list(args), cwd=str(ws), capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    return r.stdout


def cli(ws, *args):
    """(returncode, parsed json of stdout)."""
    r = subprocess.run([PY, str(HERE / "repowatch.py")] + list(args), cwd=str(ws), capture_output=True, text=True)
    assert r.stdout.strip(), r.stderr
    return r.returncode, json.loads(r.stdout)


def add_worktree(repo, wt, branch, push=False, commit_file=None):
    sh(["git", "worktree", "add", "-q", "-b", branch, str(wt)], repo)
    if commit_file:
        commit(wt, commit_file)
    if push:
        sh(["git", "push", "-q", "-u", "origin", branch], wt)


def test_parsers():
    s = rw.parse_status("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n"
                        "1 M. N... 100644 100644 100644 a b f.txt\n1 .M N... 100644 100644 100644 a b g.txt\n"
                        "u UU N... 1 2 3 4 a b c h.txt\n? new.txt\n")
    assert (s["branch"], s["ahead"], s["behind"]) == ("main", 2, 3), s
    assert (s["staged"], s["unstaged"], s["untracked"], s["conflicted"], s["dirty"]) == (1, 1, 1, 1, 4), s
    assert rw.parse_status("# branch.head (detached)\n")["detached"] is True
    assert rw.parse_track("[ahead 1, behind 2]") == (1, 2, False)
    assert rw.parse_track("[gone]") == (0, 0, True)
    assert rw.parse_track("") == (0, 0, False)
    wts = rw.parse_worktrees("worktree /a\nHEAD abcdef1234567890\nbranch refs/heads/main\n\n"
                             "worktree /b\nHEAD 1234567890abcdef\ndetached\nprunable gone\n")
    assert [w["path"] for w in wts] == ["/a", "/b"] and wts[0]["branch"] == "main"
    assert wts[1]["detached"] and wts[1]["prunable"] and wts[1]["branch"] is None
    recs = [{"name": "a", "lastFetch": 50}, {"name": "b", "lastFetch": None}, {"name": "c", "lastFetch": 10}]
    assert [r["name"] for r in rw.pick_for_fetch(recs, 2)] == ["b", "c"]


def test_scan():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gitcfg = tmp / "gitconfig"
        gitcfg.write_text("[user]\n\tname = Dev\n\temail = dev@x.co\n[init]\n\tdefaultBranch = main\n")
        os.environ["GIT_CONFIG_GLOBAL"] = str(gitcfg)
        ws, origins = tmp / "ws", tmp / "origins"
        ws.mkdir()
        origins.mkdir()
        (ws / ".claude").mkdir()
        (ws / ".claude" / "repowatch.json").write_text("{}")

        clean = make_repo(ws, origins, "clean")
        dirty = make_repo(ws, origins, "dirty")
        late = make_repo(ws, origins, "late")
        make_repo(ws, origins, "gone")
        (dirty / "a.txt").write_text("changed\n")
        (dirty / "new.txt").write_text("n\n")
        commit(late, "local.txt")  # one commit ahead of origin

        # `clean` falls behind: someone else pushes through a second clone
        other = tmp / "other"
        sh(["git", "clone", "-q", str(origins / "clean.git"), str(other)], tmp)
        commit(other, "b.txt")
        sh(["git", "push", "-q", "origin", "main"], other)

        # `gone`: a branch whose upstream is deleted on the remote
        gone = ws / "gone"
        sh(["git", "checkout", "-q", "-b", "feat"], gone)
        commit(gone, "f.txt")
        sh(["git", "push", "-q", "-u", "origin", "feat"], gone)
        sh(["git", "checkout", "-q", "main"], gone)
        sh(["git", "push", "-q", "origin", "--delete", "feat"], gone)

        # a linked worktree of `late`, dirty; it must not be found as a repo of its own
        wt = ws / "late-wt"
        sh(["git", "worktree", "add", "-q", "-b", "work", str(wt)], late)
        (wt / "a.txt").write_text("wip\n")

        # a plain folder that is not a repo
        (ws / "docs").mkdir()

        names = [n for n, _ in rw.discover(ws, rw.load_config(ws))]
        assert names == ["clean", "dirty", "gone", "late"], names

        out = run_cli(ws, "scan", "--fetch", "--fetch-batch", "10", "--json")
        summary = json.loads(out)
        assert summary["repos"] == 4 and summary["worktrees"] == 1, summary

        state = json.loads(run_cli(ws, "status", "--json"))
        r = state["repos"]
        assert "behind" in r["clean"]["flags"] and r["clean"]["behind"] == 1, r["clean"]
        assert "dirty" in r["dirty"]["flags"] and r["dirty"]["dirty"] == 2, r["dirty"]
        assert "unpushed" in r["late"]["flags"] and r["late"]["ahead"] == 1, r["late"]
        assert r["gone"]["goneBranches"] == ["feat"] and "gone-branches" in r["gone"]["flags"], r["gone"]
        assert r["clean"]["defaultBranch"] == "main" and r["clean"]["lastFetch"], r["clean"]
        w = r["late"]["worktrees"][0]
        assert w["branch"] == "work" and w["dirty"] == 1 and w["path"].endswith("late-wt"), w
        assert "stale-fetch" not in r["clean"]["flags"]

        # --only rescans one repo and keeps the rest
        run_cli(ws, "scan", "--only", "dirty")
        assert set(json.loads(run_cli(ws, "status", "--json"))["repos"]) == {"clean", "dirty", "gone", "late"}

        # a repo that disappears is forgotten by a full scan
        shutil.rmtree(str(ws / "gone"))
        run_cli(ws, "scan")
        assert "gone" not in json.loads(run_cli(ws, "status", "--json"))["repos"]
        assert "late" in run_cli(ws, "status")

        # a broken repo is reported, not raised
        broken = ws / "broken"
        (broken / ".git").mkdir(parents=True)
        run_cli(ws, "scan")
        assert json.loads(run_cli(ws, "status", "--json"))["repos"]["broken"]["flags"] == ["error"]


def test_worktrees():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gitcfg = tmp / "gitconfig"
        gitcfg.write_text("[user]\n\tname = Dev\n\temail = dev@x.co\n[init]\n\tdefaultBranch = main\n")
        os.environ["GIT_CONFIG_GLOBAL"] = str(gitcfg)
        ws, origins, wts = tmp / "ws", tmp / "origins", tmp / "wts"
        for d in (ws, origins, wts, ws / ".claude"):
            d.mkdir()
        (ws / ".claude" / "sdd.json").write_text(json.dumps({"worktreeRoot": ".claude/worktrees"}))
        app = make_repo(ws, origins, "app")

        # merged into main, and pushed: safe
        add_worktree(app, wts / "merged", "feat/merged", push=True, commit_file="m.txt")
        add_worktree(app, wts / "merged2", "feat/merged2", push=True, commit_file="m2.txt")
        sh(["git", "merge", "-q", "feat/merged", "feat/merged2"], app)
        sh(["git", "push", "-q", "origin", "main"], app)
        # just created, nothing on it
        sh(["git", "worktree", "add", "-q", "-b", "feat/new", str(wts / "new")], app)
        # commits only here, uncommitted files, pushed but not merged
        add_worktree(app, wts / "unique", "feat/unique", commit_file="u.txt")
        add_worktree(app, wts / "dirty", "feat/dirty", push=True, commit_file="d.txt")
        (wts / "dirty" / "d.txt").write_text("wip\n")
        add_worktree(app, wts / "pushed", "feat/pushed", push=True, commit_file="p.txt")
        # upstream deleted after a squash merge: the commit is on no remote
        add_worktree(app, wts / "squash", "feat/squash", push=True, commit_file="s.txt")
        sh(["git", "push", "-q", "origin", "--delete", "feat/squash"], app)
        # the folder is gone
        add_worktree(app, wts / "lost", "feat/lost", push=True, commit_file="l.txt")
        shutil.rmtree(str(wts / "lost"))
        # an sdd work item's worktree, merged
        sdd = ws / ".claude" / "worktrees" / "77-thing" / "src" / "app"
        sdd.parent.mkdir(parents=True)
        add_worktree(app, sdd, "feat/77", push=True, commit_file="x.txt")
        sh(["git", "merge", "-q", "feat/77"], app)
        sh(["git", "push", "-q", "origin", "main"], app)
        # a branch with no worktree, merged
        sh(["git", "branch", "old/done"], app)

        run_cli(ws, "scan", "--fetch", "--fetch-batch", "10")
        state = json.loads(run_cli(ws, "status", "--json"))
        by = {Path(w["path"]).name: w for w in state["repos"]["app"]["worktrees"]}
        got = {k: v["class"] for k, v in by.items()}
        assert got == {"merged": "safe", "merged2": "safe", "new": "ok", "unique": "keep", "dirty": "keep",
                       "pushed": "ok", "squash": "review", "lost": "prune", "app": "safe"}, got
        assert by["app"]["owner"] == "sdd" and by["app"]["workItem"] == 77, by["app"]
        assert by["merged"]["reasons"] == ["merged into main"], by["merged"]
        assert "squash merge" in by["squash"]["reasons"][0] and len(by["squash"]["atRisk"]) == 1
        flags = state["repos"]["app"]["flags"]
        assert "removable-worktree" in flags and "old-worktree" in flags and "broken-worktree" in flags, flags
        assert state["summary"]["removable"] == 4 and state["summary"]["toReview"] == 1, state["summary"]

        # a plan changes nothing
        rc, plan = cli(ws, "plan", "remove-worktree", "--repo", "app", "--path", str(wts / "merged"), "--delete-branch")
        assert rc == 0 and plan["level"] == "safe" and len(plan["steps"]) == 2, plan
        assert plan["restore"][0].startswith("git branch feat/merged "), plan
        assert (wts / "merged").is_dir()

        # apply removes the worktree and the branch, and journals it
        rc, res = cli(ws, "apply", "remove-worktree", "--repo", "app", "--path", str(wts / "merged"), "--delete-branch")
        assert rc == 0 and res["ok"] and len(res["done"]) == 2, res
        assert not (wts / "merged").exists()
        assert git_out(app, "branch", "--list", "feat/merged") == ""
        lines = [json.loads(x) for x in (ws / ".claude" / "repowatch" / "journal.jsonl").read_text().splitlines()]
        assert [x["status"] for x in lines] == ["started", "done"] and lines[0]["restore"], lines
        state = json.loads(run_cli(ws, "status", "--json"))
        assert "merged" not in [Path(w["path"]).name for w in state["repos"]["app"]["worktrees"]]

        # undo puts the worktree and its branch back, once
        und = state["undoable"]
        assert len(und) == 1 and und[0]["branch"] == "feat/merged", und
        rc, plan = cli(ws, "plan", "undo", "--repo", "app", "--id", und[0]["id"])
        assert plan["level"] == "safe" and len(plan["steps"]) == 2, plan
        rc, res = cli(ws, "apply", "undo", "--repo", "app", "--id", und[0]["id"])
        assert rc == 0 and res["ok"] and (wts / "merged").is_dir(), res
        assert git_out(app, "branch", "--list", "feat/merged") != ""
        assert json.loads(run_cli(ws, "status", "--json"))["undoable"] == []
        assert cli(ws, "plan", "undo", "--repo", "app", "--id", und[0]["id"])[1]["level"] == "blocked"
        assert cli(ws, "plan", "undo", "--repo", "app", "--id", "nope")[1]["level"] == "blocked"

        # a worktree that became dirty after the plan is refused when applied
        rc, plan = cli(ws, "plan", "remove-worktree", "--repo", "app", "--path", str(wts / "merged2"))
        assert plan["level"] == "safe"
        (wts / "merged2" / "m2.txt").write_text("changed\n")
        rc, res = cli(ws, "apply", "remove-worktree", "--repo", "app", "--path", str(wts / "merged2"))
        assert rc == 2 and not res["ok"] and "uncommitted" in res["error"] and (wts / "merged2").is_dir(), res

        # work that exists only here is never removed, not even with --allow-review
        rc, res = cli(ws, "apply", "remove-worktree", "--repo", "app", "--path", str(wts / "unique"), "--allow-review")
        assert rc == 2 and (wts / "unique").is_dir() and "only here" in res["error"], res

        # review level needs the go-ahead, then it goes
        rc, res = cli(ws, "apply", "remove-worktree", "--repo", "app", "--path", str(wts / "squash"), "--delete-branch")
        assert rc == 2 and "--allow-review" in res["error"] and (wts / "squash").is_dir(), res
        rc, res = cli(ws, "apply", "remove-worktree", "--repo", "app", "--path", str(wts / "squash"), "--delete-branch", "--allow-review")
        assert rc == 0 and not (wts / "squash").exists(), res

        # sdd's worktrees are removed by sdd
        rc, plan = cli(ws, "plan", "remove-worktree", "--repo", "app", "--path", str(sdd))
        assert plan["level"] == "blocked" and plan["owner"] == "sdd" and plan["workItem"] == 77 and "env.py remove" in plan["blocked"][0], plan

        # a path that is not a worktree, and the main checkout
        assert cli(ws, "plan", "remove-worktree", "--repo", "app", "--path", str(wts / "nope"))[1]["level"] == "blocked"
        assert cli(ws, "plan", "remove-worktree", "--repo", "app", "--path", str(app))[1]["level"] == "blocked"

        # prune the lost folder
        rc, res = cli(ws, "apply", "prune-worktrees", "--repo", "app")
        assert rc == 0 and res["ok"], res
        assert cli(ws, "plan", "prune-worktrees", "--repo", "app")[1]["level"] == "blocked"

        # branches: merged is safe, checked out or unmerged work is not
        rc, plan = cli(ws, "plan", "delete-branch", "--repo", "app", "--branch", "old/done")
        assert plan["level"] == "safe", plan
        assert cli(ws, "plan", "delete-branch", "--repo", "app", "--branch", "feat/unique")[1]["level"] == "blocked"
        assert cli(ws, "plan", "delete-branch", "--repo", "app", "--branch", "main")[1]["level"] == "blocked"
        assert cli(ws, "plan", "delete-branch", "--repo", "app", "--branch", "feat/pushed")[1]["level"] == "blocked"
        rc, res = cli(ws, "apply", "delete-branch", "--repo", "app", "--branch", "old/done")
        assert rc == 0 and git_out(app, "branch", "--list", "old/done") == "", res
        assert cli(ws, "apply", "delete-branch", "--repo", "nope", "--branch", "x")[0] == 2


def test_forecast():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gitcfg = tmp / "gitconfig"
        gitcfg.write_text("[user]\n\tname = Dev\n\temail = dev@x.co\n[init]\n\tdefaultBranch = main\n")
        os.environ["GIT_CONFIG_GLOBAL"] = str(gitcfg)
        ws, origins, wts = tmp / "ws", tmp / "origins", tmp / "wts"
        for d in (ws, origins, wts, ws / ".claude"):
            d.mkdir()
        (ws / ".claude" / "sdd.json").write_text(json.dumps({"worktreeRoot": ".claude/worktrees"}))
        app = make_repo(ws, origins, "app")

        # branches cut from main, each with a change of its own
        add_worktree(app, wts / "clean", "feat/clean", commit_file="c.txt")
        add_worktree(app, wts / "conflict", "feat/conflict")
        (wts / "conflict" / "a.txt").write_text("branch\n")
        sh(["git", "commit", "-qam", "branch edit"], wts / "conflict")
        add_worktree(app, wts / "level", "feat/level")  # nothing of its own: cannot conflict
        # main moves on: a new file and an edit of a.txt
        commit(app, "b.txt")
        commit(app, "a.txt", "main\n", "main edit")
        sh(["git", "push", "-q", "origin", "main"], app)
        # a team branch an sdd work item was cut against
        sh(["git", "checkout", "-q", "-b", "team/1"], app)
        commit(app, "t.txt")
        sh(["git", "push", "-q", "-u", "origin", "team/1"], app)
        sh(["git", "checkout", "-q", "main"], app)
        item = ws / ".claude" / "worktrees" / "9-x"
        add_worktree(app, item / "src" / "app", "feat/9", commit_file="z.txt")
        (item / "workitem.json").write_text(json.dumps({"repos": {"app": {"base": "team/1", "path": "src/app"}}}))
        # a repo whose local and remote branches diverged on one file
        div = make_repo(ws, origins, "div")
        other = tmp / "other"
        sh(["git", "clone", "-q", str(origins / "div.git"), str(other)], tmp)
        commit(other, "a.txt", "theirs\n", "remote edit")
        sh(["git", "push", "-q", "origin", "main"], other)
        commit(div, "a.txt", "mine\n", "local edit")

        run_cli(ws, "scan", "--fetch", "--fetch-batch", "10")
        state = json.loads(run_cli(ws, "status", "--json"))
        by = {Path(w["path"]).name: w for w in state["repos"]["app"]["worktrees"]}
        assert by["clean"]["forecast"]["state"] == "clean" and by["clean"]["behindBase"] == 2 and by["clean"]["aheadBase"] == 1, by["clean"]
        assert by["conflict"]["forecast"]["state"] == "conflict" and by["conflict"]["forecast"]["files"] == ["a.txt"], by["conflict"]
        assert "forecast" not in by["level"] and by["level"]["aheadBase"] == 0, by["level"]
        assert by["app"]["baseRef"] == "origin/team/1" and by["app"]["forecast"]["state"] == "clean", by["app"]
        assert by["app"]["behindBase"] == 1 and by["app"]["aheadBase"] == 1
        assert state["repos"]["div"]["forecast"]["state"] == "conflict" and "will-conflict" in state["repos"]["div"]["flags"]
        assert "will-conflict" in state["repos"]["app"]["flags"], state["repos"]["app"]["flags"]
        assert state["summary"]["conflicts"] == 2, state["summary"]

        # a forecast is reused until a branch moves
        w = by["conflict"]
        again = rw.forecast(w["path"], w["sha"], "origin/main", w["forecast"])
        assert again is w["forecast"]
        commit(wts / "conflict", "extra.txt")
        moved = rw.forecast(w["path"], rw.rev(w["path"], "HEAD"), "origin/main", w["forecast"])
        assert moved is not w["forecast"] and moved["state"] == "conflict"
        # a merge that is fixed stops being a conflict
        sh(["git", "merge", "-q", "-X", "theirs", "origin/main"], wts / "conflict")
        run_cli(ws, "scan", "--only", "app")
        by = {Path(x["path"]).name: x for x in json.loads(run_cli(ws, "status", "--json"))["repos"]["app"]["worktrees"]}
        assert "forecast" not in by["conflict"] and by["conflict"]["behindBase"] == 0, by["conflict"]


def test_sync():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        gitcfg = tmp / "gitconfig"
        gitcfg.write_text("[user]\n\tname = Dev\n\temail = dev@x.co\n[init]\n\tdefaultBranch = main\n")
        os.environ["GIT_CONFIG_GLOBAL"] = str(gitcfg)
        ws, origins = tmp / "ws", tmp / "origins"
        for d in (ws, origins, ws / ".claude"):
            d.mkdir()
        (ws / ".claude" / "repowatch.json").write_text("{}")
        app = make_repo(ws, origins, "app")
        make_repo(ws, origins, "solo")  # a repo with no team chain

        def branch_from(name, base):
            sh(["git", "checkout", "-q", "-b", name, base], app)
            sh(["git", "push", "-q", "-u", "origin", name], app)

        sh(["git", "checkout", "-q", "-b", "team/0.0.1"], app)
        commit(app, "shared.txt", "one\n")
        sh(["git", "push", "-q", "-u", "origin", "team/0.0.1"], app)
        branch_from("team/0.0.2", "team/0.0.1")
        branch_from("team/0.0.10", "team/0.0.2")
        sh(["git", "checkout", "-q", "team/0.0.2"], app)
        commit(app, "shared.txt", "two\n", "own change on 0.0.2")  # makes the hop conflict later
        sh(["git", "push", "-q", "origin", "team/0.0.2"], app)

        # fixes on the oldest branch
        sh(["git", "checkout", "-q", "team/0.0.1"], app)
        commit(app, "a1.txt", "1\n", "Fix the thing\n\nRelated work items: #4471, #4472")
        commit(app, "a2.txt", "2\n", "More of the thing AB#4471")
        commit(app, "b.txt", "b\n", "Other fix ADO 5000")
        commit(app, "c.txt", "c\n", "No id at all")
        commit(app, "shared.txt", "fixed\n", "Fix shared ADO 6000")
        sh(["git", "push", "-q", "origin", "team/0.0.1"], app)
        shas = {m: git_out(app, "log", "--format=%H", "-1", "--grep", m) for m in ("ADO 5000", "No id at all", "ADO 6000")}
        # ADO 5000 was already taken to 0.0.2 by cherry-pick: a different sha, the same patch
        sh(["git", "checkout", "-q", "team/0.0.2"], app)
        sh(["git", "cherry-pick", shas["ADO 5000"]], app)
        sh(["git", "push", "-q", "origin", "team/0.0.2"], app)
        sh(["git", "checkout", "-q", "main"], app)
        sh(["git", "fetch", "-q"], app)

        run_cli(ws, "sync")
        sync = json.loads(run_cli(ws, "status", "--json"))["sync"]
        assert list(sync["repos"]) == ["app"], sync["repos"].keys()  # solo has no chain
        r = sync["repos"]["app"]
        assert r["branches"] == ["team/0.0.1", "team/0.0.2", "team/0.0.10"], r["branches"]
        h1, h2 = r["hops"]
        assert (h1["from"], h1["to"]) == ("team/0.0.1", "team/0.0.2") and (h2["from"], h2["to"]) == ("team/0.0.2", "team/0.0.10")
        assert h1["missing"] == 4 and h1["applied"] == 1 and h1["skipped"] == 0, h1
        keys = [f["key"] for f in h1["fixes"]]
        assert {"ADO 6000", "ADO 4471"} <= set(keys) and len(keys) == 3, keys
        by = {f["key"]: f for f in h1["fixes"]}
        assert len(by["ADO 4471"]["commits"]) == 2 and by["ADO 4471"]["workItems"] == [4471, 4472], by["ADO 4471"]
        assert by["ADO 4471"]["title"] == "Fix the thing", by["ADO 4471"]["title"]
        assert "ADO 5000" not in by, "an applied fix is not listed"
        assert any(f["title"] == "No id at all" for f in h1["fixes"])
        assert h1["mode"] == "merge" and h1["forecast"]["state"] == "conflict" and h1["forecast"]["files"] == ["shared.txt"], h1
        # 0.0.10 was cut before 0.0.2 gained two commits, so that hop has work too (and merges cleanly)
        assert h2["missing"] == 2 and h2["forecast"]["state"] == "clean", h2
        assert {f["key"] for f in h2["fixes"]} == {"ADO 5000", h2["fixes"][1]["key"]}
        assert sync["summary"] == {"repos": 1, "hopsPending": 2, "fixesPending": 5, "conflictHops": 1}, sync["summary"]

        # a commit marked "do not take" is skipped and the hop becomes a cherry-pick hop
        (ws / ".claude" / "repowatch" / "sync.json").write_text(json.dumps(
            {"app": {"team/0.0.1>team/0.0.2": {"skipped": {shas["No id at all"]: "belongs to 0.0.1 only"}}}}))
        run_cli(ws, "sync")
        h1 = json.loads(run_cli(ws, "status", "--json"))["sync"]["repos"]["app"]["hops"][0]
        assert h1["missing"] == 3 and h1["skipped"] == 1 and h1["mode"] == "cherry-pick", h1
        skipped = [f for f in h1["fixes"] if f["state"] == "skipped"]
        assert len(skipped) == 1 and skipped[0]["commits"][0]["reason"] == "belongs to 0.0.1 only", skipped

        # once the older branch is merged into the newer one, nothing is missing
        sh(["git", "checkout", "-q", "team/0.0.2"], app)
        sh(["git", "merge", "-q", "-X", "theirs", "origin/team/0.0.1", "-m", "sync"], app)
        sh(["git", "push", "-q", "origin", "team/0.0.2"], app)
        run_cli(ws, "sync")
        sync = json.loads(run_cli(ws, "status", "--json"))["sync"]
        assert sync["repos"]["app"]["hops"][0]["missing"] == 0 and sync["summary"]["hopsPending"] == 1, sync["summary"]

        # version order, not text order
        assert sorted(["team/0.0.10", "team/0.0.2", "team/0.1.0", "team/0.0.1"], key=rw.version_key) == \
            ["team/0.0.1", "team/0.0.2", "team/0.0.10", "team/0.1.0"]
        assert rw.work_items("x ADO 12", "Related work items: #7, #8") == [7, 8, 12]
        assert rw.work_items("Merged PR 5: t", "") == []


def git_out(repo, *args):
    return sh(["git"] + list(args), repo).stdout.strip()


def main():
    test_parsers()
    test_scan()
    test_worktrees()
    test_forecast()
    test_sync()
    print("ok")


if __name__ == "__main__":
    main()
