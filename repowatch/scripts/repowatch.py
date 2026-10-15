"""repowatch: keep track of many git repos and their worktrees. Mechanics only; the mod draws it.

    python repowatch.py scan [--fetch] [--fetch-batch N] [--only NAME ...] [--json]
    python repowatch.py status [--json]
    python repowatch.py plan  remove-worktree|prune-worktrees|delete-branch --repo NAME [--path P] [--branch B] [--delete-branch]
    python repowatch.py apply <same arguments> [--allow-review]
    python repowatch.py plan|apply undo --repo NAME --id ID      (ID from `status --json` "undoable")
    python repowatch.py sync [--only NAME ...] [--json]
    python repowatch.py plan|apply sync-hop|sync-finish|sync-abort --repo NAME --hop OLDER:NEWER
    python repowatch.py plan|apply sync-skip|sync-unskip --repo NAME --hop OLDER:NEWER --sha SHA [--reason TEXT]

`scan` reads each repo's local facts (branch, ahead/behind, dirty files, stashes, worktrees) and
writes them to <workspace>/.claude/repowatch/state.json. With --fetch it also fetches the repos that
were fetched longest ago, a few at a time, so a sweep of dozens of repos is spread over many scans
and never stalls. It never pulls, merges or checks out anything.

Merge-conflict forecast: for each worktree (and each diverged repo) `scan` asks git, with
`merge-tree --write-tree`, whether merging the base branch in would conflict, and in which files. No
checkout, no change. The base is the work item's base from sdd's workitem.json, else the default
branch. Results are cached by the two shas, so they are only recomputed when a branch moves.
Needs git 2.38; older git says "unavailable".

Branch sync (read-only): in each repo with two or more `team/*` branches on origin (`syncPattern`),
`sync` sorts them by version (0.0.2 before 0.0.10) and, for each hop from one to the next newer one,
lists the commits the newer one lacks, grouped into fixes by the ADO id in the message. A commit whose
patch is already there under another sha counts as applied; one you marked "do not take" in
.claude/repowatch/sync.json counts as skipped. It also forecasts whether merging the older branch into
the newer one would conflict. Written to .claude/repowatch/sync-state.json and merged into `status --json`.

Branch sync actions: `sync-hop` makes sync/<older version>-<newer version> from the newer branch in a
worktree under .claude/repowatch/sync/, merges the older branch in (or, once a commit was skipped,
cherry-picks the wanted commits oldest first with -x), pushes that branch and opens an ADO pull request
into the newer branch. It never pushes to the newer branch. On a conflict it stops and leaves the
worktree for someone to resolve; `sync-finish` then checks the work is complete, pushes and opens the
PR; `sync-abort` throws the attempt away. `sync-skip` records "do not take this commit" in
.claude/repowatch/sync.json. The PR needs `az login`; REPOWATCH_FAKE_PR=<file> stands in for ADO in tests.

`plan` shows what a clean-up would do and what it checks first. `apply` checks again against the
live repo, runs it, and writes .claude/repowatch/journal.jsonl (with the sha, so a deleted branch can
be recreated). Nothing is removed that has uncommitted files or commits that exist on no remote,
unless `apply` is given --allow-review and the plan was at level "review".

Workspace: the first folder up from the current one that holds .claude/repowatch.json or
.claude/sdd.json, else the current folder. Repos: "repos" in repowatch.json, else "repoDirs" in
sdd.json, else every folder up to two levels down that holds a .git folder.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STATE_REL = Path(".claude") / "repowatch" / "state.json"
CONFIG_NAMES = ("repowatch.json", "sdd.json")
VERSION = 1
DEFAULTS = {
    "repos": [],          # explicit repo folders (relative to the workspace); empty = discover
    "workers": 8,         # repos scanned at once
    "fetchWorkers": 4,    # repos fetched at once
    "fetchBatch": 4,      # repos fetched per `scan --fetch`
    "fetchTimeout": 120,  # seconds before one fetch is given up
    "staleFetchHours": 24,
    "staleWorktreeDays": 30,
    "syncPattern": "team/*",   # the branches whose fixes carry forward, old to new; one trailing *
    "syncWindowDays": 180,     # commits older than this are not listed
    "syncMaxFixes": 200,       # fixes listed per hop
}
JOURNAL_REL = Path(".claude") / "repowatch" / "journal.jsonl"
SYNC_STATE_REL = Path(".claude") / "repowatch" / "sync-state.json"
SYNC_DECISIONS_REL = Path(".claude") / "repowatch" / "sync.json"
SKIP_DIRS = {".claude", "node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", "bin", "obj"}


# --- git ---------------------------------------------------------------------------------------

def git(args, cwd, timeout=60):
    """(returncode, stdout, stderr). Never prompts for a password and never raises."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    try:
        r = subprocess.run(["git"] + list(args), cwd=str(cwd), capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after %ds" % timeout
    except OSError as e:
        return 127, "", str(e)
    return r.returncode, r.stdout, r.stderr.strip()


def posix(p):
    return str(p).replace("\\", "/")


# --- workspace and config --------------------------------------------------------------------

def find_workspace(start=None):
    here = Path(start or os.getcwd()).resolve()
    for d in [here] + list(here.parents):
        if any((d / ".claude" / n).is_file() for n in CONFIG_NAMES):
            return d
    return here


def load_config(root):
    cfg = dict(DEFAULTS)
    sdd = _read_json(root / ".claude" / "sdd.json")
    if isinstance(sdd.get("repoDirs"), list) and sdd["repoDirs"]:
        cfg["repos"] = list(sdd["repoDirs"])
    own = _read_json(root / ".claude" / "repowatch.json")
    for k in DEFAULTS:
        if k in own:
            cfg[k] = own[k]
    # where sdd keeps its work item worktrees: those are removed by sdd, not here
    cfg["sddWorktrees"] = posix((root / str(sdd.get("worktreeRoot") or ".claude/worktrees")).resolve())
    cfg["syncWorktrees"] = posix((root / ".claude" / "repowatch" / "sync").resolve())
    return cfg


def _read_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def is_main_repo(path):
    """A folder with its own .git directory (a linked worktree has a .git file, so it is not one)."""
    return (path / ".git").is_dir()


def discover(root, cfg):
    """[(name, path)] of the repos to watch, sorted by name."""
    found = []
    if cfg["repos"]:
        for d in cfg["repos"]:
            p = (root / d).resolve()
            if (p / ".git").exists():
                found.append(p)
    else:
        if is_main_repo(root):
            found.append(root)
        for child in _subdirs(root):
            if is_main_repo(child):
                found.append(child)
            else:
                found.extend(g for g in _subdirs(child) if is_main_repo(g))
    names, out = {}, []
    for p in sorted(set(found), key=lambda x: posix(x).lower()):
        name = p.name
        if name in names:  # two folders with one name: add the parent
            name = "%s/%s" % (p.parent.name, p.name)
        names[name] = p
        out.append((name, p))
    return out


def _subdirs(path):
    try:
        return sorted(c for c in path.iterdir() if c.is_dir() and c.name not in SKIP_DIRS and not c.name.startswith("."))
    except OSError:
        return []


# --- reading one repo --------------------------------------------------------------------------

def parse_status(text):
    """Counts and branch facts from `git status --porcelain=v2 --branch`."""
    out = {"branch": None, "detached": False, "upstream": None, "ahead": 0, "behind": 0,
           "staged": 0, "unstaged": 0, "untracked": 0, "conflicted": 0}
    for line in text.splitlines():
        if line.startswith("# branch.head "):
            head = line[len("# branch.head "):]
            out["detached"] = head == "(detached)"
            out["branch"] = None if out["detached"] else head
        elif line.startswith("# branch.upstream "):
            out["upstream"] = line[len("# branch.upstream "):]
        elif line.startswith("# branch.ab "):
            m = re.match(r"# branch\.ab \+(\d+) -(\d+)", line)
            if m:
                out["ahead"], out["behind"] = int(m.group(1)), int(m.group(2))
        elif line.startswith(("1 ", "2 ")):
            xy = line.split(" ", 2)[1]
            if xy[0] != ".":
                out["staged"] += 1
            if xy[1] != ".":
                out["unstaged"] += 1
        elif line.startswith("u "):
            out["conflicted"] += 1
        elif line.startswith("? "):
            out["untracked"] += 1
    out["dirty"] = out["staged"] + out["unstaged"] + out["untracked"] + out["conflicted"]
    return out


def parse_track(track):
    """`[ahead 1, behind 2]` / `[gone]` / `` from for-each-ref's %(upstream:track)."""
    if track == "[gone]":
        return 0, 0, True
    a = re.search(r"ahead (\d+)", track)
    b = re.search(r"behind (\d+)", track)
    return (int(a.group(1)) if a else 0), (int(b.group(1)) if b else 0), False


def parse_worktrees(text):
    """[{path, head, branch, detached, bare, locked, prunable}] from `git worktree list --porcelain`."""
    out, cur = [], None
    for line in text.splitlines() + [""]:
        if not line.strip():
            if cur:
                out.append(cur)
            cur = None
            continue
        key, _, val = line.partition(" ")
        if key == "worktree":
            cur = {"path": val, "head": "", "branch": None, "detached": False, "bare": False,
                   "locked": False, "prunable": False}
        elif cur is not None:
            if key == "HEAD":
                cur["head"] = val[:12]
            elif key == "branch":
                cur["branch"] = val[len("refs/heads/"):] if val.startswith("refs/heads/") else val
            elif key in ("detached", "bare", "locked", "prunable"):
                cur[key] = True
    return out


def default_branch(path):
    rc, out, _ = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], path)
    if rc == 0 and out.strip():
        return out.strip().split("/", 1)[-1]
    for cand in ("main", "master", "develop"):
        if git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/" + cand], path)[0] == 0:
            return cand
    return None


