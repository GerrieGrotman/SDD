"""Work item environments: one folder per work item holding a worktree per repo plus a code graph.

    .claude/worktrees/{id}-{slug}/
        workitem.json   which repo is on which base branch, its dev branch, its PR
        CLAUDE.md       generated: work only here
        src/{Repo}/     git worktrees
        graph/          graphify code graph of src/

Commands (run from anywhere inside the workspace):
    init   --spec-root documents/spec        create .claude/sdd.json for this workspace
    doctor [--json]                          check every requirement; read-only
    type   --id N                            work item type and which sdd flow it belongs to
    new    --id N --repos A,B --version 1.1.0 [--base Repo=branch] [--no-graph]
                                             create the folder, or add repos to it
    status --id N [--json]                   ADO state, recorded progress, spec files and tasks, repos, live PRs
    progress --id N --flow bug|spec --phase P --status active|waiting|blocked|done|skipped|abandoned
             [--gate G] [--next X] [--note T] [--caveat T] [--passed G] [--revoke G] [--ref R ...] [--no-visual WHY]
                                             checkpoint the flow; record gates; creates the folder if needed
    graph  --id N                            rebuild graph/ from src/ (no LLM, seconds)
    pr     --id N --title T --description-file F [--repos A] [--work-items 1,2] [--draft]
                                             push each repo with commits and open its PR
    refs   --id N --ref <file[:line[-end]]|ado> ...   the links block for a question to the user
    can    --id N --op start|resume|phase|pr|done|abandon [--flow F --phase P] [--json]
                                             is the operation allowed now? exit 0 yes, 3 no, with reasons
    remove --id N [--abandon] [--yes]        dry run unless --yes; enforces `can --op done` (or abandon)
    run    --id N --gate G --expect pass|fail [--repo R] [--repeat N] [--suite] -- COMMAND
                                             run a test command in the worktree and record it as proof
    revert-check --id N --gate G [--repo R] --fix PATH [--fix PATH ...] -- COMMAND
                                             the test fails with the fix files at base, passes with them
    verify --id N                            run every tasks.md Verify command; proof for Ready to PR
    path   --id N --set full|short --confirmed WORDS
                                             the way through the spec flow the user chose
"""
import argparse
import json
import os
import re
import shutil
import stat
import subprocess
import urllib.parse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import proof
from adowrite import flow_of, mentions
from sddlib import (AGENT_MODELS, BUG_TYPES, CONFIG_REL, DEFAULTS, STYLE_NAME, TYPE_SEGMENT, ado,
                    bad_agent_models, config_home, developer, die, discover_repos, ensure_ignored,
                    find_env, find_root, get_items, git, install_output_style, load_config, org_url,
                    parse_remote, read_env, read_record, require_root, slug, upgrade_config, wt_root,
                    write_env)

GRAPH_IGNORE = "bin/\nobj/\nnode_modules/\ndist/\nbuild/\ncoverage/\n*.min.js\n"
PLUGIN = Path(__file__).resolve().parent.parent  # the sdd plugin root
ENV_PY = f"python {(PLUGIN / 'scripts' / 'env.py').as_posix()}"


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def item_info(cfg, wid):
    got = get_items(cfg, [wid], fields=["System.Id", "System.WorkItemType", "System.Title",
                                        "System.State", "System.TeamProject"])
    if not got:
        die(f"work item {wid} not found in org {cfg['ado']['org']}")
    f = got[0]["fields"]
    t = f["System.WorkItemType"]
    return {"id": int(wid), "type": t, "title": f["System.Title"], "state": f["System.State"],
            "project": f["System.TeamProject"], "flow": flow_of(t, cfg["agentRequest"]["types"])}


# ---------------------------------------------------------------- init / type

def cmd_init(a):
    root = Path(os.getcwd()).resolve()
    target = root / CONFIG_REL
    if target.exists():
        die(f"{target} already exists")
    cfg = dict(DEFAULTS, specRoot=a.spec_root)
    repos = discover_repos(root, cfg)
    orgs, projects = set(), []
    for d in repos.values():
        p = parse_remote(git(["remote", "get-url", "origin"], d, check=False))
        if p:
            orgs.add(p[0])
            if p[1] not in projects:
                projects.append(p[1])
    cfg["ado"] = {"org": sorted(orgs)[0] if orgs else "", "projects": projects}
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {target}")
    print(f"repos found: {', '.join(sorted(repos)) or 'none'}")
    if len(orgs) > 1:
        print(f"warning: several ADO orgs in remotes ({', '.join(sorted(orgs))}); kept the first")
    report_output_style(force=True)


def cmd_type(a):
    cfg = load_config(require_root())
    print(json.dumps(item_info(cfg, a.id), indent=2))


def report_output_style(force=False):
    """Install the plugin's output style globally (see sddlib.install_output_style) and say what changed."""
    try:
        changed, notes = install_output_style(force)
    except OSError as e:
        print(f"sdd: could not install the {STYLE_NAME} output style: {e}", file=sys.stderr)
        return
    for n in notes:
        print(f"sdd: {n}", file=sys.stderr)
    if changed:
        print(f"sdd: {STYLE_NAME} output style installed. Changed: {', '.join(str(p) for p in changed)}. "
              "Restart Claude Code to use it.")


def cmd_upgrade_config(a):
    """Bring settings up to the plugin's: the global output style, then the defaults of new keys in
    this workspace's .claude/sdd.json. Run by the plugin's SessionStart hook: prints only what
    changed, and never fails the session start."""
    report_output_style()
    root = find_root()
    if not root:
        return
    try:
        added = upgrade_config(root)
        bad = bad_agent_models(load_config(root))
    except (OSError, ValueError) as e:
        print(f"sdd: could not check {root / CONFIG_REL}: {e}", file=sys.stderr)
        return
    if added:
        print(f"sdd: added {', '.join(added)} to {root / CONFIG_REL} with the plugin's defaults; change them there")
    if bad:
        print(f"sdd: agents.models in {root / CONFIG_REL} has {', '.join(bad)}; use one of "
              f"{', '.join(AGENT_MODELS)}. The flows leave that agent on its own default until it is fixed.")


# ---------------------------------------------------------------- doctor

CLAUDE_MARK = "<!-- sdd:begin -->"


