"""Self-check for the bug manager's PowerShell scripts (scripts/bugs/*.ps1) against the offline ADO.

    python scripts/test_bugs.py      (needs pwsh or powershell; temp folders only)

The scripts make real REST calls: a small HTTP server here answers them from fakeado's world file, so the
same code path runs as against ADO. SDD_ADO_URL points the scripts at it and SDD_ADO_TOKEN skips `az`.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fakeado  # noqa: E402

PS = shutil.which("pwsh") or shutil.which("powershell")
BUGS = HERE / "bugs"
ME = "me@x.co"

COMMIT = "vstfs:///Git/Commit/p1%2Fr1%2Fabc1234def"
PR = "vstfs:///Git/PullRequestId/p1%2Fr1%2F77"


def bug(typ, title, state="New", **fields):
    return {"System.WorkItemType": typ, "System.TeamProject": "Proj", "System.Title": title, "System.State": state,
            "System.AreaPath": "Proj\\Payments", "System.IterationPath": "Proj\\Sprint 20",
            "System.CreatedDate": "2026-09-01T08:00:00Z", "System.ChangedDate": "2026-10-01T08:00:00Z", **fields}


WORLD = {
    "repositories": {"r1": {"name": "Gateway", "webUrl": "https://dev.azure.com/Org/Proj/_git/Gateway"}},
    "pullRequests": [{"pullRequestId": 77, "title": "Fix the totals", "status": "active"}],
    "items": {
        "701": {"rev": 3, "fields": bug("Bug", "Totals lose cents", **{
            "System.Tags": "1.1.0; Quick Win", "Microsoft.VSTS.Common.Severity": "2 - High",
            "Microsoft.VSTS.Common.Priority": 1, "System.AssignedTo": {"displayName": "Me", "uniqueName": ME},
            "Microsoft.VSTS.TCM.ReproSteps": "<div>Export shows <b>12</b> not 12.40</div><div>at Billing.Totals.Round() in "
                                              "C:\\src\\Gateway\\Billing\\Totals.cs:line 42</div>"}),
                "relations": [{"rel": "ArtifactLink", "url": COMMIT, "attributes": {"name": "Fixed in Commit"}},
                              {"rel": "ArtifactLink", "url": PR, "attributes": {"name": "Pull Request"}},
                              {"rel": "Hyperlink", "url": "https://wiki/x", "attributes": {"comment": "Runbook"}},
                              {"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://x/_apis/wit/workItems/600"}],
                "comments": [{"text": "<div>Seen on prod too</div>", "createdBy": {"displayName": "Ann"}}]},
        "702": {"rev": 1, "fields": bug("Issue", "Login hangs", "Active", **{
            "System.AssignedTo": {"displayName": "Ann", "uniqueName": "ann@x.co"},
            "Custom.BoardColumnTitle": "Dev In Progress", "Microsoft.VSTS.Common.Priority": 2}),
                "reject": {"System.State": "Resolved"}},
        "703": {"rev": 5, "fields": bug("Bug", "Header typo", "Resolved", **{"Microsoft.VSTS.Common.Priority": 3})},
        "704": {"rev": 2, "fields": bug("Bug", "Old crash", "Closed")},
        "705": {"rev": 1, "fields": bug("User Story", "Export in CSV")},
    },
}


class Handler(BaseHTTPRequestHandler):
    world = ""

    def log_message(self, *a):
        pass

    def _answer(self):
        size = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(size) or b"null") if size else None
        os.environ[fakeado.ENV] = self.world
        try:
            out, code = fakeado.request(self.command, "https://dev.azure.com" + self.path, body), 200
        except RuntimeError as e:
            text = str(e)
            code = next((c for c in (400, 404, 412) if f"HTTP {c}" in text), 500)
            out = {"message": text}
        data = json.dumps(out).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PATCH = _answer


class Fake:
    """A workspace, a world file and the server in front of it."""

    def __init__(self, tmp, world=WORLD, bugs=None):
        self.root = Path(tmp) / "ws"
        (self.root / ".claude").mkdir(parents=True)
        cfg = {"specRoot": "docs/spec", "ado": {"org": "Org", "projects": ["Proj"]}}
        if bugs is not None:
            cfg["bugs"] = bugs
        (self.root / ".claude" / "sdd.json").write_text(json.dumps(cfg), encoding="utf-8")
        self.world = Path(tmp) / "world.json"
        self.world.write_text(json.dumps(world), encoding="utf-8")
        gitcfg = Path(tmp) / "gitconfig"
        gitcfg.write_text(f"[user]\n\temail = {ME}\n\tname = Me\n", encoding="utf-8")
        handler = type("H", (Handler,), {"world": str(self.world)})
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.env = {**os.environ, "SDD_ADO_URL": f"http://127.0.0.1:{self.server.server_port}/Org",
                    "SDD_ADO_TOKEN": "t", "GIT_CONFIG_GLOBAL": str(gitcfg), "NO_PROXY": "127.0.0.1,localhost",
                    "no_proxy": "127.0.0.1,localhost"}
        for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
            self.env.pop(k, None)
        self.bugs = self.root / "docs" / "spec" / ".bugs"

    def run(self, script, *args, ok=True):
        r = subprocess.run([PS, "-NoProfile", "-NonInteractive", "-File", str(BUGS / script), "-Root", str(self.root), *args],
                           capture_output=True, text=True, env=self.env, cwd=self.root, timeout=180)
        lines = [x for x in r.stdout.splitlines() if x.strip()]
        assert lines, f"{script} printed nothing.\nstderr: {r.stderr}"
        out = json.loads(lines[-1])
        if ok:
            assert r.returncode == 0 and out.get("ok"), f"{script} failed: {out}\nstderr: {r.stderr}"
        return out

    def index(self):
        return json.loads((self.bugs / "index.json").read_text(encoding="utf-8"))

    def item(self, wid):
        return next(i for i in self.index()["items"] if i["id"] == wid)

    def read_world(self):
        return json.loads(self.world.read_text(encoding="utf-8"))

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def sync():
    with tempfile.TemporaryDirectory() as tmp:
        f = Fake(tmp)
        try:
            out = f.run("Sync-Bugs.ps1")
            assert out["count"] == 3 and out["added"] == 3, out          # Closed and the story stay out
            raw = (f.bugs / "index.json").read_bytes()
            assert not raw.startswith(b"\xef\xbb\xbf")                    # no BOM: the view parses it
            idx = f.index()
            assert idx["me"]["email"] == ME and idx["syncedAt"]
            b = f.item(701)
            # the record is the view's BugRecord (types/index.d.ts): the same keys, no more
            ts = (HERE.parent / "types" / "index.d.ts").read_text(encoding="utf-8")
            block = ts[ts.index("export type BugRecord = {"):]
            block = block[:block.index("\n}\n")]
            keys = {m.group(1) for m in __import__("re").finditer(r"^  (\w+)\??:", block, __import__("re").M)}
            assert set(b) == keys, (set(b) ^ keys)
            assert b["tags"] == ["1.1.0", "Quick Win"] and b["severity"] == "2 - High" and b["priority"] == 1
            assert b["assigned"] == {"name": "Me", "email": ME} and b["parent"] == 600 and b["rev"] == 3
            assert b["url"] == "https://dev.azure.com/Org/Proj/_workitems/edit/701"
            assert b["commits"] == [{"sha": "abc1234def", "repo": "Gateway",
                                     "url": "https://dev.azure.com/Org/Proj/_git/Gateway/commit/abc1234def"}]
            assert b["prs"] == [{"id": 77, "repo": "Gateway", "url": "https://dev.azure.com/Org/Proj/_git/Gateway/pullrequest/77",
                                 "title": "Fix the totals", "status": "active"}]
            assert b["links"] == [{"name": "Runbook", "url": "https://wiki/x"}]
            assert f.item(702)["boardColumn"] == "Dev In Progress" and f.item(702)["assigned"]["email"] == "ann@x.co"
            text = json.loads((f.bugs / "items" / "701.json").read_text(encoding="utf-8"))["text"]
            assert text["repro"].startswith("Export shows 12 not 12.40\nat Billing.Totals.Round()"), text
            # the item closes in ADO: the next sync drops it and its text
            w = f.read_world()
            w["items"]["703"]["fields"]["System.State"] = "Closed"
            w["items"]["702"]["rev"] = 2
            f.world.write_text(json.dumps(w), encoding="utf-8")
            out = f.run("Sync-Bugs.ps1")
            assert (out["count"], out["added"], out["changed"], out["removed"]) == (2, 0, 1, 1), out
            assert not (f.bugs / "items" / "703.json").exists()
            # -Id refreshes one item and keeps the rest, even one the query would leave out now
            out = f.run("Sync-Bugs.ps1", "-Id", "703")
            assert out["refreshed"] == [703] and f.index()["count"] == 3 and f.item(703)["state"] == "Closed"
        finally:
            f.close()


def stage(f, *changes):
    rows = [{"key": f"k{n}", "label": f"change {n}", **c} for n, c in enumerate(changes)]
    (f.bugs / "pending.json").write_text(json.dumps({"version": 1, "changes": rows}), encoding="utf-8")
    return rows


def pending(f):
    return json.loads((f.bugs / "pending.json").read_text(encoding="utf-8"))["changes"]


def save():
    with tempfile.TemporaryDirectory() as tmp:
        f = Fake(tmp)
        try:
            f.run("Sync-Bugs.ps1")
            out = f.run("Save-BugChanges.ps1")
            assert out["saved"] == 0 and out["message"] == "nothing to save"
            # someone moves 701 to Active in ADO after the sync; the person staged New -> Resolved on the old state
            w = f.read_world()
            w["items"]["701"]["fields"]["System.State"] = "Active"
            w["items"]["701"]["rev"] = 4
            f.world.write_text(json.dumps(w), encoding="utf-8")
            stage(f,
                  {"id": 701, "kind": "field", "field": "System.State", "value": "Resolved", "was": "New"},      # k0 conflict
                  {"id": 701, "kind": "field", "field": "Microsoft.VSTS.Common.Priority", "value": "2", "was": "1"},  # k1
                  {"id": 701, "kind": "tagAdd", "value": "Urgent"},                                              # k2
                  {"id": 701, "kind": "tagRemove", "value": "quick win"},                                        # k3 any case
                  {"id": 701, "kind": "field", "field": "System.AssignedTo", "value": "", "was": ME},            # k4 unassign
                  {"id": 701, "kind": "comment", "value": "Seen in ADO 702 too.\n<b>not bold</b>"},              # k5
                  {"id": 701, "kind": "comment", "value": "Same as #702"},                                       # k6 mention
                  {"id": 702, "kind": "field", "field": "System.State", "value": "Resolved", "was": "Active"},   # k7 rule
                  {"id": 703, "kind": "field", "field": "System.State", "value": "Resolved", "was": "Resolved"}, # k8 already
                  {"id": 702, "kind": "field", "field": "System.AreaPath", "value": "Proj\\Login", "was": "Proj\\Payments"})  # k9
            out = f.run("Save-BugChanges.ps1")
            by = {r["key"]: r for r in out["results"]}
            assert by["k0"]["status"] == "conflict" and "now 'Active'" in by["k0"]["message"], by["k0"]
            assert [by[k]["status"] for k in ("k1", "k2", "k3", "k4", "k5")] == ["saved"] * 5, out
            assert by["k6"]["status"] == "error" and "ADO 702" in by["k6"]["message"]
            assert by["k7"]["status"] == "error" and "Rule Error" in by["k7"]["message"]
            assert by["k8"]["status"] == "already"
            assert by["k9"]["status"] == "error"                       # the same patch as k7: it failed with it
            assert (out["saved"], out["conflicts"], out["errors"]) == (6, 1, 3), out
            w = f.read_world()
            f701 = w["items"]["701"]["fields"]
            assert f701["System.State"] == "Active" and f701["Microsoft.VSTS.Common.Priority"] == 2
            assert f701["System.Tags"] == "1.1.0; Urgent" and "System.AssignedTo" not in f701
            patch = next(x for x in w["writes"] if x["method"] == "PATCH" and x["id"] == 701)
            assert patch["ops"][0] == {"op": "test", "path": "/rev", "value": 4}      # rev-tested against the fresh read
            comment = next(x for x in w["writes"] if x["method"] == "COMMENT")
            assert comment == {"method": "COMMENT", "id": 701, "text": "<div>Seen in ADO 702 too.<br>&lt;b&gt;not bold&lt;/b&gt;</div>"}
            assert w["items"]["702"]["fields"]["System.State"] == "Active"
            left = {c["key"]: c for c in pending(f)}
            assert sorted(left) == ["k0", "k6", "k7", "k9"], left
            assert left["k0"]["problem"] == {"kind": "conflict", "text": by["k0"]["message"], "current": "Active"}
            # the saved item is read back into the index
            b = f.item(701)
            assert b["state"] == "Active" and b["assigned"] is None and b["tags"] == ["1.1.0", "Urgent"] and b["rev"] == 5
            # keep mine: the view sets "was" to what ADO holds now, and the save goes through; -Id saves one item
            rows = pending(f)
            for c in rows:
                if c["key"] == "k0":
                    c["was"] = c["problem"]["current"]
            (f.bugs / "pending.json").write_text(json.dumps({"version": 1, "changes": rows}), encoding="utf-8")
            out = f.run("Save-BugChanges.ps1", "-Id", "701")
            assert [r["key"] for r in out["results"]] == ["k0", "k6"] and out["saved"] == 1
            assert f.read_world()["items"]["701"]["fields"]["System.State"] == "Resolved"
            assert sorted(c["key"] for c in pending(f)) == ["k6", "k7", "k9"]
            # someone writes between the read and the patch: HTTP 412, read again, decide again, write
            w = f.read_world()
            w["items"]["703"]["race"] = True
            f.world.write_text(json.dumps(w), encoding="utf-8")
            stage(f, {"id": 703, "kind": "field", "field": "System.State", "value": "Active", "was": "Resolved"})
            out = f.run("Save-BugChanges.ps1")
            assert out["saved"] == 1 and out["results"][0]["status"] == "saved", out
            w = f.read_world()
            tries = [x["ops"][0]["value"] for x in w["writes"] if x["method"] == "PATCH" and x["id"] == 703]
            assert w["items"]["703"]["fields"]["System.State"] == "Active" and tries == [6], tries
        finally:
            f.close()


def detail():
    with tempfile.TemporaryDirectory() as tmp:
        f = Fake(tmp)
        try:
            f.run("Sync-Bugs.ps1")
            out = f.run("Get-BugDetail.ps1", "-Id", "701")
            assert out["item"]["id"] == 701 and out["text"]["repro"].startswith("Export shows 12")
            assert out["comments"] == [{"by": "Ann", "at": "", "text": "Seen on prod too"}], out["comments"]
            doc = json.loads((f.bugs / "items" / "701.json").read_text(encoding="utf-8"))
            assert doc["comments"][0]["text"] == "Seen on prod too"
            f.run("Sync-Bugs.ps1")                                      # a sync keeps the comments read before
            assert json.loads((f.bugs / "items" / "701.json").read_text(encoding="utf-8"))["comments"]
            out = f.run("Get-BugDetail.ps1", "-Id", "999", ok=False)
            assert out["ok"] is False and "999 not found" in out["error"]
        finally:
            f.close()


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


def evidence():
    with tempfile.TemporaryDirectory() as tmp:
        world = json.loads(json.dumps(WORLD))
        f = Fake(tmp, world)
        try:
            repo = f.root / "Gateway"
            (repo / "Billing").mkdir(parents=True)
            lines = [f"// line {n}" for n in range(1, 42)] + ["    public decimal Round(decimal v) => Math.Round(v);"]
            (repo / "Billing" / "Totals.cs").write_text("\n".join(lines) + "\n", encoding="utf-8")
            (repo / "Export.cs").write_text("var s = total.ToString(\"F0\"); // drops the cents\n", encoding="utf-8")
            env = {**f.env, "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "d@x", "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "d@x"}
            for args in (["init", "-q"], ["add", "."], ["commit", "-q", "-m", "Round the totals"]):
                subprocess.run(["git", *args], cwd=repo, env=env, check=True, capture_output=True)
            sha = git(repo, "rev-parse", "HEAD")
            w = f.read_world()
            w["items"]["701"]["relations"][0]["url"] = f"vstfs:///Git/Commit/p1%2Fr1%2F{sha}"
            f.world.write_text(json.dumps(w), encoding="utf-8")
            out = f.run("Find-BugEvidence.ps1", "-Id", "701", ok=False)
            assert not out["ok"] and "Sync-Bugs.ps1" in out["error"]           # not synced yet
            f.run("Sync-Bugs.ps1")
            out = f.run("Find-BugEvidence.ps1", "-Id", "701")
            assert out["repos"] == ["Gateway"], out
            assert out["terms"][:3] == ["Totals.cs", "Totals.Round", "Round"], out["terms"]
            first = out["hits"][0]
            assert first == {"repo": "Gateway", "path": "Billing/Totals.cs", "line": 42,
                             "text": "public decimal Round(decimal v) => Math.Round(v);", "term": "Totals.cs"}, first
            assert [h["path"] for h in out["hits"]] == ["Billing/Totals.cs", "Export.cs"], out["hits"]  # once each
            assert out["history"][0]["path"] == "Billing/Totals.cs" and "Dev: Round the totals" in out["history"][0]["commits"][0]
            assert out["linked"] == [{"repo": "Gateway", "commit": out["linked"][0]["commit"], "files": ["Billing/Totals.cs", "Export.cs"]}]
            assert len(json.dumps(out)) < 4000                                   # small: it goes to a model as is
            assert json.loads((f.bugs / "items" / "701.evidence.json").read_text(encoding="utf-8"))["id"] == 701
        finally:
            f.close()


def chat():
    if os.name == "nt":
        return  # the launch below fakes a Unix terminal; Windows opens wt.exe or cmd.exe
    import time
    with tempfile.TemporaryDirectory() as tmp:
        f = Fake(tmp)
        try:
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            got = Path(tmp) / "xterm-args.txt"
            f.env["PATH"] = str(bin_dir)  # only the fakes: the machine may have a terminal of its own
            out = f.run("Start-SddChat.ps1", "-Id", "701", "-DryRun", ok=False)
            assert not out["ok"] and "claude command is not on PATH" in out["error"], out
            (bin_dir / "claude").write_text("#!/bin/sh\nexit 0\n")
            (bin_dir / "claude").chmod(0o755)
            out = f.run("Start-SddChat.ps1", "-Id", "701", "-DryRun", ok=False)
            assert not out["ok"] and "no terminal program found" in out["error"], out
            (bin_dir / "xterm").write_text(f"#!/bin/sh\nprintf '%s\\n' \"$@\" > '{got}'\n")
            (bin_dir / "xterm").chmod(0o755)
            out = f.run("Start-SddChat.ps1", "-Id", "701")
            assert out["how"] == "xterm" and out["prompt"] == "/sdd:sdd 701", out
            for _ in range(100):
                if got.exists() and got.read_text():
                    break
                time.sleep(0.05)
            assert got.read_text().splitlines() == ["-e", "bash", "-lc", f"cd '{f.root}' && claude '/sdd:sdd 701'"], got.read_text()
            # a deep link instead of a terminal
            cfg = json.loads((f.root / ".claude" / "sdd.json").read_text())
            cfg["bugs"] = {"newChat": {"mode": "url", "url": "claude://new?prompt={prompt}&id={id}"}}
            (f.root / ".claude" / "sdd.json").write_text(json.dumps(cfg))
            out = f.run("Start-SddChat.ps1", "-Id", "701", "-DryRun")
            assert out["how"] == "url" and out["args"] == ['"claude://new?prompt=%2Fsdd%3Asdd%20701&id=701"'], out
        finally:
            f.close()


def ascii_only():
    """Windows PowerShell 5.1 reads a script without a BOM as the machine's ANSI code page: keep them ASCII."""
    for f in BUGS.glob("*.ps1"):
        text = f.read_bytes()
        assert all(b < 128 for b in text), f"{f.name}: a non-ASCII character (write it as an escape)"


def main():
    ascii_only()
    if not PS:
        print("skip: no pwsh or powershell on PATH")
        return
    sync()
    save()
    detail()
    evidence()
    chat()
    print("ok")


if __name__ == "__main__":
    main()