def fetch_time(path):
    """When the repo was last fetched (epoch seconds), from FETCH_HEAD; None = never."""
    rc, out, _ = git(["rev-parse", "--git-common-dir"], path)
    if rc != 0:
        return None
    gd = Path(out.strip())
    gd = gd if gd.is_absolute() else Path(path) / gd
    try:
        return int((gd / "FETCH_HEAD").stat().st_mtime)
    except OSError:
        return None


def branch_info(path):
    """(number of local branches, [branches whose upstream is gone])."""
    gone, count = [], 0
    rc, out, _ = git(["for-each-ref", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)", "refs/heads"], path)
    if rc == 0:
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            count += 1
            if parse_track(parts[2])[2]:
                gone.append(parts[0])
    return count, gone


def owner_of(path, cfg):
    """('sdd', work item id) under sdd's worktree root, ('sync', None) under a branch sync's, else (None, None)."""
    base = cfg.get("sddWorktrees")
    p = posix(Path(path).resolve())
    if base and p.lower().startswith(base.lower() + "/"):
        m = re.match(r"(\d+)-", p[len(base) + 1:])
        return "sdd", (int(m.group(1)) if m else None)
    sync = cfg.get("syncWorktrees")
    if sync and p.lower().startswith(sync.lower() + "/"):
        return "sync", None
    return None, None


def unique_commits(path, default):
    """(commits on no remote branch, [subjects of the newest few]). Commits whose patch the default
    branch already has (a cherry-pick or rebase) do not count."""
    rc, out, _ = git(["rev-list", "--count", "HEAD", "--not", "--remotes"], path)
    n = int(out.strip()) if rc == 0 and out.strip().isdigit() else 0
    if n == 0:
        return 0, []
    if default:
        rc, out, _ = git(["cherry", "origin/" + default, "HEAD"], path)
        if rc == 0 and not any(line.startswith("+") for line in out.splitlines()):
            return 0, []
    rc, out, _ = git(["log", "--format=%h %s", "-5", "HEAD", "--not", "--remotes"], path)
    return n, out.splitlines() if rc == 0 else []


def is_fresh(repo, branch):
    """True when nothing was ever done on the branch since it was created (its reflog has one entry)."""
    if not branch:
        return False
    rc, out, _ = git(["reflog", "show", "--format=%gs", "refs/heads/" + branch], repo)
    return rc == 0 and 0 < len(out.splitlines()) <= 1


def sdd_base(wt_path, cfg):
    """The base branch sdd recorded for a work item's worktree (workitem.json), or None."""
    base = cfg.get("sddWorktrees")
    p = posix(Path(wt_path).resolve())
    if not base or not p.lower().startswith(base.lower() + "/"):
        return None
    folder = Path(base) / p[len(base) + 1:].split("/")[0]
    for r in (_read_json(folder / "workitem.json").get("repos") or {}).values():
        if isinstance(r, dict) and r.get("path") and posix((folder / r["path"]).resolve()).lower() == p.lower():
            return r.get("base") or None
    return None


def rev(path, ref):
    rc, out, _ = git(["rev-parse", "--verify", "--quiet", ref], path)
    return out.strip() if rc == 0 else ""


def forecast(path, head_sha, base_ref, prev=None):
    """Would merging base_ref into head_sha conflict? {state: clean|conflict|unavailable|error, files, ...}.
    Reuses `prev` when neither sha moved."""
    base_sha = rev(path, base_ref)
    res = {"base": base_ref, "sha": head_sha, "baseSha": base_sha}
    if not base_sha:
        return dict(res, state="error", error="no such branch: " + base_ref)
    if prev and prev.get("sha") == head_sha and prev.get("baseSha") == base_sha and prev.get("state") in ("clean", "conflict"):
        return prev
    rc, out, err = git(["merge-tree", "--write-tree", "--name-only", "--no-messages", head_sha, base_sha], path)
    if rc == 0:
        return dict(res, state="clean", files=[])
    if rc == 1:
        files = []
        for line in out.splitlines()[1:]:
            if not line.strip():
                break
            files.append(line.strip())
        return dict(res, state="conflict", files=files[:20])
    if rc == 129 or "write-tree" in err or "usage" in err.lower():
        return dict(res, state="unavailable")
    return dict(res, state="error", error=err.splitlines()[-1] if err else "merge-tree failed")


def classify(f, cfg, now):
    """(class, reasons) of a worktree from its facts. Classes:
    safe: nothing is lost by removing it. review: probably done, a person should look. keep: has work
    that exists only here. ok: in use, nothing to do. prune: git lists a folder that is gone."""
    days = lambda t: int((now - t) / 86400) if t else 0
    stale = cfg["staleWorktreeDays"]
    if f.get("missing") or f.get("prunable"):
        return "prune", ["the folder is gone; git still lists it"]
    if f.get("dirty"):
        return "keep", ["%d uncommitted file%s" % (f["dirty"], "" if f["dirty"] == 1 else "s")]
    if f.get("isDefault"):
        return "ok", ["on the default branch"]
    if f.get("locked"):
        return "keep", ["locked"]
    if f.get("fresh"):
        age = days(f.get("created"))
        if age > stale:
            return "review", ["created %d days ago and nothing committed on it" % age]
        return "ok", ["new, nothing committed yet"]
    n = f.get("unique", 0)
    if f.get("detached"):
        return ("keep", ["detached HEAD with %d commit%s only here" % (n, "" if n == 1 else "s")]) if n else \
               ("review", ["detached HEAD"])
    if n:
        if f.get("gone"):
            return "review", ["its upstream branch was deleted and %d commit%s are on no remote (a squash merge?)"
                              % (n, "" if n == 1 else "s")]
        return "keep", ["%d commit%s only here" % (n, "" if n == 1 else "s")]
    if f.get("merged"):
        return "safe", ["merged into %s" % f.get("defaultBranch")]
    if f.get("gone"):
        return "safe", ["its upstream branch was deleted and everything is on a remote"]
    last = f.get("lastCommit")
    if last and days(last) > stale:
        return "review", ["no commits for %d days" % days(last)]
    return "ok", []


def worktree_facts(repo, wt, default, gone, cfg, now, prev=None):
    """Everything known about one linked worktree, with its class."""
    p = Path(wt["path"])
    info = {"path": posix(wt["path"]), "branch": wt["branch"], "head": wt["head"], "detached": wt["detached"],
            "locked": wt["locked"], "prunable": wt["prunable"], "missing": not p.is_dir()}
    owner, item = owner_of(wt["path"], cfg)
    if owner:
        info["owner"], info["workItem"] = owner, item
    if not info["missing"]:
        rc, out, _ = git(["status", "--porcelain=v2", "--branch"], p)
        if rc == 0:
            s = parse_status(out)
            info.update(dirty=s["dirty"], ahead=s["ahead"], behind=s["behind"], upstream=s["upstream"])
        rc, out, _ = git(["log", "-1", "--format=%ct"], p)
        if rc == 0 and out.strip().isdigit():
            info["lastCommit"] = int(out.strip())
        rc, out, _ = git(["rev-parse", "HEAD"], p)
        info["sha"] = out.strip() if rc == 0 else ""
        info["unique"], info["atRisk"] = unique_commits(p, default)
        info["merged"] = bool(default) and git(["merge-base", "--is-ancestor", "HEAD", "origin/" + default], p)[0] == 0
        try:
            info["created"] = int((p / ".git").stat().st_mtime)
        except OSError:
            pass
    if not info["missing"] and info.get("sha") and not wt["detached"]:
        base = sdd_base(wt["path"], cfg) or default
        ref = "origin/" + base if base else ""
        if ref and rev(wt["path"], "refs/remotes/" + ref):
            info["baseRef"] = ref
            rc, out, _ = git(["rev-list", "--left-right", "--count", ref + "...HEAD"], wt["path"])
            nums = out.split()
            if rc == 0 and len(nums) == 2:
                info["behindBase"], info["aheadBase"] = int(nums[0]), int(nums[1])
                # a branch with nothing of its own, or a base with nothing new, cannot conflict
                if info["behindBase"] and info["aheadBase"]:
                    info["forecast"] = forecast(wt["path"], info["sha"], ref, (prev or {}).get("forecast"))
    info["gone"] = bool(wt["branch"]) and wt["branch"] in gone
    info["isDefault"] = bool(default) and wt["branch"] == default
    info["fresh"] = is_fresh(repo, wt["branch"])
    info["defaultBranch"] = default
    info["class"], info["reasons"] = classify(info, cfg, now)
    return info


def scan_repo(name, path, cfg, now=None, prev=None):
    """Everything the pane shows about one repo. Never raises: a failure is recorded in `error`."""
    now = int(now or time.time())
    rec = {"name": name, "path": posix(path), "scannedAt": now}
    rc, out, err = git(["status", "--porcelain=v2", "--branch"], path)
    if rc != 0:
        rec["error"] = err or "git status failed"
        rec["flags"] = ["error"]
        return rec
    s = parse_status(out)
    rec.update({k: s[k] for k in ("branch", "detached", "upstream", "ahead", "behind", "staged", "unstaged",
                                  "untracked", "conflicted", "dirty")})
    rec["defaultBranch"] = default_branch(path)
    rec["lastFetch"] = fetch_time(path)
    rc, out, _ = git(["stash", "list"], path)
    rec["stashes"] = len(out.splitlines()) if rc == 0 else 0
    rec["branches"], rec["goneBranches"] = branch_info(path)

    rc, out, _ = git(["worktree", "list", "--porcelain"], path)
    wts = parse_worktrees(out) if rc == 0 else []
    mine = posix(Path(path).resolve())
    others = [w for w in wts if posix(Path(w["path"]).resolve()) != mine and not w["bare"]]
    before = {w["path"]: w for w in (prev or {}).get("worktrees", [])}
    rec["worktrees"] = [worktree_facts(path, w, rec["defaultBranch"], rec["goneBranches"], cfg, now,
                                       before.get(posix(w["path"]))) for w in others]
    if rec.get("ahead") and rec.get("behind") and rec.get("upstream") and not rec.get("detached"):
        head = rev(path, "HEAD")
        if head:
            rec["forecast"] = forecast(path, head, rec["upstream"], (prev or {}).get("forecast"))
    rec["flags"] = flags_for(rec, cfg, now)
    return rec


def flags_for(rec, cfg, now):
    """Short words for what needs a person's eye. Empty = nothing to do."""
    f = []
    if rec.get("conflicted"):
        f.append("conflicted")
    if rec.get("dirty"):
        f.append("dirty")
    if rec.get("detached"):
        f.append("detached")
    if rec.get("ahead") and rec.get("behind"):
        f.append("diverged")
    elif rec.get("behind"):
        f.append("behind")
    elif rec.get("ahead"):
        f.append("unpushed")
    if rec.get("branch") and not rec.get("upstream"):
        f.append("no-upstream")
    if rec.get("goneBranches"):
        f.append("gone-branches")
    last = rec.get("lastFetch")
    if last is None or now - last > cfg["staleFetchHours"] * 3600:
        f.append("stale-fetch")
    classes = [w.get("class") for w in rec.get("worktrees", [])]
    if "prune" in classes:
        f.append("broken-worktree")
    if "safe" in classes:
        f.append("removable-worktree")
    if "review" in classes:
        f.append("old-worktree")
    if (rec.get("forecast") or {}).get("state") == "conflict" or \
            any((w.get("forecast") or {}).get("state") == "conflict" for w in rec.get("worktrees", [])):
        f.append("will-conflict")
    return f


# --- state ---------------------------------------------------------------------------------------

def read_state(root):
    st = _read_json(root / STATE_REL)
    if st.get("version") != VERSION or not isinstance(st.get("repos"), dict):
        return {"version": VERSION, "generated": 0, "repos": {}}
    return st


def write_state(root, state):
    path = root / STATE_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def wcount(recs, *classes):
    return sum(1 for r in recs for w in r.get("worktrees", []) if w.get("class") in classes)


def summarize(repos):
    """Counts for the status line."""
    recs = list(repos.values())
    count = lambda flag: sum(1 for r in recs if flag in r.get("flags", []))
    return {
        "repos": len(recs),
        "attention": sum(1 for r in recs if set(r.get("flags", [])) - {"stale-fetch"}),
        "behind": count("behind") + count("diverged"),
        "dirty": count("dirty") + count("conflicted"),
        "unpushed": count("unpushed") + count("diverged"),
        "worktrees": sum(len(r.get("worktrees", [])) for r in recs),
        "removable": wcount(recs, "safe", "prune"),
        "toReview": wcount(recs, "review"),
        "conflicts": sum(1 for r in recs for x in [r] + r.get("worktrees", []) if (x.get("forecast") or {}).get("state") == "conflict"),
        "errors": count("error"),
    }


def pick_for_fetch(repos, batch):
    """The `batch` repos fetched longest ago (never fetched first)."""
    return sorted(repos, key=lambda r: (r.get("lastFetch") or 0, r["name"]))[:max(0, batch)]


def fetch_repo(rec, cfg):
    rc, _, err = git(["fetch", "--prune", "--no-tags", "origin"], rec["path"], timeout=cfg["fetchTimeout"])
    return rec["name"], (None if rc == 0 else (err.splitlines()[-1] if err else "fetch failed"))


# --- actions: plan, then apply ------------------------------------------------------------------
#
# A plan is built from the live repo, never from state.json, and `apply` builds it again before it
# runs anything, so a repo that changed since the person looked is caught. Levels:
#   safe     nothing is lost
#   review   something is probably done, but a commit may exist only here (listed in atRisk)
#   blocked  not offered: uncommitted files, commits only here, owned by sdd, checked out, not found

SYNC_ACTIONS = ("sync-hop", "sync-finish", "sync-abort", "sync-skip", "sync-unskip")
ACTIONS = ("remove-worktree", "prune-worktrees", "delete-branch", "undo") + SYNC_ACTIONS


def find_repo(root, cfg, name):
    for n, p in discover(root, cfg):
        if n == name:
            return p
    return None


def show(step):
    return " ".join('"%s"' % a if re.search(r"\s", a) else a for a in step)


def read_journal(root):
    out = []
    try:
        for line in (root / JOURNAL_REL).read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def undoable(root, limit=5):
    """The newest finished clean-ups that can be put back, newest first, not yet undone."""
    entries = read_journal(root)
    undone = {e.get("of") for e in entries if e.get("status") == "undone"}
    keep = [e for e in entries if e.get("status") == "done" and e.get("restoreSteps") and e.get("id") not in undone]
    keep.sort(key=lambda e: e.get("at", 0), reverse=True)
    return [{k: e.get(k) for k in ("id", "at", "action", "repo", "path", "branch")} for e in keep[:limit]]


def plan_for(action, repo, args, cfg, now, root=None):
    """The plan dict for one action on one repo (see above). Never runs anything that changes the repo."""
    plan = {"action": action, "repo": args.repo, "path": None, "branch": None, "level": "blocked",
            "blocked": [], "reasons": [], "atRisk": [], "steps": [], "restore": [], "restoreSteps": []}
    if action in SYNC_ACTIONS:
        return plan_sync(plan, repo, args, cfg, now, root)
    default = default_branch(repo)
    _, gone = branch_info(repo)

    if action == "prune-worktrees":
        rc, out, _ = git(["worktree", "list", "--porcelain"], repo)
        broken = [w for w in parse_worktrees(out) if w["prunable"] or not Path(w["path"]).is_dir()] if rc == 0 else []
        if not broken:
            plan["blocked"].append("no worktree is broken")
            return plan
        plan["level"] = "safe"
        plan["reasons"] = ["git lists %d worktree folder%s that no longer exist" % (len(broken), "" if len(broken) == 1 else "s")]
        plan["steps"] = [["git", "worktree", "prune"]]
        return plan

    if action == "remove-worktree":
        want = posix(Path(args.path or "").resolve()) if args.path else ""
        rc, out, _ = git(["worktree", "list", "--porcelain"], repo)
        found = [w for w in parse_worktrees(out) if posix(Path(w["path"]).resolve()) == want] if rc == 0 else []
        if not found or posix(Path(repo).resolve()) == want:
            plan["blocked"].append("not a linked worktree of this repo")
            return plan
        f = worktree_facts(repo, found[0], default, gone, cfg, now)
        plan.update(path=f["path"], branch=f["branch"], reasons=f["reasons"], atRisk=f["atRisk"])
        if f.get("owner") == "sdd":
            plan["owner"], plan["workItem"] = "sdd", f.get("workItem")
            plan["blocked"].append("sdd owns this worktree: remove it with env.py remove --id %s, which also closes the work item's record"
                                   % f.get("workItem"))
            return plan
        if f.get("owner") == "sync":
            plan["owner"] = "sync"
            plan["blocked"].append("a branch sync owns this worktree: finish or abort it in the Sync view")
            return plan
        if f["class"] == "keep":
            plan["blocked"] = list(f["reasons"])
            return plan
        if f["class"] == "prune":
            plan["level"] = "safe"
            plan["steps"] = [["git", "worktree", "prune"]]
            return plan
        plan["level"] = "safe" if f["class"] == "safe" else "review"
        if f["class"] == "ok":
            plan["reasons"] = plan["reasons"] or ["in use: nothing says it is finished"]
        steps = [["git", "worktree", "remove", f["path"]]]
        if args.delete_branch and f["branch"] and not f["isDefault"] and not f["detached"]:
            steps.append(["git", "branch", "-D", f["branch"]])
        plan["steps"] = steps
        if f["branch"] and f.get("sha"):
            if len(steps) > 1:
                plan["restoreSteps"].append(["git", "branch", f["branch"], f["sha"]])
            plan["restoreSteps"].append(["git", "worktree", "add", f["path"], f["branch"]])
        elif f.get("sha"):
            plan["restoreSteps"].append(["git", "worktree", "add", "--detach", f["path"], f["sha"]])
        plan["restore"] = [show(x) for x in plan["restoreSteps"]]
        return plan

    if action == "delete-branch":
        br = args.branch or ""
        plan["branch"] = br
        rc, out, _ = git(["rev-parse", "--verify", "--quiet", "refs/heads/" + br], repo)
        if rc != 0:
            plan["blocked"].append("no local branch %s" % br)
            return plan
        sha = out.strip()
        if br == default:
            plan["blocked"].append("%s is the default branch" % br)
            return plan
        rc, out, _ = git(["worktree", "list", "--porcelain"], repo)
        if any(w["branch"] == br for w in parse_worktrees(out)):
            plan["blocked"].append("%s is checked out in a worktree: remove the worktree first" % br)
            return plan
        rc, out, _ = git(["rev-list", "--count", br, "--not", "--remotes"], repo)
        n = int(out.strip()) if rc == 0 and out.strip().isdigit() else 0
        if n:
            rc, out, _ = git(["log", "--format=%h %s", "-5", br, "--not", "--remotes"], repo)
            plan["atRisk"] = out.splitlines() if rc == 0 else []
        merged = bool(default) and git(["merge-base", "--is-ancestor", br, "origin/" + default], repo)[0] == 0
        is_gone = br in gone
        if n and is_gone:
            plan["level"] = "review"
            plan["reasons"] = ["its upstream branch was deleted and %d commit%s are on no remote (a squash merge?)" % (n, "" if n == 1 else "s")]
        elif n:
            plan["blocked"].append("%d commit%s only here" % (n, "" if n == 1 else "s"))
            return plan
        elif merged:
            plan["level"], plan["reasons"] = "safe", ["merged into %s" % default]
        elif is_gone:
            plan["level"], plan["reasons"] = "safe", ["its upstream branch was deleted and everything is on a remote"]
        else:
            plan["level"], plan["reasons"] = "review", ["pushed but not merged: nothing says it is finished"]
        plan["steps"] = [["git", "branch", "-D", br]]
        plan["restoreSteps"] = [["git", "branch", br, sha]]
        plan["restore"] = [show(x) for x in plan["restoreSteps"]]
        return plan

    if action == "undo":
        plan["undoId"] = args.id
        entries = read_journal(root) if root else []
        done = [e for e in entries if e.get("id") == args.id and e.get("repo") == args.repo and e.get("status") == "done"]
        if not done or not done[-1].get("restoreSteps"):
            plan["blocked"].append("nothing to undo with that id")
            return plan
        if any(e.get("status") == "undone" and e.get("of") == args.id for e in entries):
            plan["blocked"].append("already undone")
            return plan
        e = done[-1]
        plan.update(path=e.get("path"), branch=e.get("branch"))
        steps = e["restoreSteps"]
        for st in steps:
            if st[1:2] == ["branch"] and rev(repo, "refs/heads/" + st[2]):
                plan["blocked"].append("branch %s exists again" % st[2])
            if st[1:3] == ["worktree", "add"] and Path(st[-2]).exists():
                plan["blocked"].append("%s exists again" % st[-2])
        if plan["blocked"]:
            return plan
        plan["level"] = "safe"
        plan["reasons"] = ["puts back what %s removed; ignored files such as build output are not restored" % e.get("action")]
        plan["steps"] = steps
        return plan

    plan["blocked"].append("unknown action %s" % action)
    return plan


def journal(root, entry):
    path = root / JOURNAL_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(str(path), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, sort_keys=True) + "\n")


