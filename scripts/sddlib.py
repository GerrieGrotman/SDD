"""Shared helpers for the sdd scripts: workspace config, ADO REST, git, work item folders.

Every script finds the workspace by walking up from the current directory to the first
folder holding .claude/sdd.json. Run `env.py init` once per workspace to create it.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"
CONFIG_REL = Path(".claude") / "sdd.json"
# The bug manager's defaults (/sdd-bugs): one file, read here, by scripts/bugs/*.ps1 and by the view
BUGS_DEFAULTS = Path(__file__).resolve().parent / "bugs" / "defaults.json"

DEFAULTS = {
    "specRoot": "docs/spec",
    "worktreeRoot": ".claude/worktrees",
    "repoDirs": [],  # empty = discover from .gitmodules plus any child/grandchild folder holding .git
    "ado": {"org": "", "projects": []},
    "specTypes": ["Epic", "Feature", "User Story", "Tech Story", "Change Request",
                  "Product Backlog Item", "Bug", "Issue"],
    "branchTemplate": "dev/{developer}/{version}/{type}/{id}-{slug}",
    "doneStates": ["Resolved", "Closed", "Done"],  # ADO states that mean the flow's close-out ran
    "embeddings": {"provider": "ollama", "url": "http://localhost:11434", "model": "nomic-embed-text"},
    # the sdd view's colours (/sdd-view); a workspace overrides any of them in .claude/sdd.json "view.colors"
    "view": {"autoOpen": True, "colors": {
        "done": "#3f9a63",       # a stage done, a gate passed
        "now": "#c98a12",        # waiting on you
        "work": "#4a7fc4",       # working, the stage log icon
        "revoked": "#c0503f",    # revoked, blocked
        "gate": "#8a73c9",       # a gate's icon at rest
        "dim": "#7b8794",        # quiet text, a gate not asked yet
        "line": "#5c6670",       # borders
        "hoverText": "#ffffff",  # the text of the line under the pointer (its icon turns a lighter shade)
    }},
    # Ai Agent Requests (hand-overs between AI agents): the types routed by /sdd's request skill, and
    # the type it creates for the work when no open item takes it, per flow the user picks
    "agentRequest": {"types": ["Ai Agent Request"], "create": {"bug": "Bug", "spec": "Tech Story"}},
    # the model each sdd sub-agent runs on: passed as the Agent tool's `model` when a flow starts one
    "agents": {"models": {"investigator": "sonnet", "skeptic": "opus"}},
    # /sdd next: which item under an epic or feature to take next (scripts/nextpick.py)
    "next": {
        "weights": {"priority": 50, "severity": 30, "complexity": 20},  # the dev priority, 0-100
        "complexity": "complex-first",          # or "simple-first": which way complexity pushes it
        "types": [["Bug", "Issue"],             # this group first, then the next
                  ["User Story", "Tech Story", "Change Request", "Product Backlog Item"]],
        "inProgress": {"states": ["Active"], "boards": ["Dev In Progress"]},  # someone else's work
        "pastDev": ["Dev Completed", "QA Deployed", "QA Testing Passed", "UAT Deployed"],
    },
    # the bug manager (/sdd-bugs): where it keeps the synced bugs and issues, and how it sorts them into categories
    "bugs": json.loads(BUGS_DEFAULTS.read_text(encoding="utf-8")),
}
# What the Agent tool's `model` takes.
AGENT_MODELS = ("sonnet", "opus", "haiku")
# Keys written into an existing workspace's .claude/sdd.json when missing — by `env.py
# upgrade-config`, which the plugin's SessionStart hook runs, so a plugin update reaches every
# workspace on its next session. Settings a person should find in the file and change there.
# A value already in the file is never changed.
UPGRADE_KEYS = [("agents", "models", "investigator"), ("agents", "models", "skeptic"),
                ("next", "weights", "priority"), ("next", "weights", "severity"), ("next", "weights", "complexity"),
                ("next", "complexity"), ("bugs", "folder"), ("bugs", "categories")]

TYPE_SEGMENT = {
    "User Story": "story", "Product Backlog Item": "story", "Change Request": "story",
    "Feature": "feature", "Epic": "feature",
    "Bug": "bug", "Issue": "bug",
    "Tech Story": "tech", "Task": "tech",
}
BUG_TYPES = {"Bug", "Issue"}


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


# ---------------------------------------------------------------- workspace / config

def find_root(start=None):
    p = Path(start or os.getcwd()).resolve()
    for d in [p, *p.parents]:
        if (d / CONFIG_REL).is_file():
            return d
    return None


def require_root():
    root = find_root()
    if not root:
        die(f"no {CONFIG_REL} found above {os.getcwd()}. Run: python env.py init  (from the workspace root)")
    return root


def load_config(root):
    cfg = json.loads((root / CONFIG_REL).read_text(encoding="utf-8"))
    merged = {**DEFAULTS, **cfg}
    merged["ado"] = {**DEFAULTS["ado"], **cfg.get("ado", {})}
    merged["embeddings"] = {**DEFAULTS["embeddings"], **cfg.get("embeddings", {})}
    view = cfg.get("view", {})
    merged["view"] = {**DEFAULTS["view"], **view, "colors": {**DEFAULTS["view"]["colors"], **view.get("colors", {})}}
    req = cfg.get("agentRequest") if isinstance(cfg.get("agentRequest"), dict) else {}
    merged["agentRequest"] = {**DEFAULTS["agentRequest"], **req,
                              "create": {**DEFAULTS["agentRequest"]["create"], **(req.get("create") or {})}}
    agents = cfg.get("agents") if isinstance(cfg.get("agents"), dict) else {}
    models = agents.get("models") if isinstance(agents.get("models"), dict) else {}
    merged["agents"] = {**DEFAULTS["agents"], **agents, "models": {**DEFAULTS["agents"]["models"], **models}}
    nxt = cfg.get("next") if isinstance(cfg.get("next"), dict) else {}
    merged["next"] = {**DEFAULTS["next"], **nxt,
                      "weights": {**DEFAULTS["next"]["weights"], **(nxt.get("weights") or {})},
                      "inProgress": {**DEFAULTS["next"]["inProgress"], **(nxt.get("inProgress") or {})}}
    merged["bugs"] = merge_bugs(cfg.get("bugs"))
    return merged


def merge_bugs(given):
    """The bug manager's settings: sdd.json "bugs" over scripts/bugs/defaults.json. An object one level
    down (query, states, analysis, newChat) is merged key by key; a list (categories) replaces the default
    whole. The same merge as Read-BugsConfig in scripts/bugs/BugsCommon.ps1 and bugsConfig in the view."""
    base = DEFAULTS["bugs"]
    given = given if isinstance(given, dict) else {}
    out = {**base, **given}
    for k, v in base.items():
        if isinstance(v, dict) and isinstance(given.get(k), dict):
            out[k] = {**v, **given[k]}
    return out


def upgrade_config(root):
    """Write each UPGRADE_KEYS default missing from the workspace's sdd.json into it. -> the keys
    added, dotted. Never changes a value that is set, and leaves a non-object where an object
    belongs alone: that is the person's to fix (doctor says so)."""
    path = root / CONFIG_REL
    cfg = json.loads(path.read_text(encoding="utf-8"))
    added = []
    for keys in UPGRADE_KEYS:
        node, default = cfg, DEFAULTS
        for k in keys[:-1]:
            default = default[k]
            if k not in node:
                node[k] = {}
            if not isinstance(node[k], dict):
                break
            node = node[k]
        else:
            if keys[-1] not in node:
                node[keys[-1]] = default[keys[-1]]
                added.append(".".join(keys))
    if added:
        path.write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")
    return added


