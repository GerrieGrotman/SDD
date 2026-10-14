"""Self-check for repowatch.py on real git repos in temp folders.

    python repowatch/scripts/test_repowatch.py      (needs git)
"""
import json
import os
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
        import shutil
        shutil.rmtree(str(ws / "gone"))
        run_cli(ws, "scan")
        assert "gone" not in json.loads(run_cli(ws, "status", "--json"))["repos"]
        assert "late" in run_cli(ws, "status")

        # a broken repo is reported, not raised
        broken = ws / "broken"
        (broken / ".git").mkdir(parents=True)
        run_cli(ws, "scan")
        assert json.loads(run_cli(ws, "status", "--json"))["repos"]["broken"]["flags"] == ["error"]


def main():
    test_parsers()
    test_scan()
    print("ok")


if __name__ == "__main__":
    main()