def run_action(root, cfg, args, apply):
    action = args.action
    repo = find_repo(root, cfg, args.repo)
    if repo is None:
        print(json.dumps({"ok": False, "error": "no repo named %s" % args.repo}))
        return 2
    now = int(time.time())
    plan = plan_for(action, repo, args, cfg, now, root)
    if not apply:
        print(json.dumps(plan))
        return 0
    result = {"ok": False, "plan": plan, "done": []}
    if plan["level"] == "blocked":
        result["error"] = "not done: " + "; ".join(plan["blocked"])
    elif plan["level"] == "review" and not args.allow_review:
        result["error"] = "not done: this needs a person's go-ahead (--allow-review): " + "; ".join(plan["reasons"])
    else:
        entry = {"id": "%d" % int(time.time() * 1000), "at": now, "action": action, "repo": args.repo,
                 "path": plan["path"], "branch": plan["branch"], "level": plan["level"], "steps": plan["steps"],
                 "restore": plan["restore"], "restoreSteps": plan["restoreSteps"], "atRisk": plan["atRisk"]}
        journal(root, dict(entry, status="started"))
        if action in SYNC_ACTIONS:
            result.update(apply_sync(root, cfg, repo, args, plan, now))
        else:
            for step in plan["steps"]:
                rc, _, err = git(step[1:], repo, timeout=120)
                if rc != 0:
                    result["error"] = "%s failed: %s" % (" ".join(step), err or "exit %d" % rc)
                    break
                result["done"].append(step)
        result["ok"] = "error" not in result
        journal(root, dict(entry, status="done" if result["ok"] else "failed", error=result.get("error")))
        if result["ok"] and action == "undo":
            journal(root, {"at": now, "status": "undone", "of": args.id, "repo": args.repo})
        # bring the state up to date for this repo only
        state = read_state(root)
        state["repos"][args.repo] = scan_repo(args.repo, repo, cfg, now, state["repos"].get(args.repo))
        state["generated"] = now
        state["summary"] = summarize(state["repos"])
        state["undoable"] = undoable(root)
        write_state(root, state)
        if action in SYNC_ACTIONS:
            run_sync(root, cfg, [args.repo])
    print(json.dumps(result))
    return 0 if result["ok"] else 2