# ---------------------------------------------------------------- output style (global)

# The plugin's output style. Installed into the person's global output-styles folder (named after
# its `name` field) and set as the global outputStyle — at the first session after the plugin is
# installed or updated (env.py upgrade-config, the SessionStart hook) and by `env.py init`.
STYLE_NAME = "ELI5"
STYLE_SRC = Path(__file__).resolve().parent.parent / "assets" / "output-styles" / f"{STYLE_NAME}.md"


def config_home():
    """Claude Code's user config folder: CLAUDE_CONFIG_DIR when set, else ~/.claude."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def _sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _write_atomic(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".sdd-tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def install_output_style(force=False):
    """Make the plugin's output style the person's global one. -> (changed paths, notes).

    The style file: written when missing, and replaced on a plugin update only while it still holds
    the text the plugin wrote last time — a file the person edited stays theirs.
    The setting: outputStyle in the global settings.json, the file created and the key added when
    missing, every other key kept. Set once: a person who picks another style afterwards keeps it,
    unless `force` (env.py init, an explicit setup). A settings file that is not valid JSON is never
    written; a note says so."""
    home = config_home()
    state_path = home / "sdd" / "state.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        state = {}
    before = dict(state)
    changed, notes = [], []

    text = STYLE_SRC.read_text(encoding="utf-8")
    dest = home / "output-styles" / f"{STYLE_NAME}.md"
    try:
        have = dest.read_text(encoding="utf-8")
    except OSError:
        have = None
    if have is None or (have != text and _sha(have) == state.get("styleHash")):
        _write_atomic(dest, text)
        changed.append(dest)
    elif have != text:
        notes.append(f"{dest} differs from the plugin's {STYLE_NAME} style; kept your version")
    if have is None or have == text or _sha(have) == state.get("styleHash"):
        state["styleHash"] = _sha(text)

    settings_path = home / "settings.json"
    try:
        raw = settings_path.read_text(encoding="utf-8")
        settings = json.loads(raw) if raw.strip() else {}
    except FileNotFoundError:
        settings = {}
    except (OSError, ValueError) as e:
        settings = None
        notes.append(f"{settings_path} is not valid JSON ({e}); outputStyle not set")
    if isinstance(settings, dict):
        cur = settings.get("outputStyle")
        if cur != STYLE_NAME and (force or not state.get("outputStyleSet")):
            settings["outputStyle"] = STYLE_NAME
            _write_atomic(settings_path, json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
            changed.append(settings_path)
            state["outputStyleWas"] = cur
        if settings.get("outputStyle") == STYLE_NAME:
            state["outputStyleSet"] = True
    elif settings is not None:
        notes.append(f"{settings_path} is not a JSON object; outputStyle not set")

    if state != before:
        try:
            _write_atomic(state_path, json.dumps(state, indent=2) + "\n")
        except OSError:
            pass
    return changed, notes


def bad_agent_models(cfg):
    """agents.models entries the Agent tool would not take, as 'name=value'."""
    return [f"{k}={v}" for k, v in cfg["agents"]["models"].items() if v not in AGENT_MODELS]


def slug(text, limit=48):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    s = s[:limit].strip("-")
    return s or "untitled"


# ---------------------------------------------------------------- git

def git(args, cwd, check=True, capture=True):
    r = subprocess.run(["git", *args], cwd=str(cwd), text=True, encoding="utf-8",
                       capture_output=capture)
    if check and r.returncode != 0:
        die(f"git {' '.join(args)} failed in {cwd}:\n{(r.stderr or r.stdout or '').strip()}")
    return (r.stdout or "").strip() if capture else ""


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


def discover_repos(root, cfg):
    """{name: Path} for every repo in the workspace. Name is the folder name."""
    dirs = []
    if cfg.get("repoDirs"):
        dirs = [root / d for d in cfg["repoDirs"]]
    else:
        gm = root / ".gitmodules"
        if gm.is_file():
            dirs += [root / m for m in re.findall(r"^\s*path\s*=\s*(.+?)\s*$", gm.read_text(), re.M)]
        for child in root.iterdir():
            if child.name.startswith(".") or not child.is_dir():
                continue
            dirs.append(child)
            dirs += [g for g in child.iterdir() if g.is_dir() and not g.name.startswith(".")]
    wt_root = (root / cfg["worktreeRoot"]).resolve()
    repos = {}
    for d in dirs:
        d = d.resolve()
        if (d / ".git").exists() and wt_root not in d.parents and d != root:
            repos.setdefault(d.name, d)
    return repos


def ensure_ignored(repo_dir, rel, is_dir=True):
    """Make sure `rel` is ignored in repo_dir; add it to .git/info/exclude (machine-local) if not."""
    if not (repo_dir / ".git").exists():
        return
    probe = rel.rstrip("/") + ("/x" if is_dir else "")
    if subprocess.run(["git", "check-ignore", "-q", probe], cwd=str(repo_dir)).returncode == 0:
        return
    common = Path(git(["rev-parse", "--git-common-dir"], repo_dir))
    if not common.is_absolute():
        common = repo_dir / common
    exclude = common / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with exclude.open("a", encoding="utf-8") as f:
        f.write(f"\n{rel.rstrip('/')}{'/' if is_dir else ''}\n")
    print(f"added {rel.rstrip('/')}{'/' if is_dir else ''} to {exclude}")


def developer():
    email = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True).stdout.strip()
    name = email.split("@")[0] if email else (os.environ.get("USERNAME") or os.environ.get("USER") or "")
    return slug(name) if name else die("cannot work out the developer name; set git config user.email")


# ---------------------------------------------------------------- ADO REST

_token = None


def token():
    global _token
    if _token:
        return _token
    az = shutil.which("az") or shutil.which("az.cmd")
    if not az:
        die("Azure CLI (az) not found. Install it and run: az login")
    r = subprocess.run([az, "account", "get-access-token", "--resource", ADO_RESOURCE,
                        "--query", "accessToken", "-o", "tsv"], capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        die("could not get an ADO token from az. Run: az login\n" + r.stderr.strip())
    _token = r.stdout.strip()
    return _token


def ado(method, url, body=None, content_type="application/json"):
    import fakeado  # an offline stand-in, only when SDD_FAKE_ADO names a world file (evals, tests)
    if fakeado.active():
        return fakeado.request(method, url, body)
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Bearer {token()}", "Content-Type": content_type,
        "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:600]
        raise RuntimeError(f"ADO {method} {url} -> HTTP {e.code}: {detail}") from None


def org_url(cfg):
    org = cfg["ado"]["org"] or die("ado.org is empty in .claude/sdd.json")
    return f"https://dev.azure.com/{urllib.request.quote(org)}"


def get_items(cfg, ids, fields=None, relations=False):
    """Batch read, 200 ids per call. Missing (deleted) ids are simply absent from the result."""
    out, ids = [], sorted(set(int(i) for i in ids))
    for i in range(0, len(ids), 200):
        body = {"ids": ids[i:i + 200], "errorPolicy": "omit"}
        if relations:
            body["$expand"] = "relations"
        elif fields:
            body["fields"] = fields
        r = ado("POST", f"{org_url(cfg)}/_apis/wit/workitemsbatch?api-version=7.1", body)
        out += [w for w in (r or {}).get("value", []) if w]
    return out


def wiql(cfg, query, project=None):
    base = org_url(cfg) + (f"/{urllib.request.quote(project)}" if project else "")
    r = ado("POST", f"{base}/_apis/wit/wiql?$top=20000&api-version=7.1", {"query": query})
    if "workItemRelations" in r:
        return r["workItemRelations"]
    return [w["id"] for w in r.get("workItems", [])]


# ---------------------------------------------------------------- work item folders

def wt_root(root, cfg):
    return (root / cfg["worktreeRoot"]).resolve()


def find_env(root, cfg, wid):
    """The .claude/worktrees/{id}-{slug} folder for a work item, or None."""
    base = wt_root(root, cfg)
    if not base.is_dir():
        return None
    hits = [d for d in base.iterdir() if d.is_dir() and re.match(rf"^{int(wid)}-", d.name)
            and (d / "workitem.json").is_file()]
    return hits[0] if hits else None


# The bug flow was numbered Phase 0 … Phase 13 with a Phase 9a; it is now Phase 1 … Phase 15.
OLD_BUG_PHASE = re.compile(r"^(\s*Phase\s+)(\d+a?)\b", re.I)


def _old_bug_number(n):
    n = n.lower()
    return "11" if n == "9a" else str(int(n) + 1 if int(n) <= 9 else int(n) + 2)


def renumber_bug_phases(data):
    """A work item record written under the old bug numbering, moved to the new one in place.
    Old records always hold a Phase 0 stage (every later stage needs it worked or skipped first),
    and the new numbering never writes one, so that is the tell. Free-text notes keep what they said."""
    rows = [data.get("progress") or {}] + list(data.get("history") or [])
    phases = list((data.get("stages") or {})) + [r.get("phase") or "" for r in rows]
    if not any(re.match(r"^\s*Phase\s+(0|9a)\b", p, re.I) for p in phases):
        return data
    fix = lambda p: OLD_BUG_PHASE.sub(lambda m: m.group(1) + _old_bug_number(m.group(2)), p or "")
    if data.get("stages") is not None:
        data["stages"] = {fix(k): v for k, v in data["stages"].items()}
    for r in rows:
        if r.get("phase"):
            r["phase"] = fix(r["phase"])
    return data


def read_record(path):
    """A workitem.json, or a removed item's .done/<id>.json, in the current bug numbering."""
    return renumber_bug_phases(json.loads(Path(path).read_text(encoding="utf-8")))


def read_env(env_dir):
    return read_record(env_dir / "workitem.json")


def write_env(env_dir, data):
    (env_dir / "workitem.json").write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
