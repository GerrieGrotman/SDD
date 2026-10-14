"""repowatch: keep track of many git repos and their worktrees. Mechanics only; the mod draws it.

    python repowatch.py scan [--fetch] [--fetch-batch N] [--only NAME ...] [--json]
    python repowatch.py status [--json]

`scan` reads each repo's local facts (branch, ahead/behind, dirty files, stashes, worktrees) and
writes them to <workspace>/.claude/repowatch/state.json. With --fetch it also fetches the repos that
were fetched longest ago, a few at a time, so a sweep of dozens of repos is spread over many scans
and never stalls. It never pulls, merges, checks out or deletes anything.

Workspace: the first folder up from the current one that holds .claude/repowatch.json or
.claude/sdd.json, else the current folder. Repos: "repos" in repowatch.json, else "repoDirs" in
sdd.json, else every folder up to two levels down that holds a .git folder.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
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
}
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


def read_worktree(wt, now):
    """Dirty/ahead/behind and age of one worktree folder."""
    p = Path(wt["path"])
    info = {"path": posix(wt["path"]), "branch": wt["branch"], "head": wt["head"], "detached": wt["detached"],
            "locked": wt["locked"], "prunable": wt["prunable"], "missing": not p.is_dir()}
    if info["missing"]:
        return info
    rc, out, _ = git(["status", "--porcelain=v2", "--branch"], p)
    if rc == 0:
        s = parse_status(out)
        info.update(dirty=s["dirty"], ahead=s["ahead"], behind=s["behind"], upstream=s["upstream"])
    rc, out, _ = git(["log", "-1", "--format=%ct"], p)
    if rc == 0 and out.strip().isdigit():
        info["lastCommit"] = int(out.strip())
    return info


def scan_repo(name, path, cfg, now=None):
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

    gone, branches = [], 0
    rc, out, _ = git(["for-each-ref", "--format=%(refname:short)\t%(upstream:short)\t%(upstream:track)", "refs/heads"], path)
    if rc == 0:
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) < 3:
                continue
            branches += 1
            if parse_track(parts[2])[2]:
                gone.append(parts[0])
    rec["branches"] = branches
    rec["goneBranches"] = gone

    rc, out, _ = git(["worktree", "list", "--porcelain"], path)
    wts = parse_worktrees(out) if rc == 0 else []
    mine = posix(Path(path).resolve())
    others = [w for w in wts if posix(Path(w["path"]).resolve()) != mine and not w["bare"]]
    rec["worktrees"] = [read_worktree(w, now) for w in others]
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
    if any(w.get("prunable") or w.get("missing") for w in rec.get("worktrees", [])):
        f.append("broken-worktree")
    limit = cfg["staleWorktreeDays"] * 86400
    if any(w.get("lastCommit") and now - w["lastCommit"] > limit and not w.get("dirty") for w in rec.get("worktrees", [])):
        f.append("old-worktree")
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
        "oldWorktrees": count("old-worktree"),
        "errors": count("error"),
    }


def pick_for_fetch(repos, batch):
    """The `batch` repos fetched longest ago (never fetched first)."""
    return sorted(repos, key=lambda r: (r.get("lastFetch") or 0, r["name"]))[:max(0, batch)]


def fetch_repo(rec, cfg):
    rc, _, err = git(["fetch", "--prune", "--no-tags", "origin"], rec["path"], timeout=cfg["fetchTimeout"])
    return rec["name"], (None if rc == 0 else (err.splitlines()[-1] if err else "fetch failed"))


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
        recs = list(ex.map(lambda np_: scan_repo(np_[0], np_[1], cfg, now), repos))
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
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