def cmd_doctor(a):
    """Every requirement as {check, ok, required, detail, fix}. Read-only; /sdd init acts on it."""
    win, mac = sys.platform == "win32", sys.platform == "darwin"

    def inst(winget, brew, apt):
        return f"winget install -e --id {winget}" if win else f"brew install {brew}" if mac else f"sudo apt install {apt}"

    def run(*cmd):
        try:
            return subprocess.run(list(cmd), capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            return None

    out = []

    def add(check, ok, required, detail, fix=""):
        out.append({"check": check, "ok": bool(ok), "required": required, "detail": detail, "fix": "" if ok else fix})

    add("python", sys.version_info >= (3, 9), True, sys.version.split()[0], "install Python 3.9 or later")
    import sqlite3
    try:
        sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        add("sqlite fts5", True, True, sqlite3.sqlite_version)
    except sqlite3.Error as e:
        add("sqlite fts5", False, True, str(e), "use a Python build whose sqlite3 has FTS5 (python.org builds do)")
    add("git", shutil.which("git"), True, shutil.which("git") or "not found", inst("Git.Git", "git", "git"))
    az = shutil.which("az") or shutil.which("az.cmd")
    add("azure cli", az, True, az or "not found", inst("Microsoft.AzureCLI", "azure-cli", "azure-cli"))
    if az:
        r = run(az, "account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798",
                "--query", "expiresOn", "-o", "tsv")
        add("azure login", r and r.returncode == 0, True, (r.stdout.strip() if r and r.returncode == 0 else "no ADO token"),
            "the user runs: az login   (sign-in is the user's own step)")
    add("graphify", shutil.which("graphify"), False, shutil.which("graphify") or "not found — code graphs are skipped",
        f"{sys.executable} -m pip install --user graphifyy")
    add("pandoc", shutil.which("pandoc"), False, shutil.which("pandoc") or "not found — specs fall back to plain text",
        inst("JohnMacFarlane.Pandoc", "pandoc", "pandoc"))

    node = shutil.which("node")
    add("node", node, True, node or "not found — sdd:visual pages cannot be rendered", inst("OpenJS.NodeJS.LTS", "node", "nodejs"))

    try:
        wired = (PLUGIN / "hooks" / "hooks.json").read_text(encoding="utf-8").count("question_guard.py") >= 2
    except OSError:
        wired = False
    add("question hooks", wired, True, "shipped in the plugin's hooks/hooks.json" if wired
        else f"{(PLUGIN / 'hooks' / 'hooks.json').as_posix()} does not wire question_guard.py",
        "reinstall the sdd plugin")
    try:
        settings = (Path.home() / ".claude" / "settings.json").read_text(encoding="utf-8")
    except OSError:
        settings = ""
    old = "question_guard.py" in settings
    add("no old question hooks", not old, False, "~/.claude/settings.json is clean" if not old
        else "~/.claude/settings.json still runs question_guard.py — each question is checked twice",
        "remove the PreToolUse and Stop entries that name question_guard.py from ~/.claude/settings.json (ask first)")

    root = find_root()
    cfg = load_config(root) if root else DEFAULTS
    ol = shutil.which("ollama")
    add("ollama", ol, False, ol or "not found — meaning search is off", inst("Ollama.Ollama", "ollama", "ollama (see ollama.com)"))
    if ol:
        try:
            import urllib.request
            with urllib.request.urlopen(cfg["embeddings"]["url"].rstrip("/") + "/api/tags", timeout=5) as resp:
                names = [m["name"].split(":")[0] for m in json.loads(resp.read()).get("models", [])]
            add("ollama running", True, False, cfg["embeddings"]["url"])
            model = cfg["embeddings"]["model"]
            add("embedding model", model.split(":")[0] in names, False, model if model.split(":")[0] in names
                else f"{model} not pulled", f"ollama pull {model}   (download, about 274 MB for nomic-embed-text)")
        except OSError:
            add("ollama running", False, False, "not answering on " + cfg["embeddings"]["url"],
                "start the Ollama app (or: ollama serve)")

    try:
        style_set = json.loads((config_home() / "settings.json").read_text(encoding="utf-8")).get("outputStyle")
    except (OSError, ValueError, AttributeError):
        style_set = None
    style_file = (config_home() / "output-styles" / f"{STYLE_NAME}.md").is_file()
    add("output style", style_file and style_set == STYLE_NAME, False,
        f"{STYLE_NAME}, set globally" if style_file and style_set == STYLE_NAME
        else f"global outputStyle is {style_set or 'not set'}" + ("" if style_file else f"; no {STYLE_NAME}.md"),
        f"pick {STYLE_NAME} in /config (the plugin sets it once and then leaves your choice alone)")
    add("sdd.json", root, True, str(root / CONFIG_REL) if root else "no .claude/sdd.json at or above here",
        f"{ENV_PY} init --spec-root <folder>   (from the workspace root)")
    if root:
        repos = discover_repos(root, cfg)
        add("repos", repos, True, ", ".join(sorted(repos)) or "none found",
            "set repoDirs in .claude/sdd.json to the repo folders")
        add("ado projects", cfg["ado"]["org"] and cfg["ado"]["projects"], True,
            f"{cfg['ado']['org']}: {', '.join(cfg['ado']['projects'])}", "set ado.org and ado.projects in .claude/sdd.json")
        if (root / ".git").exists():
            wt = cfg["worktreeRoot"].replace("\\", "/").rstrip("/")
            ig = run("git", "-C", str(root), "check-ignore", "-q", wt + "/x")
            add("worktrees ignored", ig and ig.returncode == 0, True, wt,
                f"add '{wt}/' to {root / '.git' / 'info' / 'exclude'}   (env.py new also does this)")
        bad = bad_agent_models(cfg)
        add("agent models", not bad, False, ", ".join(f"{k}={v}" for k, v in cfg["agents"]["models"].items())
            if not bad else f"not a model the Agent tool takes: {', '.join(bad)}",
            f"set agents.models in .claude/sdd.json to one of {', '.join(AGENT_MODELS)}")
        cm = root / "CLAUDE.md"
        has = cm.is_file() and CLAUDE_MARK in cm.read_text(encoding="utf-8", errors="replace")
        add("CLAUDE.md sdd block", has, False, str(cm) if has else "no sdd block in the workspace CLAUDE.md",
            "add the block from sdd/SKILL.md 'CLAUDE.md block' (ask first)")
    print(json.dumps(out, indent=2) if a.json else "\n".join(
        f"{'ok  ' if c['ok'] else ('FAIL' if c['required'] else 'warn')}  {c['check']:<20} {c['detail']}"
        + ("" if c["ok"] else f"\n      fix: {c['fix']}") for c in out))


# ---------------------------------------------------------------- new

def resolve_base(repo_dir, want):
    """Match origin/<want> case-insensitively (HealthCodeIndex uses Team/x, others team/x)."""
    remote = git(["branch", "-r", "--format=%(refname:short)"], repo_dir).splitlines()
    for b in remote:
        if b.lower() == f"origin/{want}".lower():
            return b[len("origin/"):]
    teams = sorted(b for b in remote if re.match(r"origin/team/", b, re.I))
    head = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], repo_dir, check=False)
    die(f"{repo_dir.name}: no origin/{want}. team branches: {', '.join(teams) or 'none'}; "
        f"default: {head or 'unknown'}. Pass --base {repo_dir.name}=<branch>")


def write_env_claude(env_dir, info, spec_root):
    p = env_dir / "CLAUDE.md"
    if p.exists():
        return
    p.write_text(f"""# ADO {info['id']} — {info['title']}

Everything for this work item happens in this folder. Do not edit the main checkout.

- `src/<Repo>/` — one git worktree per repo. Edit, build, test and commit only here.
- `graph/graph.json` — graphify code graph of `src/`. Query with
  `graphify query "<question>" --graph graph/graph.json`. Rebuild after edits:
  `{ENV_PY} graph --id {info["id"]}`.
- `workitem.json` — which repo is on which base branch, its dev branch and its PR.
- Spec for this item: `{spec_root}/**/{info['id']}-*/` at the workspace root (read-only mirror of ADO).
- Each worktree has a copy of its repo's `CLAUDE.md` when the repo has one.
""", encoding="utf-8")


def ensure_env(root, cfg, wid, info=None):
    """The work item folder, created (without any repo) when it does not exist yet."""
    env_dir = find_env(root, cfg, wid)
    if env_dir:
        return env_dir, read_env(env_dir)
    info = info or item_info(cfg, wid)
    env_dir = wt_root(root, cfg) / f"{wid}-{slug(info['title'])}"
    (env_dir / "src").mkdir(parents=True, exist_ok=True)
    data = {**info, "slug": env_dir.name.split("-", 1)[1], "created": now(), "repos": {}}
    if (root / ".git").exists():
        ensure_ignored(root, cfg["worktreeRoot"].replace("\\", "/"))
    (env_dir / "src" / ".graphifyignore").write_text(GRAPH_IGNORE, encoding="utf-8")
    write_env_claude(env_dir, data, cfg["specRoot"])
    write_env(env_dir, data)
    return env_dir, data


def cmd_new(a):
    root = require_root()
    cfg = load_config(root)
    repos = discover_repos(root, cfg)
    names = [r.strip() for r in (a.repos or "").split(",") if r.strip()]
    for n in names:
        if n not in repos:
            die(f"unknown repo '{n}'. Known: {', '.join(sorted(repos))}")
    bases = dict(b.split("=", 1) for b in (a.base or []))
    for n in names:
        if n not in bases and not a.version:
            die(f"{n}: pass --version or --base {n}=<branch>")

    info = ({"id": a.id, "type": a.type, "title": a.title, "state": "", "project": "",
             "flow": "bug" if a.type in BUG_TYPES else "spec"} if a.title and a.type else None)
    env_dir, data = ensure_env(root, cfg, a.id, info)

    dev = developer()
    for n in names:
        if n in data["repos"]:
            print(f"{n}: already in this work item, skipped")
            continue
        src = repos[n]
        print(f"{n}: fetching")
        git(["fetch", "origin", "--prune"], src)
        base = resolve_base(src, bases.get(n) or f"team/{a.version}")
        version = base.split("/")[-1]
        branch = a.branch or cfg["branchTemplate"].format(
            developer=dev, version=version, type=TYPE_SEGMENT.get(data["type"], "tech"),
            id=data["id"], slug=data["slug"])
        if git(["branch", "--list", branch], src):
            die(f"{n}: local branch {branch} already exists. Remove it or pass --branch")
        path = env_dir / "src" / n
        git(["worktree", "add", "--no-track", str(path), "-b", branch, f"origin/{base}"], src)
        claude_md = src / "CLAUDE.md"
        if claude_md.is_file() and not (path / "CLAUDE.md").exists():  # tracked copies come with the checkout
            ensure_ignored(path, "CLAUDE.md", is_dir=False)  # info/exclude is shared by all worktrees
            shutil.copy2(claude_md, path / "CLAUDE.md")
        rem = parse_remote(git(["remote", "get-url", "origin"], src, check=False)) or ("", "", n)
        data["repos"][n] = {"source": str(src.relative_to(root)).replace("\\", "/"),
                            "project": rem[1], "adoRepo": rem[2], "base": base,
                            "version": version, "branch": branch,
                            "path": f"src/{n}", "pr": None}
        print(f"{n}: {branch} from origin/{base} -> {path}")
        if (path / "package.json").is_file():
            print(f"{n}: has package.json; run npm install inside the worktree before building")
        write_env(env_dir, data)

    write_env(env_dir, data)
    if names and not a.no_graph:
        build_graph(env_dir)
    print(f"work item folder: {env_dir}")