# --- branch sync: what each older team branch has that the next newer one lacks ----------------

def version_key(name):
    """Sort key so that team/0.0.2 comes before team/0.0.10."""
    rest = name.split("/", 1)[1] if "/" in name else name
    return [(0, int(t)) if t.isdigit() else (1, t) for t in re.findall(r"\d+|[A-Za-z]+", rest)]


def sync_prefix(cfg):
    p = cfg["syncPattern"]
    return p[:-1] if p.endswith("*") else p.rstrip("/") + "/"


def sync_branches(path, cfg):
    """The origin branches that match the sync pattern, oldest version first."""
    prefix = sync_prefix(cfg)
    rc, out, _ = git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/" + prefix], path)
    names = []
    if rc == 0:
        for line in out.splitlines():
            n = line[len("refs/remotes/origin/"):]
            if n and not n.endswith("/HEAD"):
                names.append(n)
    return sorted(names, key=version_key)


WORK_ITEM = re.compile(r"AB#(\d+)|\bADO\s+(\d+)", re.I)
RELATED = re.compile(r"Related work items?:?([^\n]*)", re.I)
MERGED_PR = re.compile(r"^Merged PR (\d+)", re.I)


def work_items(subject, body):
    """ADO ids named in a commit message: AB#n, ADO n, or the `Related work items: #n, #m` line."""
    ids = []
    for m in WORK_ITEM.finditer(subject + "\n" + body):
        ids.append(int(m.group(1) or m.group(2)))
    for m in RELATED.finditer(body):
        ids.extend(int(x) for x in re.findall(r"#?(\d+)", m.group(1)))
    return sorted(set(ids))