# ---------------------------------------------------------------- status / graph

def env_or_die(root, cfg, wid):
    return find_env(root, cfg, wid) or die(f"no work item folder for {wid} under {wt_root(root, cfg)}")


PROGRESS_STATUS = ("active", "waiting", "blocked", "done", "skipped", "abandoned")


def done_dir(root, cfg):
    return wt_root(root, cfg) / ".done"


def spec_folder(root, cfg, wid):
    base = root / cfg["specRoot"]
    hits = [d for d in base.rglob(f"{int(wid)}-*") if d.is_dir() and ".index" not in d.parts] if base.is_dir() else []
    return hits[0] if hits else None


def item_project(root, cfg, wid, data):
    db = root / cfg["specRoot"] / ".index" / "spec.db"
    if db.is_file():
        import sqlite3
        row = sqlite3.connect(db).execute("SELECT project, title FROM items WHERE id=?", (wid,)).fetchone()
        if row:
            return row[0], row[1]
    return ((data or {}).get("project") or (cfg["ado"]["projects"] or [""])[0]), (data or {}).get("title", "")


def build_refs(root, cfg, wid, refs):
    """Links the user must see before deciding: the ADO item, its requirements.md, and every --ref.
    A ref is `ado`, a spec file name in the item's spec folder (design.md), or a path — absolute,
    workspace-relative, or relative to the work item folder (src/Repo/x.cs) — with optional :line or
    :start-end. A ref that does not exist is an error: the user must be shown real things."""
    env_dir = find_env(root, cfg, wid)
    data = read_env(env_dir) if env_dir else None
    project, title = item_project(root, cfg, wid, data)
    org = cfg["ado"]["org"]
    lines = [f"- ADO: [ADO {wid} — {title}](https://dev.azure.com/{org}/{project}/_workitems/edit/{wid})"]
    send, errors, seen = [], [], set()
    sp = spec_folder(root, cfg, wid)
    wanted = ([str(sp / "requirements.md")] if sp and (sp / "requirements.md").is_file() else []) + list(refs)
    for ref in wanted:
        if ref.lower() == "ado":
            continue
        m = re.match(r"^(.*?)(?::(\d+)(?:-(\d+))?)?$", ref)
        raw, start, end = m.group(1), m.group(2), m.group(3)
        cands = [Path(raw)] if Path(raw).is_absolute() else [root / raw] + ([env_dir / raw] if env_dir else []) \
            + ([sp / raw] if sp else [])
        f = next((c.resolve() for c in cands if c.exists()), None)
        if not f:
            errors.append(f"ref not found: {ref}")
            continue
        if (f, start, end) in seen:
            continue
        seen.add((f, start, end))
        rel = f.relative_to(root).as_posix() if root in f.parents else f.as_posix()
        loc = f":{start}" if start else ""
        text = rel.split("/")[-1] + (f" lines {start}-{end}" if end else f" line {start}" if start else "")
        entry = f"- [{text}]({rel}{loc})"
        # code inside a pushed worktree branch also gets an ADO web link, which opens on a phone
        for n, r in ((data or {}).get("repos") or {}).items():
            wt = (env_dir / r["path"]).resolve()
            if wt in f.parents and git(["ls-remote", "--heads", "origin", r["branch"]], wt, check=False):
                path_in_repo = f.relative_to(wt).as_posix()
                web = (f"{org_url(cfg)}/{r['project']}/_git/{r['adoRepo']}?path=/{path_in_repo}"
                       f"&version=GB{r['branch']}" + (f"&line={start}&lineEnd={end or start}&lineStartColumn=1"
                                                      f"&lineEndColumn=200" if start else ""))
                entry += f" · [open in ADO]({web})"
                break
        else:
            if sp and sp.resolve() in f.parents or f.suffix.lower() == ".md":
                send.append(str(f))
            elif start:
                entry += " · not pushed: quote the lines in the message"
        lines.append(entry)
    return lines, send, errors


def print_refs(lines, send, errors):
    if errors:
        die("\n".join(errors) + "\nFix the refs: the user must be shown the real spec documents and code.")
    print("Links for this decision (paste above the question):")
    print("\n".join(lines))
    if send:
        print("Send with SendUserFile (display: render) so they reach a phone:")
        print("\n".join(f"  {x}" for x in send))


def cmd_refs(a):
    root = require_root()
    cfg = load_config(root)
    print_refs(*build_refs(root, cfg, a.id, a.ref))


def cmd_progress(a):
    conditional = is_conditional(getattr(a, "flow", None), phase_key(getattr(a, "flow", None), getattr(a, "phase", None)))
    if a.status == "skipped" and not conditional and not (a.confirmed or "").strip():
        die("a skipped stage needs --confirmed \"<the user's words>\": ask the user first, and record the skip "
            "only after they said yes")
    if a.status == "skipped" and a.passed:
        die("a skipped stage passes no gates: drop --passed")
    if a.status == "waiting" and not a.ref:
        die("a waiting gate needs at least one --ref (a spec file, code path[:line], or `ado`): "
            "the user must see what they are deciding on")
    if a.status == "waiting" and not a.no_visual and not any(
            re.sub(r":\d+(-\d+)?$", "", r).lower().endswith(".html") for r in a.ref):
        die("a waiting gate needs its sdd:visual page as a --ref (e.g. visuals/design.html); build it with "
            "the sdd:visual skill, or --no-visual \"<reason>\" when the gate has nothing to explain")
    """Checkpoint for the flows: where the work stands, so another session can resume it."""
    root = require_root()
    cfg = load_config(root)
    key = phase_key(a.flow, a.phase)
    if key is None:
        die(f"unknown {a.flow} stage '{a.phase}'. Stages: {', '.join(stage_keys(a.flow))}")
    env_dir, data = ensure_env(root, cfg, a.id)
    open_q = open_questions(root, cfg, a.id)
    if conditional and a.status == "skipped" and open_q:
        die(f"{key} cannot be skipped: {open_q} open question{'s' if open_q != 1 else ''} in questions.md. "
            "Work the stage: ask each one, tick it off with its answer, or let the user continue with a caveat")
    if conditional and a.status == "done" and open_q and not (a.caveat or "").strip():
        die(f"{key} cannot be done: {open_q} open question{'s' if open_q != 1 else ''} in questions.md. Ask them, "
            "or record the user's choice to continue anyway with --caveat \"<the questions left open>\"")
    if a.caveat and not (conditional and a.status == "done"):
        die("--caveat is only for finishing the Open Questions stage with questions still open")
    if a.status != "abandoned":
        missed = unaccounted(a.flow, data, key, open_q)
        if missed:
            die(f"{key} cannot start: {', '.join(missed)} {'was' if len(missed) == 1 else 'were'} never worked "
                "and never skipped.\nDo that stage first. To skip it, ask the user; only after their yes record "
                "it with: progress --phase \"<stage>\" --status skipped --confirmed \"<the user's words>\"")
    if a.ref:
        _, _, bad = build_refs(root, cfg, a.id, a.ref)
        if bad:
            die("\n".join(bad) + "\nFix the refs before recording the gate.")
    for g in a.passed:
        lack = proof_missing(a.flow, data, env_dir, g)
        if lack:
            die(f"'{g}' passes only on recorded runs, and these are missing:\n  " + "\n  ".join(lack)
                + "\nRun them (env.py run / revert-check / verify), then record the gate again.")
    entry = {"at": now(), "flow": a.flow, "phase": a.phase, "status": a.status,
             "gate": a.gate or "", "next": a.next or "", "note": a.note or "", "refs": a.ref}
    if a.status == "skipped":
        entry["confirmed"] = (a.confirmed or "").strip() or "no open questions: nothing to ask"
    if a.caveat and open_q:
        entry["caveat"] = a.caveat.strip()
        entry["openQuestions"] = open_q
    data["stages"] = mark_stage(a.flow, data, key, entry)
    gates = data.setdefault("gates", {})
    for g in a.passed:
        gates[g] = entry["at"]
    for g in a.revoke:
        gates.pop(g, None)
    if a.passed or a.revoke:
        entry["gates"] = {"passed": a.passed, "revoked": a.revoke}
    data["progress"] = entry
    data["history"] = (data.get("history") or [])[-49:] + [entry]
    write_env(env_dir, data)
    print(f"{a.id}: {a.flow} / {a.phase} / {a.status}" + (f" — waiting on: {a.gate}" if a.gate else ""))
    if a.ref:
        print_refs(*build_refs(root, cfg, a.id, a.ref))


def count_questions(text):
    """(open, total) in a questions.md: each question is a checkbox line, `- [ ]` open, `- [x]` answered."""
    done = len(re.findall(r"^\s*[-*] \[[xX]\]", text, re.M))
    opened = len(re.findall(r"^\s*[-*] \[ \]", text, re.M))
    return opened, opened + done


def open_questions(root, cfg, wid):
    """How many questions in the item's questions.md are still unanswered."""
    sp = spec_folder(root, cfg, wid)
    q = sp / "questions.md" if sp else None
    return count_questions(q.read_text(encoding="utf-8", errors="replace"))[0] if q and q.is_file() else 0