def read_decisions(root):
    return _read_json(root / SYNC_DECISIONS_REL)


def hop_commits(path, older, newer, cfg, now, skipped):
    """[(commit dict)] newest first: the commits `older` has that `newer` lacks, each applied, skipped or missing."""
    rc, out, _ = git(["cherry", "origin/" + newer, "origin/" + older], path, timeout=120)
    if rc != 0:
        return None, 0
    marks = {}
    for line in out.splitlines():
        if len(line) >= 42 and line[0] in "+-":
            marks[line[2:].strip()] = line[0]
    fmt = "%H%x1f%ct%x1f%an%x1f%s%x1f%b%x1e"
    rc, out, _ = git(["log", "--no-merges", "--format=" + fmt, "origin/%s" % older, "--not", "origin/%s" % newer], path, timeout=120)
    commits, outside = [], 0
    cutoff = now - cfg["syncWindowDays"] * 86400
    for rec in (out.split("\x1e") if rc == 0 else []):
        parts = rec.strip("\n").split("\x1f")
        if len(parts) < 5 or parts[0] not in marks:
            continue
        sha, ct, author, subject, body = parts[0], int(parts[1] or 0), parts[2], parts[3], parts[4]
        if ct < cutoff:
            outside += 1
            continue
        state = "applied" if marks[sha] == "-" else "missing"
        c = {"sha": sha, "time": ct, "author": author, "subject": subject, "state": state,
             "workItems": work_items(subject, body)}
        pr = MERGED_PR.match(subject)
        if pr:
            c["pr"] = int(pr.group(1))
        if state == "missing" and sha in skipped:
            c["state"], c["reason"] = "skipped", skipped[sha]
        commits.append(c)
    return commits, outside


def group_fixes(commits, limit):
    """Commits grouped into fixes by work item (else by PR, else alone), the ones not fully applied."""
    groups, order = {}, []
    for c in commits:
        key = ("ADO %d" % c["workItems"][0]) if c["workItems"] else ("PR %d" % c["pr"] if c.get("pr") else c["sha"][:8])
        if key not in groups:
            groups[key] = {"key": key, "workItems": c["workItems"], "title": c["subject"], "commits": []}
            order.append(key)
        groups[key]["commits"].append(c)
    fixes = []
    for key in order:
        g = groups[key]
        g["workItems"] = sorted({w for c in g["commits"] for w in c["workItems"]})
        g["title"] = g["commits"][-1]["subject"]  # the oldest commit is the fix itself
        st = {c["state"] for c in g["commits"]}
        g["state"] = "applied" if st == {"applied"} else "skipped" if st == {"skipped"} else \
            "missing" if st == {"missing"} else "partial"
        if g["state"] != "applied":
            fixes.append(g)
    return fixes[:limit], len(fixes) > limit