def spec_state(root, cfg, wid):
    base = (root / cfg["specRoot"])
    hits = [d for d in base.rglob(f"{int(wid)}-*") if d.is_dir() and ".index" not in d.parts] if base.is_dir() else []
    if not hits:
        return None
    d = hits[0]
    out = {"folder": str(d.relative_to(root)).replace("\\", "/"),
           "files": sorted(f.name for f in d.iterdir() if f.is_file())}
    q = d / "questions.md"
    if q.is_file():
        out["questions_open"], out["questions_total"] = count_questions(q.read_text(encoding="utf-8", errors="replace"))
    t = d / "tasks.md"
    if t.is_file():
        text = t.read_text(encoding="utf-8", errors="replace")
        out["tasks_done"] = len(re.findall(r"^\s*[-*] \[[xX]\]", text, re.M))
        out["tasks_total"] = out["tasks_done"] + len(re.findall(r"^\s*[-*] \[ \]", text, re.M))
    return out


def live_item(cfg, wid):
    try:
        got = get_items(cfg, [wid], fields=["System.State", "Custom.BoardColumnTitle", "System.AssignedTo",
                                            "System.IterationPath", "System.WorkItemType", "System.Title"])
    except RuntimeError:  # a process without Custom.BoardColumnTitle rejects the field list
        got = get_items(cfg, [wid], fields=["System.State", "System.AssignedTo", "System.IterationPath",
                                            "System.WorkItemType", "System.Title"])
    if not got:
        return None
    f = got[0]["fields"]
    who = f.get("System.AssignedTo")
    return {"type": f.get("System.WorkItemType"), "title": f.get("System.Title"), "state": f.get("System.State"),
            "board": f.get("Custom.BoardColumnTitle", ""), "iteration": f.get("System.IterationPath", ""),
            "assigned": who.get("displayName", "") if isinstance(who, dict) else (who or "")}


def pr_live(cfg, r):
    x = ado("GET", f"{repo_api(cfg, r)}/pullrequests/{r['pr']['id']}?api-version=7.1")
    votes = [v.get("vote", 0) for v in x.get("reviewers", [])]
    return {"status": x["status"], "draft": x.get("isDraft", False), "merge": x.get("mergeStatus", ""),
            "approved": sum(1 for v in votes if v >= 5), "rejected": sum(1 for v in votes if v <= -5)}


def verdict(ado_state, data, repos):
    if not data:
        return "not started in sdd"
    prog = data.get("progress") or {}
    prs = [r["pr_live"] for r in repos if r.get("pr_live")]
    if prog.get("status") == "abandoned":
        return "abandoned"
    if data.get("removed"):
        return "completed — folder cleaned up"
    # the folder is still on disk here: "completed" only once /sdd done has removed it
    if prs and all(p["status"] == "completed" for p in prs):
        return "PRs merged — run /sdd done to clean up"
    if prog.get("status") == "done":
        return "closed out — run /sdd done to clean up"
    if prog.get("status") == "waiting":
        return f"waiting on you: {prog.get('gate') or prog.get('phase')}"
    if prog.get("status") == "blocked":
        return f"blocked at {prog.get('phase')}: {prog.get('note')}"
    if prog:
        return f"in progress at {prog.get('phase')}"
    return "folder exists, no progress recorded"


def cmd_status(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = find_env(root, cfg, a.id)
    data = read_env(env_dir) if env_dir else None
    rec = done_dir(root, cfg) / f"{a.id}.json"
    if not data and rec.is_file():
        data = read_record(rec)
    out = {"id": a.id, "ado": None, "folder": str(env_dir) if env_dir else None,
           "progress": (data or {}).get("progress"), "history": ((data or {}).get("history") or [])[-5:],
           "repos": [], "spec": spec_state(root, cfg, a.id)}
    try:
        out["ado"] = live_item(cfg, a.id)
    except (RuntimeError, SystemExit) as e:
        out["ado_error"] = str(e)
    for n, r in ((data or {}).get("repos") or {}).items():
        row = {"repo": n, "branch": r["branch"], "base": r["base"], "pr": (r.get("pr") or {}).get("url")}
        p = env_dir / r["path"] if env_dir else None
        if p and p.exists():
            row["dirty"] = bool(git(["status", "--porcelain"], p, check=False))
            row["ahead"] = git(["rev-list", "--count", f"origin/{r['base']}..HEAD"], p, check=False)
        if r.get("pr"):
            try:
                row["pr_live"] = pr_live(cfg, r)
            except RuntimeError as e:
                row["pr_error"] = str(e)[:200]
        out["repos"].append(row)
    out["gates"] = sorted(gates_met(root, cfg, a.id, data, env_dir)) if data else []
    out["verdict"] = verdict(out["ado"], data, out["repos"])
    if a.json:
        print(json.dumps(out, indent=2))
        return
    ad = out["ado"] or {}
    print(f"ADO {a.id} — {ad.get('title') or (data or {}).get('title', '?')}")
    print(f"  verdict:  {out['verdict']}")
    if ad:
        print(f"  ADO:      {ad['type']}, {ad['state']}" + (f" / {ad['board']}" if ad.get("board") else "")
              + f", {ad['assigned'] or 'unassigned'}, {ad['iteration']}")
    elif out.get("ado_error"):
        print(f"  ADO:      not read ({out['ado_error'][:120]})")
    pg = out["progress"]
    if pg:
        print(f"  progress: {pg['flow']} / {pg['phase']} / {pg['status']} at {pg['at']}"
              + (f"\n            next: {pg['next']}" if pg.get("next") else "")
              + (f"\n            note: {pg['note']}" if pg.get("note") else ""))
        if pg.get("status") == "waiting" and pg.get("refs"):
            lines, _, _ = build_refs(root, cfg, a.id, pg["refs"])
            print("  links for the waiting gate:\n" + "\n".join("    " + x for x in lines))
    if out["gates"]:
        print(f"  gates:    {', '.join(out['gates'])}")
    sp = out["spec"]
    if sp:
        tasks = f", tasks {sp['tasks_done']}/{sp['tasks_total']}" if "tasks_total" in sp else ""
        print(f"  spec:     {sp['folder']} ({', '.join(sp['files'])}{tasks})")
    else:
        print("  spec:     not synced")
    print(f"  folder:   {out['folder'] or 'none'}")
    for r in out["repos"]:
        state = ("DIRTY" if r.get("dirty") else "clean") if "dirty" in r else "no worktree"
        pr = r["pr"] or "no PR"
        if r.get("pr_live"):
            pl = r["pr_live"]
            pr += f" [{pl['status']}{', draft' if pl['draft'] else ''}, {pl['approved']} approved"
            pr += f", {pl['rejected']} rejected]" if pl["rejected"] else "]"
        print(f"  {r['repo']:<28} {r['branch']}  ahead {r.get('ahead', '-')}  {state}  {pr}")
    for h in out["history"][:-1]:
        print(f"  earlier:  {h['at']} {h['phase']} / {h['status']}")


# ---------------------------------------------------------------- view

def view_item(root, cfg, data, env_dir, full):
    wid = data["id"]
    sp = spec_state(root, cfg, wid)
    if sp:
        sp["path"] = str((root / sp["folder"]).resolve())
    project = data.get("project") or (cfg["ado"]["projects"] or [""])[0]
    out = {k: data.get(k) for k in ("id", "type", "title", "state", "project", "flow", "slug", "created",
                                     "removed", "repos", "gates", "progress")}
    out.update(folder=str(env_dir) if env_dir else None, spec=sp,
               met=sorted(gates_met(root, cfg, wid, data, env_dir)) if env_dir else sorted(data.get("gates") or {}),
               url=f"{org_url(cfg)}/{urllib.parse.quote(project)}/_workitems/edit/{wid}" if cfg["ado"]["org"] else None)
    if full:
        out["history"] = data.get("history") or []
    flow = (data.get("progress") or {}).get("flow") or data.get("flow")
    out["path"] = flow_path(flow, data)  # the spec flow's full / short; None for the bug flow, or not chosen yet
    out["stages"] = stage_record(flow, data) if flow in FLOWS["flows"] else {}
    out["feedback"] = {}  # stage -> gates a reopen there revokes; only stages that take feedback now
    for s in FLOWS["flows"].get(flow, {}).get("stages", []) if env_dir else []:
        ok, _, revoke = reopen_plan(data, s["key"])
        if ok:
            out["feedback"][s["key"]] = revoke
    return out


def cmd_view(a):
    """Read-only snapshot for the sdd view: every item in progress, recent done records, the flows
    table, and with --id one item's full history. Local files only — no ADO call, no writes."""
    root = require_root()
    cfg = load_config(root)
    base = wt_root(root, cfg)
    items, done = [], []
    for d in sorted(base.iterdir() if base.is_dir() else []):
        if d.is_dir() and d.name != ".done" and (d / "workitem.json").is_file():
            try:
                data = read_env(d)
                items.append(view_item(root, cfg, data, d, full=a.id == data.get("id")))
            except (OSError, ValueError, KeyError):
                continue
    recs = sorted(done_dir(root, cfg).glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for rec in recs:
        try:
            data = read_record(rec)
        except (OSError, ValueError):
            continue
        if len(done) < 8 or a.id == data.get("id"):
            done.append(view_item(root, cfg, data, None, full=a.id == data.get("id")))
    print(json.dumps({"root": str(root), "specRoot": str((root / cfg["specRoot"]).resolve()), "colors": cfg["view"]["colors"], "autoOpen": bool(cfg["view"].get("autoOpen", True)),
                      "flows": FLOWS["flows"], "derived": FLOWS["derived"], "items": items, "done": done},
                     indent=None if a.compact else 2))

def build_graph(env_dir):
    src, out = env_dir / "src", env_dir / "graph"
    exe = shutil.which("graphify")
    if not exe:
        print("warning: graphify not on PATH; skipped the graph (pip install graphifyy)")
        return
    r = subprocess.run([exe, "update", str(src)], text=True, capture_output=True)
    for line in (r.stdout or "").splitlines():
        if "Rebuilt" in line:
            print(line.strip())
    produced = src / "graphify-out"
    if r.returncode != 0 or not produced.is_dir():
        print(f"warning: graphify failed:\n{(r.stderr or r.stdout).strip()[-800:]}")
        return
    if out.exists():
        shutil.rmtree(out, onerror=_force)
    shutil.move(str(produced), str(out))
    print(f"graph: {out / 'graph.json'}")


def cmd_graph(a):
    root = require_root()
    build_graph(env_or_die(root, load_config(root), a.id))


# ---------------------------------------------------------------- pr

def pr_url(cfg, r, pid):
    return f"{org_url(cfg)}/{r['project']}/_git/{r['adoRepo']}/pullrequest/{pid}"


def repo_api(cfg, r):
    return f"{org_url(cfg)}/{r['project']}/_apis/git/repositories/{r['adoRepo']}"


def cmd_pr(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    ok, reasons, _ = check_op(root, cfg, a.id, "pr")
    if not ok:
        die("not raising a PR:\n  " + "\n  ".join(reasons))
    data = read_env(env_dir)
    desc = Path(a.description_file).read_text(encoding="utf-8")
    if len(desc) > 4000:
        die(f"description is {len(desc)} chars; ADO allows 4000. Move detail into PR comments")
    found = mentions(desc) + mentions(a.title)
    if found:
        die(f"the PR text names {', '.join(found)}. ADO reads `#<id>` as a mention and posts a comment onto "
            f"that work item. Write `ADO {found[0][1:]}` instead; AB#<id> in the title is fine")
    wis = [int(x) for x in (a.work_items or str(a.id)).split(",") if x.strip()]
    only = {x.strip() for x in (a.repos or "").split(",") if x.strip()}
    for n, r in data["repos"].items():
        if only and n not in only:
            continue
        p = env_dir / r["path"]
        if r.get("pr"):
            print(f"{n}: PR already open: {r['pr']['url']}")
            continue
        if git(["status", "--porcelain"], p, check=False):
            die(f"{n}: uncommitted changes in {p}. Commit or stash first")
        if git(["rev-list", "--count", f"origin/{r['base']}..HEAD"], p) == "0":
            print(f"{n}: no commits ahead of {r['base']}, skipped")
            continue
        git(["push", "-u", "origin", r["branch"]], p, capture=False)
        body = {"sourceRefName": f"refs/heads/{r['branch']}", "targetRefName": f"refs/heads/{r['base']}",
                "title": a.title, "description": desc, "isDraft": a.draft,
                "workItemRefs": [{"id": str(w)} for w in wis]}
        try:
            res = ado("POST", f"{repo_api(cfg, r)}/pullrequests?api-version=7.1", body)
        except RuntimeError as e:
            if "TF401179" not in str(e):  # an active PR for this source/target already exists
                raise
            q = (f"{repo_api(cfg, r)}/pullrequests?searchCriteria.sourceRefName=refs/heads/{r['branch']}"
                 f"&searchCriteria.status=active&api-version=7.1")
            res = ado("GET", q)["value"][0]
        r["pr"] = {"id": res["pullRequestId"], "url": pr_url(cfg, r, res["pullRequestId"])}
        write_env(env_dir, data)
        print(f"{n}: PR {r['pr']['id']} {r['pr']['url']}")


# ---------------------------------------------------------------- remove

def _force(func, path, _):
    os.chmod(path, stat.S_IWRITE)
    func(path)


OPS = ("start", "resume", "phase", "pr", "done", "abandon", "reopen")


def repo_dirs(env_dir, data):
    """{repo: (worktree dir, base branch)} of a work item folder."""
    return {n: (env_dir / r["path"], r["base"]) for n, r in ((data or {}).get("repos") or {}).items()}


def proof_missing(flow, data, env_dir, gate):
    """What `gate` still needs before it may pass, from flows.json "proofs"; [] when it needs no proof."""
    rule = PROOFS.get(flow, {}).get(gate)
    if not rule:
        return []
    try:
        return proof.missing(data, gate, rule, repo_dirs(env_dir, data) if env_dir else {})
    except RuntimeError as e:
        return [f"'{gate}': could not check the worktree ({e})"]


def pick_repo(data, want):
    repos = list((data.get("repos") or {}))
    if want:
        return want if want in repos else die(f"no repo {want} in this work item; it has {', '.join(repos) or 'none'}")
    if len(repos) == 1:
        return repos[0]
    die(f"this work item has {', '.join(repos) or 'no repos'}: say which one with --repo")


def command_of(a):
    cmd = [c for c in (a.command or [])]
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        die("no command: put it after --, e.g. env.py run --id 5 --gate \"Red test\" --expect fail -- dotnet test ...")
    return cmd[0] if len(cmd) == 1 else subprocess.list2cmdline(cmd) if sys.platform == "win32" else " ".join(
        c if re.fullmatch(r"[\w@%+=:,./-]+", c) else "'" + c.replace("'", "'\\''") + "'" for c in cmd)


def show_run(rec):
    print(f"{rec['repo']}: {rec['gate']} / {rec.get('kind', 'run')}: {'OK' if rec['ok'] else 'NOT OK'} "
          f"(exit {', '.join(str(x) for x in rec.get('exits', []))})")
    if rec.get("tail"):
        print(rec["tail"])


def cmd_run(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    data = read_env(env_dir)
    repo = pick_repo(data, a.repo)
    d, _ = repo_dirs(env_dir, data)[repo]
    rec = proof.run(data, repo, d, a.gate, command_of(a), a.expect, a.repeat, a.suite, a.timeout)
    write_env(env_dir, data)
    show_run(rec)
    if not rec["ok"]:
        sys.exit(1)


def cmd_revert_check(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    data = read_env(env_dir)
    repo = pick_repo(data, a.repo)
    d, base = repo_dirs(env_dir, data)[repo]
    try:
        rec = proof.revert_check(data, repo, d, base, a.gate, command_of(a), a.fix, a.timeout)
    except RuntimeError as e:
        die(str(e))
    write_env(env_dir, data)
    show_run(rec)
    if not rec["ok"]:
        print("The test must fail without the fix and pass with it. A test that passes without the fix "
              "guards nothing: rewrite it.")
        sys.exit(1)


def cmd_verify(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    data = read_env(env_dir)
    sp = spec_folder(root, cfg, a.id)
    tasks_md = sp / "tasks.md" if sp else None
    if not tasks_md or not tasks_md.is_file():
        die("no tasks.md for this work item: Decompose writes it")
    tasks = proof.parse_tasks(tasks_md.read_text(encoding="utf-8"))
    recs, manual, unclear = proof.verify(data, repo_dirs(env_dir, data), tasks, a.gate, a.timeout)
    write_env(env_dir, data)
    for r in recs:
        for t in r["tasks"]:
            print(f"task {t['task']} ({r['repo']}): {'pass' if t['ok'] else 'FAIL'}  {t['command']}")
            if not t["ok"]:
                print("    " + t["tail"].replace("\n", "\n    "))
    for t in manual:
        print(f"task {t['n']}: check by hand — {t['verify'] or 'no Verify line'}")
    for t in unclear:
        print(f"task {t['n']}: not run — say which repo with a `- Repo: <name>` line under it")
    bad = [t for r in recs for t in r["tasks"] if not t["ok"]]
    print(f"{sum(len(r['tasks']) for r in recs) - len(bad)} passed, {len(bad)} failed, {len(manual)} by hand, "
          f"{len(unclear)} unclear")
    if bad or unclear:
        sys.exit(1)

# The stages of each flow live in flows.json, which the view draws too. What each phase needs before
# it may start: recorded gates are passed with `progress --passed` only after the user said yes; the
# DERIVED ones are read from the facts on disk.
FLOWS = json.loads((Path(__file__).with_name("flows.json")).read_text(encoding="utf-8"))
PHASE_NEEDS = {f: {s["key"]: s["needs"] for s in v["stages"] if s["needs"]} for f, v in FLOWS["flows"].items()}
PR_GATE = {f: v["prGates"] for f, v in FLOWS["flows"].items()}
PROOFS = {f: v.get("proofs", {}) for f, v in FLOWS["flows"].items()}
PATHS = {f: v.get("paths") for f, v in FLOWS["flows"].items() if v.get("paths")}


def flow_path(flow, data):
    """The way through the flow the user chose (flows.json "paths"), or None while nobody has. An item
    started before paths existed and already past Design counts as the full path."""
    if flow not in PATHS:
        return None
    data = data or {}
    if data.get("path"):
        return data["path"]
    if "Design agreed" in (data.get("gates") or {}) or set(data.get("stages") or {}) & {"Decompose", "Implement", "Verify", "Review"}:
        return "full"
    return None


def stage_needs(flow, data, key):
    """The gates `key` needs on this item's path."""
    drop = set(((PATHS.get(flow) or {}).get(flow_path(flow, data) or "", {}) or {}).get("dropNeeds", {}).get(key, []))
    return [g for g in PHASE_NEEDS.get(flow, {}).get(key, []) if g not in drop]
DERIVED = tuple(FLOWS["derived"])
BUG_PHASES = [s["key"] for s in FLOWS["flows"]["bug"]["stages"]]
SPEC_PHASES = [s["key"] for s in FLOWS["flows"]["spec"]["stages"]]


def phase_key(flow, phase):
    """'Phase 12 — Pull request' -> 'Phase 12'; 'Implement (task 3/7)' -> 'Implement'."""
    if flow == "bug":
        m = re.match(r"\s*Phase\s+(\d+)\b", phase or "", re.I)
        key = f"Phase {m.group(1).lower()}" if m else None
        return key if key in BUG_PHASES else None
    for k in SPEC_PHASES:
        if (phase or "").strip().lower().startswith(k.lower()):
            return k
    return None


def stage_keys(flow):
    return [s["key"] for s in FLOWS["flows"].get(flow, {}).get("stages", [])]


def stage_record(flow, data):
    """key -> {"at", "status": worked|done|skipped[, "confirmed"]} for each stage the item went through.
    Kept in workitem.json "stages". An item from before that field falls back to its history: a stage
    with any row counts as done, the current one as worked."""
    if (data or {}).get("stages") is not None:
        return dict(data["stages"])
    rec, cur = {}, phase_key(flow, ((data or {}).get("progress") or {}).get("phase"))
    for h in (data or {}).get("history") or []:
        k = phase_key(flow, h.get("phase"))
        if k and k not in rec:
            rec[k] = {"at": h["at"], "status": "done"}
    if cur in rec and ((data or {}).get("progress") or {}).get("status") != "done":
        rec[cur]["status"] = "worked"
    return rec


def is_conditional(flow, key):
    return any(s["key"] == key and s.get("conditional") for s in FLOWS["flows"].get(flow, {}).get("stages", []))


def not_needed(flow, data, key, open_q):
    """A stage with no record that nothing needs: a conditional one while there is nothing to do (no open
    questions), or one flagged inferFromGates whose gates are all passed already (an item from before the stage existed)."""
    stage = next(s for s in FLOWS["flows"][flow]["stages"] if s["key"] == key)
    if stage.get("conditional"):
        return not open_q
    gates = (data or {}).get("gates") or {}
    return bool(stage.get("inferFromGates")) and all(g in gates for g in stage["passes"])


def open_conditional(flow, data, key, open_q):
    """A conditional stage that still has questions to ask: open questions exist and the user has not
    answered them or chosen to continue (the stage's gate is not passed)."""
    stage = next(s for s in FLOWS["flows"][flow]["stages"] if s["key"] == key)
    gates = (data or {}).get("gates") or {}
    return bool(stage.get("conditional") and open_q and not all(g in gates for g in stage["passes"]))


def unaccounted(flow, data, key, open_q=0):
    """The stages before `key` that were never worked and never skipped with the user's yes."""
    keys, rec = stage_keys(flow), stage_record(flow, data)
    return [k for k in keys[:keys.index(key)]
            if (k not in rec and not not_needed(flow, data, k, open_q)) or open_conditional(flow, data, k, open_q)]


def unfinished(flow, data, open_q=0):
    """The stages that are not done and not skipped: what still blocks the flow from being finished."""
    rec = stage_record(flow, data)
    return [k for k in stage_keys(flow)
            if ((rec.get(k) or {}).get("status") not in ("done", "skipped")
                and not (k not in rec and not_needed(flow, data, k, open_q))) or open_conditional(flow, data, k, open_q)]


def mark_stage(flow, data, key, entry):
    """The stage record after `entry` for stage `key`: the stages before it are finished (moving on
    finishes a worked stage), the stages after it are cleared (going back means they are redone)."""
    keys, rec = stage_keys(flow), stage_record(flow, data)
    i = keys.index(key)
    for k in keys[:i]:
        if rec.get(k, {}).get("status") == "worked":
            rec[k] = {**rec[k], "status": "done"}
    for k in keys[i + 1:]:
        rec.pop(k, None)
    if entry["status"] == "skipped":
        rec[key] = {"at": entry["at"], "status": "skipped", "confirmed": entry["confirmed"]}
    elif entry["status"] == "done":
        rec[key] = {"at": rec.get(key, {}).get("at", entry["at"]), "status": "done", "doneAt": entry["at"]}
    elif entry["status"] != "abandoned":
        rec[key] = {"at": rec.get(key, {}).get("at", entry["at"]), "status": "worked"}
    return rec


def gates_met(root, cfg, wid, data, env_dir):
    met = set((data or {}).get("gates") or {})
    repos = (data or {}).get("repos") or {}
    if repos and env_dir and all((env_dir / r["path"]).exists() for r in repos.values()):
        met.add("Worktree")
    if any(r.get("pr") for r in repos.values()):
        met.add("PR raised")
    sp = spec_state(root, cfg, wid) or {}
    if sp.get("tasks_total"):
        met.add("Tasks written")
        if sp["tasks_done"] == sp["tasks_total"]:
            met.add("Tasks done")
    return met


def reopen_plan(data, phase):
    """May the item go back to `phase` for the person's feedback? -> (ok, reasons, gates to revoke).
    Allowed for a stage already done, or the current stage while it waits on the person (an approval
    or a go-ahead). Going back revokes every recorded gate that stage or a later one passes; Claimed
    and the facts on disk (worktree, tasks, PR) stay."""
    if not data:
        return False, ["no work item folder — nothing has been started"], []
    prog = data.get("progress") or {}
    flow = prog.get("flow") or data.get("flow")
    if data.get("removed") or prog.get("status") in ("done", "abandoned"):
        return False, [f"the flow is {prog.get('status') or 'removed'}; start it again with /sdd {data.get('id')}"], []
    stages = [s["key"] for s in FLOWS["flows"].get(flow, {}).get("stages", [])]
    target, cur = phase_key(flow, phase), phase_key(flow, prog.get("phase"))
    if target is None:
        return False, [f"unknown {flow} stage '{phase}'"], []
    if cur is None:
        return False, ["no current stage is recorded"], []
    t, c = stages.index(target), stages.index(cur)
    if t > c:
        return False, [f"{target} has not started yet (the item is at {cur})"], []
    if t == c and prog.get("status") != "waiting":
        return False, [f"{target} is still {prog.get('status')}; feedback opens once it waits on you"], []
    later = FLOWS["flows"][flow]["stages"][t:]
    passes = [g for s in later for g in s["passes"] if g != "Claimed" and g not in DERIVED]
    return True, [], [g for g in passes if g in (data.get("gates") or {})]


def check_op(root, cfg, wid, op, flow=None, phase=None):
    """Is `op` allowed for this work item right now? -> (ok, reasons, notes). The single source of
    truth for state guards: /sdd refuses and explains instead of running an operation out of turn."""
    env_dir = find_env(root, cfg, wid)
    data = read_env(env_dir) if env_dir else None
    rec = done_dir(root, cfg) / f"{wid}.json"
    if not data and rec.is_file():
        data = read_record(rec)
    prog = (data or {}).get("progress") or {}
    status, cur_phase = prog.get("status"), prog.get("phase", "")
    reasons, notes = [], []

    if op == "reopen":
        ok, why, revoke = reopen_plan(data if env_dir else None, phase or "")
        return ok, why, [f"revokes: {', '.join(revoke)}"] if ok and revoke else []

    if data and data.get("removed"):
        when = data["removed"][:10]
        if op == "start":
            notes.append(f"{'abandoned' if status == 'abandoned' else 'completed'} on {when}; starting again begins from scratch")
        else:
            return False, [f"already {'abandoned' if status == 'abandoned' else 'completed'} and cleaned up on {when}"], []
    if op == "start":
        if env_dir and status in ("active", "waiting", "blocked"):
            reasons.append(f"already in progress ({prog.get('flow')} / {cur_phase} / {status}). Resume with /sdd {wid}")
        return not reasons, reasons, notes
    if op == "phase" and not (flow or prog.get("flow") or (data or {}).get("flow")):
        return False, ["the flow is not known yet; pass --flow bug or --flow spec"], []
    if not env_dir:
        if op == "phase" and phase_key(flow, phase) is None:
            return False, [f"unknown {flow} phase '{phase}'"], []
        if op == "phase" and not PHASE_NEEDS.get(flow, {}).get(phase_key(flow, phase) or "", []):
            return True, [], []
        return False, [f"no work item folder for {wid} — nothing has been started. Start with /sdd {wid}"], []
    if op == "resume":
        if not prog:
            reasons.append("the folder exists but no progress was recorded; start the flow and pick the phase by hand")
        elif status in ("done", "abandoned"):
            reasons.append(f"the flow is {status}; nothing to resume")
        return not reasons, reasons, notes

    met = gates_met(root, cfg, wid, data, env_dir)
    if op == "phase":
        flow = flow or prog.get("flow") or data.get("flow")
        key = phase_key(flow, phase)
        if key is None:
            return False, [f"unknown {flow} phase '{phase}'"], []
        # a stage recorded done means the flow is over only for the last stage; any other done stage just hands over
        keys = stage_keys(flow)
        cur_key = phase_key(flow, cur_phase)
        if status == "abandoned" or (status == "done" and (cur_key is None or cur_key == keys[-1])):
            return False, [f"the flow is {status}"], []
        reasons += [f"{k} was never worked and never skipped — do it first, or ask the user to skip it"
                    for k in unaccounted(flow, data, key, open_questions(root, cfg, wid))]
        rule = PATHS.get(flow)
        if rule and key != rule["choose"] and keys.index(key) > keys.index(rule["choose"]) and not flow_path(flow, data):
            choices = " / ".join(k for k in rule if k != "choose")
            reasons.append(f"no path chosen for this item ({choices}). Ask the user which, then record their answer: "
                           f"env.py path --id {wid} --set <path> --confirmed \"<the user's words>\"")
        missing = [g for g in stage_needs(flow, data, key) if g not in met]
        reasons += [f"{key} needs '{g}' first — " + ("not true on disk yet" if g in DERIVED else "not recorded as passed")
                    for g in missing]
        return not reasons, reasons, notes

    repos = []
    for n, r in data["repos"].items():
        pth = env_dir / r["path"]
        # a folder with no .git is what a half-failed remove leaves; git run there would read the
        # workspace root repo instead, so treat it as already removed
        exists = (pth / ".git").exists()
        repos.append((n, r, pth, exists,
                      exists and bool(git(["status", "--porcelain"], pth, check=False)),
                      git(["rev-list", "--count", f"origin/{r['base']}..HEAD"], pth, check=False) if exists else "0"))

    if op == "abandon":
        if status == "done":
            reasons.append("the flow is done; use /sdd done to clean up instead")
        for n, r, pth, exists, dirty, ahead in repos:
            if dirty:
                reasons.append(f"{n}: uncommitted changes in {pth}. Show the user what they are; commit, stash or discard them first")
            if exists and git(["ls-remote", "--heads", "origin", r["branch"]], pth, check=False):
                notes.append(f"{n}: remote branch {r['branch']} is pushed; left in place (deleting it is the user's call)")
            if r.get("pr"):
                notes.append(f"{n}: PR {r['pr']['url']} left as it is (closing it is the user's call)")
        return not reasons, reasons, notes

    # close-out writes status "done" before /sdd done runs, so only an abandoned flow blocks "done"
    if status == "abandoned" or (status == "done" and op != "done"):
        reasons.append(f"the flow is {status}")
    if op == "pr":
        for g in PR_GATE.get(prog.get("flow") or data.get("flow"), []):
            if g not in met:
                reasons.append(f"the PR needs '{g}' first — not recorded as passed")
            elif env_dir:
                reasons += [f"{m}: the PR needs it" for m in
                            proof_missing(prog.get("flow") or data.get("flow"), data, env_dir, g)]
        if not any(ahead not in ("0", "") and not r.get("pr") for _, r, _, _, _, ahead in repos):
            reasons.append("no repo has commits without a PR — nothing to raise")
        for n, r, pth, exists, dirty, ahead in repos:
            if dirty:
                reasons.append(f"{n}: uncommitted changes in {pth}; commit them (or stash) first")
        return not reasons, reasons, notes

    # op == "done": every stage done or skipped by the user, every repo merged, the close-out in ADO
    flow = prog.get("flow") or data.get("flow")
    left = [k for k in unfinished(flow, data, open_questions(root, cfg, wid)) if not (k == phase_key(flow, cur_phase) and status == "done")]
    if left:
        reasons.append(f"not every stage is done: {', '.join(left)}. Do them (resume with /sdd {wid}), or ask "
                       "the user to skip each one and record it with --status skipped --confirmed")
    for n, r, pth, exists, dirty, ahead in repos:
        if dirty:
            reasons.append(f"{n}: uncommitted changes in {pth}")
        if not r.get("pr"):
            if ahead not in ("0", ""):
                reasons.append(f"{n}: has commits but no PR. Raise it (resume with /sdd {wid}) or /sdd abandon {wid}")
            continue
        try:
            st = pr_live(cfg, r)["status"]
        except RuntimeError as e:
            reasons.append(f"{n}: could not read PR {r['pr']['url']}: {str(e)[:120]}")
            continue
        if st != "completed":
            reasons.append(f"{n}: PR {r['pr']['url']} is {st}, not merged yet")
    try:
        live = live_item(cfg, wid) or {}
    except RuntimeError as e:
        live = {}
        reasons.append(f"could not read ADO {wid}: {str(e)[:120]}")
    if live and live.get("state") not in cfg.get("doneStates", ["Resolved", "Closed", "Done"]):
        reasons.append(f"ADO {wid} is still {live.get('state')}"
                       + (f" / {live['board']}" if live.get("board") else "")
                       + f" — the flow's close-out (write-back to the work item) has not run. Resume with /sdd {wid}")
    return not reasons, reasons, notes


def cmd_can(a):
    root = require_root()
    cfg = load_config(root)
    if a.op == "reopen" and not a.phase:
        die("--op reopen needs --phase: the stage to go back to")
    if a.op == "phase" and not a.phase:
        die("--op phase needs --phase (and --flow when nothing is recorded yet)")
    ok, reasons, notes = check_op(root, cfg, a.id, a.op, a.flow, a.phase)
    read = stage_doc(a.flow or recorded_flow(root, cfg, a.id), a.phase) if a.op == "phase" and ok else None
    if a.json:
        print(json.dumps({"id": a.id, "op": a.op, "ok": ok, "reasons": reasons, "notes": notes, "read": read},
                         indent=2))
    else:
        print(f"{a.op} {a.id}: {'allowed' if ok else 'NOT allowed'}")
        for x in reasons:
            print(f"  because: {x}")
        for x in notes:
            print(f"  note:    {x}")
        if read:
            print(f"  read:    {read}   (the stage's steps: read it before you start)")
    sys.exit(0 if ok else 3)


def stage_doc(flow, phase):
    """The stage's own file (flows.json "doc"), as a path to read; None when unknown."""
    key = phase_key(flow, phase)
    doc = next((s.get("doc") for s in FLOWS["flows"].get(flow, {}).get("stages", []) if s["key"] == key), None)
    return str(PLUGIN / doc) if doc else None


def recorded_flow(root, cfg, wid):
    env_dir = find_env(root, cfg, wid)
    data = read_env(env_dir) if env_dir else {}
    return (data.get("progress") or {}).get("flow") or data.get("flow")


def cmd_path(a):
    """Record the way through the flow the user chose. Short only before Decompose starts."""
    root = require_root()
    cfg = load_config(root)
    env_dir, data = ensure_env(root, cfg, a.id)
    flow = (data.get("progress") or {}).get("flow") or data.get("flow")
    rule = PATHS.get(flow)
    if not rule:
        die(f"the {flow or 'unknown'} flow has one path only")
    if a.set not in rule or a.set == "choose":
        die(f"no path '{a.set}'; the {flow} flow has {', '.join(k for k in rule if k != 'choose')}")
    if not (a.confirmed or "").strip():
        die("a path is the user's choice: ask them, then pass their words with --confirmed")
    if a.set != "full" and set(data.get("stages") or {}) & {"Decompose", "Implement", "Verify", "Review"}:
        die(f"too late for the {a.set} path: Decompose has started. It stays {flow_path(flow, data) or 'full'}")
    data["path"] = a.set
    data["pathChosen"] = {"at": now(), "path": a.set, "confirmed": a.confirmed.strip()}
    write_env(env_dir, data)
    print(f"{a.id}: {rule[a.set]['label']}")


def cmd_reopen(a):
    """Send the item back to a stage for the person's feedback: phase = that stage, status active,
    the gates it and later stages pass revoked, one history row that says so."""
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    data = read_env(env_dir)
    ok, why, revoke = reopen_plan(data, a.phase)
    if not ok:
        die("not reopening:\n  " + "\n  ".join(why))
    prog = data.get("progress") or {}
    flow = prog.get("flow") or data.get("flow")
    key = phase_key(flow, a.phase)
    entry = {"at": now(), "flow": flow, "phase": key, "status": "active", "gate": "", "next": "",
             "note": f"Reopened from {prog.get('phase')} for feedback: {a.note}", "refs": [],
             "gates": {"passed": [], "revoked": revoke}}
    for g in revoke:
        data["gates"].pop(g, None)
    data["stages"] = mark_stage(flow, data, key, entry)
    data["progress"] = entry
    data["history"] = (data.get("history") or [])[-49:] + [entry]
    write_env(env_dir, data)
    print(f"{a.id}: back to {flow} / {key} / active" + (f"; revoked {', '.join(revoke)}" if revoke else ""))


def cmd_remove(a):
    root = require_root()
    cfg = load_config(root)
    env_dir = env_or_die(root, cfg, a.id)
    data = read_env(env_dir)
    ok, blockers, notes = check_op(root, cfg, a.id, "abandon" if a.abandon else "done")
    if not ok:
        die("not removing:\n  " + "\n  ".join(blockers))
    print(f"will remove {env_dir}")
    for n, r in data["repos"].items():
        print(f"  {n}: worktree {r['path']}, local branch {r['branch']}")
    for x in notes:
        print(f"  note: {x}")
    if not a.yes:
        print("dry run. Add --yes to do it")
        return
    for n, r in data["repos"].items():
        src = root / r["source"]
        p = env_dir / r["path"]
        # A remove that failed half-way (e.g. a file lock on Windows) can leave the folder on disk
        # after git has dropped the worktree; then only the rmtree below can clear it.
        listed = {Path(line[len("worktree "):]).resolve()
                  for line in git(["worktree", "list", "--porcelain"], src).splitlines()
                  if line.startswith("worktree ")}
        if p.exists() and p.resolve() in listed:
            git(["worktree", "remove", str(p)], src)
        git(["worktree", "prune"], src)
        if git(["branch", "--list", r["branch"]], src):
            git(["branch", "-D", r["branch"]], src)
        print(f"{n}: removed")
    # keep a small record so /sdd status can still answer "is this done?" once the folder is gone
    data["removed"] = now()
    final = {"at": now(), "flow": (data.get("progress") or {}).get("flow", data.get("flow", "")),
             "phase": "removed", "status": "abandoned" if a.abandon else "done", "gate": "", "next": "",
             "note": "abandoned; folder removed" if a.abandon else "PRs merged; folder removed"}
    data["progress"], data["history"] = final, (data.get("history") or [])[-49:] + [final]
    done_dir(root, cfg).mkdir(parents=True, exist_ok=True)
    (done_dir(root, cfg) / f"{data['id']}.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    shutil.rmtree(env_dir, onerror=_force)
    print(f"removed {env_dir} (record kept in {done_dir(root, cfg) / (str(data['id']) + '.json')})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("init"); s.add_argument("--spec-root", default=DEFAULTS["specRoot"])
    s = sp.add_parser("type"); s.add_argument("--id", type=int, required=True)
    s = sp.add_parser("doctor"); s.add_argument("--json", action="store_true")
    sp.add_parser("upgrade-config", help="add new settings' defaults to .claude/sdd.json (SessionStart hook)")
    s = sp.add_parser("new")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--repos", required=True, help="comma-separated folder names")
    s.add_argument("--version", help="team/{version} is the base for every repo without --base")
    s.add_argument("--base", action="append", help="Repo=branch, repeatable, e.g. HealthCodeIndex_Tariff=main")
    s.add_argument("--branch", help="override the branch name")
    s.add_argument("--title", help="skip the ADO lookup (with --type)")
    s.add_argument("--type", help="skip the ADO lookup (with --title)")
    s.add_argument("--no-graph", action="store_true")
    s = sp.add_parser("status"); s.add_argument("--id", type=int, required=True); s.add_argument("--json", action="store_true")
    s = sp.add_parser("graph"); s.add_argument("--id", type=int, required=True)
    s = sp.add_parser("progress")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--flow", required=True, choices=["bug", "spec"])
    s.add_argument("--phase", required=True, help="e.g. \"Phase 6 — Approval gate\" or \"Implement\"")
    s.add_argument("--status", required=True, choices=PROGRESS_STATUS)
    s.add_argument("--gate", help="the question waiting for the user, when --status waiting")
    s.add_argument("--next", help="the next concrete step, so a new session can pick it up")
    s.add_argument("--note", help="anything the next session must know: task 3/7, blocker, decision")
    s.add_argument("--ref", action="append", default=[], help="spec file or code path[:line[-end]] the user decides on; required with --status waiting")
    s.add_argument("--no-visual", metavar="WHY", help="a waiting gate with nothing to explain (plain choice); otherwise an .html sdd:visual ref is required")
    s.add_argument("--confirmed", metavar="WORDS", help="with --status skipped: the user's own words agreeing to skip this stage")
    s.add_argument("--caveat", metavar="TEXT", help="finishing Open Questions with questions still open: the user chose to continue; what was left open")
    s.add_argument("--passed", action="append", default=[], help="gate the user just approved, repeatable")
    s.add_argument("--revoke", action="append", default=[], help="gate no longer valid (e.g. spec changed), repeatable")
    s = sp.add_parser("pr")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--title", required=True)
    s.add_argument("--description-file", required=True)
    s.add_argument("--repos")
    s.add_argument("--work-items", help="comma-separated ids to link; default is --id")
    s.add_argument("--draft", action="store_true")
    s = sp.add_parser("refs")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--ref", action="append", default=[], help="spec file or code path[:line[-end]], or ado")
    s = sp.add_parser("can")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--op", required=True, choices=OPS)
    s.add_argument("--flow", choices=["bug", "spec"])
    s.add_argument("--phase", help="with --op phase: the phase about to start; with --op reopen: the stage to go back to")
    s.add_argument("--json", action="store_true")
    s = sp.add_parser("path", help="record the way through the flow the user chose (spec: full or short)")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--set", required=True, help="full or short")
    s.add_argument("--confirmed", metavar="WORDS", help="the user's own words choosing it")
    s = sp.add_parser("reopen", help="back to a done or waiting stage for the person's feedback")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--phase", required=True, help="the stage to go back to (Design, Phase 5, ...)")
    s.add_argument("--note", required=True, help="the person's feedback, as they wrote it")
    s = sp.add_parser("view")
    s.add_argument("--id", type=int, help="also the full history of this item")
    s.add_argument("--json", action="store_true", help="always json; accepted for symmetry")
    s.add_argument("--compact", action="store_true")
    s = sp.add_parser("run", help="run a test command in the worktree and record it as proof for a gate")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--gate", required=True, help='the gate this run proves, e.g. "Red test" or "Verified"')
    s.add_argument("--expect", required=True, choices=["pass", "fail"])
    s.add_argument("--repo", help="needed when the work item has more than one repo")
    s.add_argument("--repeat", type=int, default=1, help="run it N times; every run must end as expected")
    s.add_argument("--suite", action="store_true", help="this command is the repo's full test suite")
    s.add_argument("--timeout", type=int, default=1800, help="seconds per run")
    s.add_argument("command", nargs=argparse.REMAINDER, help="-- then the command")
    s = sp.add_parser("revert-check", help="the test fails with the fix files at base, passes with the fix")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--gate", default="Verified")
    s.add_argument("--repo")
    s.add_argument("--fix", action="append", required=True, help="a file of the fix, relative to the repo; repeat")
    s.add_argument("--timeout", type=int, default=1800)
    s.add_argument("command", nargs=argparse.REMAINDER, help="-- then the test command")
    s = sp.add_parser("verify", help="run every tasks.md Verify command; the proof for Ready to PR")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--gate", default="Ready to PR")
    s.add_argument("--timeout", type=int, default=1800)
    s = sp.add_parser("remove")
    s.add_argument("--id", type=int, required=True)
    s.add_argument("--abandon", action="store_true")
    s.add_argument("--yes", action="store_true")
    a = ap.parse_args()
    {"init": cmd_init, "doctor": cmd_doctor, "progress": cmd_progress, "refs": cmd_refs, "can": cmd_can, "type": cmd_type, "new": cmd_new, "status": cmd_status, "view": cmd_view, "reopen": cmd_reopen, "graph": cmd_graph,
     "pr": cmd_pr, "remove": cmd_remove, "upgrade-config": cmd_upgrade_config, "run": cmd_run,
     "revert-check": cmd_revert_check, "verify": cmd_verify, "path": cmd_path}[a.cmd](a)


if __name__ == "__main__":
    main()