def hop_slug(older, newer):
    ver = lambda n: n.split("/", 1)[-1]
    return "%s-%s" % (ver(older), ver(newer))


def sync_branch_name(older, newer):
    return "sync/" + hop_slug(older, newer)


def sync_worktree_path(root, repo_name, older, newer):
    return root / ".claude" / "repowatch" / "sync" / repo_name / hop_slug(older, newer)


def sync_state_of(wt):
    """'conflict' while a merge or cherry-pick waits in the sync worktree, else 'ready'."""
    for ref in ("MERGE_HEAD", "CHERRY_PICK_HEAD"):
        if git(["rev-parse", "-q", "--verify", ref], wt)[0] == 0:
            return "conflict"
    return "ready"


def sync_repo(name, path, cfg, now, prev, decisions, root=None):
    """The sync facts of one repo, or None when it has fewer than two matching branches."""
    names = sync_branches(path, cfg)
    if len(names) < 2:
        return None
    hops, before = [], {(h["from"], h["to"]): h for h in (prev or {}).get("hops", [])}
    for older, newer in zip(names, names[1:]):
        skipped = ((decisions.get(name) or {}).get("%s>%s" % (older, newer)) or {}).get("skipped") or {}
        commits, outside = hop_commits(path, older, newer, cfg, now, skipped)
        hop = {"from": older, "to": newer}
        if commits is None:
            hop["error"] = "git cherry failed"
            hops.append(hop)
            continue
        fixes, cut = group_fixes(commits, cfg["syncMaxFixes"])
        count = lambda st: sum(1 for c in commits if c["state"] == st)
        hop.update(missing=count("missing"), applied=count("applied"), skipped=count("skipped"),
                   outsideWindow=outside, fixes=fixes, truncated=cut,
                   mode="cherry-pick" if skipped else "merge")
        wt = sync_worktree_path(root, name, older, newer) if root else None
        if wt is not None and wt.is_dir():
            hop["inProgress"] = {"path": posix(wt), "branch": sync_branch_name(older, newer), "state": sync_state_of(wt)}
        if rev(path, "refs/remotes/origin/" + sync_branch_name(older, newer)):
            hop["pushed"] = sync_branch_name(older, newer)
        if hop["missing"]:
            ysha = rev(path, "refs/remotes/origin/" + newer)
            hop["forecast"] = forecast(path, ysha, "origin/" + older, (before.get((older, newer)) or {}).get("forecast"))
        hops.append(hop)
    return {"branches": names, "hops": hops}


def sync_summary(repos):
    hops = [h for r in repos.values() for h in r["hops"]]
    return {"repos": len(repos),
            "hopsPending": sum(1 for h in hops if h.get("missing")),
            "fixesPending": sum(len(h.get("fixes", [])) for h in hops if h.get("missing")),
            "conflictHops": sum(1 for h in hops if (h.get("forecast") or {}).get("state") == "conflict")}


def run_sync(root, cfg, only):
    now = int(time.time())
    old = _read_json(root / SYNC_STATE_REL)
    known = old.get("repos") if isinstance(old.get("repos"), dict) else {}
    decisions = read_decisions(root)
    repos = [(n, p) for n, p in discover(root, cfg) if not only or n in only]
    with ThreadPoolExecutor(max_workers=max(1, cfg["workers"])) as ex:
        results = list(ex.map(lambda np_: (np_[0], sync_repo(np_[0], np_[1], cfg, now, known.get(np_[0]), decisions, root)), repos))
    for name, res in results:
        if res is None:
            known.pop(name, None)
        else:
            known[name] = res
    if not only:
        live = {n for n, _ in repos}
        for n in list(known):
            if n not in live:
                del known[n]
    state = {"version": VERSION, "generated": now, "repos": known, "summary": sync_summary(known)}
    path = root / SYNC_STATE_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(state, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))
    return state


def cmd_sync(a):
    root = find_workspace()
    state = run_sync(root, load_config(root), a.only)
    if a.json:
        print(json.dumps(state["summary"]))
    else:
        s = state["summary"]
        print("%d repos with a team chain: %d hops pending (%d fixes), %d would conflict"
              % (s["repos"], s["hopsPending"], s["fixesPending"], s["conflictHops"]))
    return 0


# --- branch sync actions ------------------------------------------------------------------------

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"


def parse_remote(url):
    """Azure DevOps remote -> (org, project, repo). Handles https, ssh and visualstudio.com forms."""
    url = (url or "").strip()
    for pat in (r"dev\.azure\.com/([^/]+)/([^/]+)/_git/([^/]+?)(?:\.git)?/?$",
                r"ssh\.dev\.azure\.com:v3/([^/]+)/([^/]+)/([^/]+?)(?:\.git)?/?$",
                r"//([^./@]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/]+)/_git/([^/]+?)(?:\.git)?/?$"):
        m = re.search(pat, url)
        if m:
            return tuple(urllib.request.unquote(x) for x in m.groups())
    return None


def ado_call(method, url, body=None):
    az = shutil.which("az") or shutil.which("az.cmd")
    if not az:
        raise RuntimeError("Azure CLI (az) not found. Install it and run: az login")
    r = subprocess.run([az, "account", "get-access-token", "--resource", ADO_RESOURCE, "--query", "accessToken", "-o", "tsv"],
                       capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        raise RuntimeError("could not get an ADO token from az. Run: az login")
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + r.stdout.strip(), "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise RuntimeError("ADO %s -> HTTP %d: %s" % (method, e.code, e.read().decode("utf-8", "replace")[:400]))


def create_pr(repo_path, source, target, title, description):
    """(id, url) of the pull request source -> target. REPOWATCH_FAKE_PR=<file> writes the request there instead."""
    rc, out, _ = git(["config", "--get", "remote.origin.url"], repo_path)
    parts = parse_remote(out) if rc == 0 else None
    if not parts:
        raise RuntimeError("origin is not an Azure DevOps remote, so no pull request was opened")
    org, project, repo = parts
    q = urllib.request.quote
    body = {"sourceRefName": "refs/heads/" + source, "targetRefName": "refs/heads/" + target,
            "title": title, "description": description}
    web = "https://dev.azure.com/%s/%s/_git/%s/pullrequest/" % (q(org), q(project), q(repo))
    fake = os.environ.get("REPOWATCH_FAKE_PR")
    if fake:
        Path(fake).write_text(json.dumps(dict(body, org=org, project=project, repo=repo)), encoding="utf-8")
        return 4242, web + "4242"
    api = "https://dev.azure.com/%s/%s/_apis/git/repositories/%s/pullrequests" % (q(org), q(project), q(repo))
    try:
        res = ado_call("POST", api + "?api-version=7.1", body)
    except RuntimeError as e:
        if "TF401179" not in str(e):  # an active PR for this source and target exists already
            raise
        res = ado_call("GET", "%s?searchCriteria.sourceRefName=%s&searchCriteria.status=active&api-version=7.1"
                       % (api, q(body["sourceRefName"], safe="")))["value"][0]
    return res["pullRequestId"], web + str(res["pullRequestId"])


def no_ids(text):
    """ADO turns #123 in stored text into a mention; write the number alone."""
    return re.sub(r"#(\d+)", r"\1", text)


def fix_lines(fixes):
    lines = []
    for f in fixes:
        ids = ("ADO " + ", ".join(str(w) for w in f["workItems"])) if f["workItems"] else f["key"]
        n = len(f["commits"])
        lines.append(no_ids("- %s %s%s" % (ids, f["title"][:90], " (%d commits)" % n if n > 1 else "")))
    return lines


def pr_text(older, newer, commits, fixes):
    n = len(commits)
    title = "Sync %s into %s" % (older, newer)
    body = "Carries %d commit%s from %s into %s.\n\n%s\n\nOpened by repowatch. Nothing was pushed to %s directly." % (
        n, "" if n == 1 else "s", older, newer, "\n".join(fix_lines(fixes)[:60]), newer)
    return title, body[:3900]


def write_decisions(root, data):
    path = root / SYNC_DECISIONS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(str(tmp), str(path))


def plan_sync(plan, repo, args, cfg, now, root):
    """The plan of a sync action. See the module docstring for what each does."""
    action = args.action
    names = sync_branches(repo, cfg)
    hop = (args.hop or "").split(":")
    if len(hop) != 2 or hop[0] not in names or hop[1] not in names or names.index(hop[0]) + 1 != names.index(hop[1]):
        plan["blocked"].append("not a hop of this repo's team chain: %s" % (args.hop or "(none given)"))
        return plan
    older, newer = hop
    wt = sync_worktree_path(root, args.repo, older, newer)
    branch = sync_branch_name(older, newer)
    plan.update(hop=[older, newer], branch=branch, path=posix(wt))
    exists = wt.is_dir()
    key = "%s>%s" % (older, newer)
    skipped = ((read_decisions(root).get(args.repo) or {}).get(key) or {}).get("skipped") or {}

    if action in ("sync-skip", "sync-unskip"):
        sha = rev(repo, (args.sha or "") + "^{commit}") if args.sha else ""
        if not sha:
            plan["blocked"].append("no such commit: %s" % (args.sha or "(none given)"))
            return plan
        if exists:
            plan["blocked"].append("a sync of this hop is in progress: finish or abort it first")
            return plan
        commits, _ = hop_commits(repo, older, newer, cfg, now, skipped)
        mine = [c for c in (commits or []) if c["sha"] == sha]
        if action == "sync-skip" and not (mine and mine[0]["state"] == "missing"):
            plan["blocked"].append("that commit is not missing from %s" % newer)
            return plan
        if action == "sync-unskip" and sha not in skipped:
            plan["blocked"].append("that commit is not marked as skipped")
            return plan
        subject = mine[0]["subject"] if mine else sha[:8]
        plan["decision"] = {"sha": sha, "subject": subject, "reason": args.reason or "not needed on %s" % newer}
        plan["level"] = "safe"
        plan["reasons"] = (["%s will not be taken to %s: %s" % (sha[:8], newer, subject),
                            "this hop will cherry-pick the rest instead of merging %s" % older]
                           if action == "sync-skip" else ["%s is taken to %s again" % (sha[:8], newer)])
        return plan

    if action == "sync-abort":
        if not exists:
            plan["blocked"].append("no sync of this hop in progress")
            return plan
        plan["level"] = "review"
        plan["reasons"] = ["throws away the sync worktree and its local branch %s" % branch]
        if rev(repo, "refs/remotes/origin/" + branch):
            plan["reasons"].append("%s stays on origin" % branch)
        plan["steps"] = [["git", "worktree", "remove", "--force", plan["path"]], ["git", "branch", "-D", branch]]
        return plan

    commits, _ = hop_commits(repo, older, newer, cfg, now, skipped)
    if commits is None:
        plan["blocked"].append("git could not compare %s and %s" % (older, newer))
        return plan
    missing = [c for c in commits if c["state"] == "missing"]
    fixes, _ = group_fixes([c for c in commits if c["state"] != "applied"], 50)
    title, desc = pr_text(older, newer, missing, [f for f in fixes if f["state"] != "skipped"])
    mode = "cherry-pick" if skipped else "merge"
    plan.update(mode=mode, wanted=[c["sha"] for c in reversed(missing)], title=title, description=desc)
    push = [["git", "push", "-u", "origin", branch], ["ado", "pull request", branch, "->", newer]]

    if action == "sync-hop":
        if exists:
            plan["blocked"].append("a sync of this hop is in progress at %s: finish or abort it" % posix(wt))
        if rev(repo, "refs/heads/" + branch):
            plan["blocked"].append("branch %s exists in this repo already" % branch)
        if rev(repo, "refs/remotes/origin/" + branch):
            plan["blocked"].append("branch %s is on origin already: its pull request is the next step" % branch)
        if not missing:
            plan["blocked"].append("%s has everything %s has" % (newer, older))
        if plan["blocked"]:
            return plan
        fc = forecast(repo, rev(repo, "refs/remotes/origin/" + newer), "origin/" + older)
        plan["reasons"] = ["%d commit%s in %d fix%s from %s to %s" % (
            len(missing), "" if len(missing) == 1 else "s", len(fixes), "" if len(fixes) == 1 else "es", older, newer),
            "nothing is pushed to %s: a pull request is opened for %s" % (newer, branch)]
        if mode == "cherry-pick":
            plan["reasons"].append("%d commit%s skipped, so the wanted commits are cherry-picked, oldest first" % (len(skipped), "" if len(skipped) == 1 else "s"))
        plan["level"] = "safe"
        if fc["state"] == "conflict":
            plan["level"] = "review"
            plan["reasons"].append("it will conflict in %s: the worktree is left for someone to resolve" % ", ".join(fc.get("files", [])[:5]))
        elif fc["state"] != "clean":
            plan["level"] = "review"
            plan["reasons"].append("could not forecast conflicts (%s)" % fc["state"])
        elif mode == "cherry-pick":
            plan["reasons"].append("a cherry-pick can still conflict where a merge would not")
        pick = (["git", "cherry-pick", "-x", "%d commits" % len(missing)] if mode == "cherry-pick"
                else ["git", "merge", "--no-ff", "origin/" + older])
        plan["steps"] = [["git", "fetch", "--no-tags", "origin", older, newer],
                         ["git", "worktree", "add", "-b", branch, plan["path"], "origin/" + newer], pick] + push
        return plan

    # sync-finish
    if not exists:
        plan["blocked"].append("no sync of this hop in progress")
        return plan
    if sync_state_of(wt) == "conflict":
        plan["blocked"].append("a merge or cherry-pick is still waiting in %s: resolve the conflicts and commit" % posix(wt))
    if git(["status", "--porcelain"], wt)[1].strip():
        plan["blocked"].append("uncommitted changes in %s: commit them" % posix(wt))
    if not plan["blocked"]:
        if mode == "merge":
            if git(["merge-base", "--is-ancestor", "origin/" + older, "HEAD"], wt)[0] != 0:
                plan["blocked"].append("origin/%s is not merged into %s yet" % (older, branch))
        else:
            rc, out, _ = git(["cherry", "HEAD", "origin/" + older], wt)
            todo = [l[2:].strip() for l in out.splitlines() if l.startswith("+ ")] if rc == 0 else []
            todo = [x for x in todo if x not in skipped]
            if todo:
                plan["blocked"].append("%d wanted commit%s not picked yet" % (len(todo), "" if len(todo) == 1 else "s"))
        rc, out, _ = git(["diff", "-U0", "origin/" + newer, "HEAD"], wt)
        if rc == 0 and re.search(r"^\+(<<<<<<< |>>>>>>> )", out, re.M):
            plan["blocked"].append("conflict markers are still in the files")
    if plan["blocked"]:
        return plan
    plan["level"] = "safe"
    plan["reasons"] = ["%s is complete" % branch, "nothing is pushed to %s: a pull request is opened for %s" % (newer, branch)]
    plan["steps"] = push + [["git", "worktree", "remove", plan["path"]]]
    return plan


def finish_sync(repo, plan):
    """Push the sync branch, open the pull request, remove the worktree. Returns result fields."""
    older, newer = plan["hop"]
    branch, wt = plan["branch"], Path(plan["path"])
    rc, _, err = git(["push", "-u", "origin", branch], wt, timeout=300)
    if rc != 0:
        return {"error": "push failed: %s" % (err or "exit %d" % rc), "state": "ready", "worktree": plan["path"]}
    try:
        pid, url = create_pr(repo, branch, newer, plan["title"], plan["description"])
    except Exception as e:  # the branch is pushed; the PR can be opened by hand
        return {"error": "%s was pushed, but the pull request was not opened: %s" % (branch, e), "state": "pushed", "branch": branch}
    git(["worktree", "remove", plan["path"]], repo)
    git(["branch", "-D", branch], repo)  # it is on origin; a stale local copy would block the next sync of this hop
    return {"state": "pr", "branch": branch, "pr": {"id": pid, "url": url}}


def apply_sync(root, cfg, repo, args, plan, now):
    action = args.action
    older, newer = plan["hop"]
    branch, wt = plan["branch"], Path(plan["path"])
    key = "%s>%s" % (older, newer)
    if action in ("sync-skip", "sync-unskip"):
        data = read_decisions(root)
        hops = data.setdefault(args.repo, {})
        entry = hops.setdefault(key, {}).setdefault("skipped", {})
        if action == "sync-skip":
            entry[plan["decision"]["sha"]] = plan["decision"]["reason"]
        else:
            entry.pop(plan["decision"]["sha"], None)
        if not entry:
            hops[key].pop("skipped", None)
        if not hops[key]:
            hops.pop(key)
        if not hops:
            data.pop(args.repo)
        write_decisions(root, data)
        return {}
    if action == "sync-abort":
        for cmd in (["merge", "--abort"], ["cherry-pick", "--abort"]):
            git(cmd, wt)
        rc, _, err = git(["worktree", "remove", "--force", str(wt)], repo)
        if rc != 0:
            return {"error": "could not remove %s: %s" % (wt, err)}
        git(["worktree", "prune"], repo)
        git(["branch", "-D", branch], repo)
        return {}
    if action == "sync-finish":
        return finish_sync(repo, plan)
    # sync-hop
    rc, _, err = git(["fetch", "--no-tags", "origin", older, newer], repo, timeout=cfg["fetchTimeout"])
    if rc != 0:
        return {"error": "fetch failed: %s" % (err or "exit %d" % rc)}
    wt.parent.mkdir(parents=True, exist_ok=True)
    rc, _, err = git(["worktree", "add", "-b", branch, str(wt), "origin/" + newer], repo, timeout=120)
    if rc != 0:
        return {"error": "could not make the worktree: %s" % err}
    if plan["mode"] == "merge":
        rc, _, err = git(["merge", "--no-ff", "-m", "Sync %s into %s" % (older, newer), "origin/" + older], wt, timeout=300)
    else:
        rc, _, err = git(["cherry-pick", "-x"] + plan["wanted"], wt, timeout=300)
    if rc != 0:
        if sync_state_of(wt) == "conflict":
            files = git(["diff", "--name-only", "--diff-filter=U"], wt)[1].split()
            return {"state": "conflict", "worktree": plan["path"], "branch": branch, "files": files}
        git(["worktree", "remove", "--force", str(wt)], repo)
        git(["branch", "-D", branch], repo)
        return {"error": "the %s failed: %s" % (plan["mode"], err)}
    return finish_sync(repo, plan)


# --- commands ------------------------------------------------------------------------------------

def cmd_scan(a):
    root = find_workspace()
    cfg = load_config(root)
    repos = [(n, p) for n, p in discover(root, cfg) if not a.only or n in a.only]
    state = read_state(root)
    known = state["repos"]

    fetch_errors = {}
    if a.fetch:
        due = pick_for_fetch([known.get(n, {"name": n, "path": posix(p)}) for n, p in repos],
                             a.fetch_batch if a.fetch_batch is not None else cfg["fetchBatch"])
        with ThreadPoolExecutor(max_workers=max(1, cfg["fetchWorkers"])) as ex:
            for name, err in ex.map(lambda r: fetch_repo(r, cfg), due):
                if err:
                    fetch_errors[name] = err

    now = int(time.time())
    with ThreadPoolExecutor(max_workers=max(1, cfg["workers"])) as ex:
        recs = list(ex.map(lambda np_: scan_repo(np_[0], np_[1], cfg, now, known.get(np_[0])), repos))
    for rec in recs:
        if rec["name"] in fetch_errors:
            rec["fetchError"] = fetch_errors[rec["name"]]
            rec["flags"] = rec.get("flags", []) + ["fetch-failed"]
        known[rec["name"]] = rec
    if not a.only:  # a full scan forgets repos that are gone
        live = {n for n, _ in repos}
        for n in list(known):
            if n not in live:
                del known[n]
    state["generated"] = now
    state["root"] = posix(root)
    state["summary"] = summarize(known)
    state["undoable"] = undoable(root)
    write_state(root, state)
    if a.json:
        print(json.dumps(state["summary"]))
    else:
        s = state["summary"]
        print("%d repos scanned (%d need attention, %d behind, %d dirty, %d worktrees)"
              % (len(recs), s["attention"], s["behind"], s["dirty"], s["worktrees"]))
        for n, e in sorted(fetch_errors.items()):
            print("  fetch failed: %s: %s" % (n, e))
    return 0


def cmd_status(a):
    root = find_workspace()
    state = read_state(root)
    if a.json:
        sync = _read_json(root / SYNC_STATE_REL)
        if sync.get("repos") is not None:
            state["sync"] = {"generated": sync.get("generated", 0), "repos": sync["repos"], "summary": sync.get("summary", {})}
        print(json.dumps(state))
        return 0
    repos = sorted(state["repos"].values(), key=lambda r: (-len(r.get("flags", [])), r["name"]))
    if not repos:
        print("nothing scanned yet: run `repowatch.py scan`")
        return 0
    for r in repos:
        where = r.get("branch") or "(detached)"
        track = ""
        if r.get("ahead") or r.get("behind"):
            track = " +%d/-%d" % (r.get("ahead", 0), r.get("behind", 0))
        print("%-28s %-24s%s  %s" % (r["name"], where, track, ", ".join(r.get("flags", [])) or "ok"))
    return 0


def cmd_act(a, apply):
    root = find_workspace()
    return run_action(root, load_config(root), a, apply)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("scan")
    s.add_argument("--fetch", action="store_true", help="also fetch the repos fetched longest ago")
    s.add_argument("--fetch-batch", type=int, default=None)
    s.add_argument("--only", nargs="*", default=[])
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_scan)
    s = sp.add_parser("status")
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_status)
    s = sp.add_parser("sync")
    s.add_argument("--only", nargs="*", default=[])
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_sync)
    for name, apply in (("plan", False), ("apply", True)):
        s = sp.add_parser(name)
        s.add_argument("action", choices=ACTIONS)
        s.add_argument("--repo", required=True)
        s.add_argument("--path")
        s.add_argument("--branch")
        s.add_argument("--delete-branch", action="store_true", help="remove-worktree: also delete its local branch")
        s.add_argument("--id", help="undo: the journal id of the clean-up to put back")
        s.add_argument("--hop", help="sync-*: OLDER:NEWER, e.g. team/0.0.1:team/0.0.2")
        s.add_argument("--sha", help="sync-skip, sync-unskip: the commit")
        s.add_argument("--reason", help="sync-skip: why it is not taken")
        if apply:
            s.add_argument("--allow-review", action="store_true", help="go ahead with a plan at level review")
        s.set_defaults(fn=(lambda a, ap_=apply: cmd_act(a, ap_)))
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
