"""Self-check for the offline ADO stand-in (fakeado.py) driving the real commands.

    python scripts/test_fakeado.py      (temp folders only)
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

WORLD = {
    "currentIteration": "Proj\\2026\\Sprint 20",
    "items": {
        "500": {"rev": 4, "fields": {"System.WorkItemType": "Change Request", "System.TeamProject": "Proj",
                                     "System.Title": "Export rounds totals", "System.State": "Active",
                                     "System.Description": "<div>FR1: totals are rounded to whole rand.</div>"},
                "relations": [{"rel": "System.LinkTypes.Related", "url": "https://x/_apis/wit/workItems/501"}]},
        "502": {"rev": 1, "fields": {"System.WorkItemType": "User Story", "System.TeamProject": "Proj",
                                     "System.Title": "Show cents on the export", "System.State": "New"}},
        "501": {"rev": 7, "fields": {"System.WorkItemType": "Bug", "System.TeamProject": "Proj",
                                     "System.Title": "Export drops cents", "System.State": "New",
                                     "Custom.BoardColumnTitle": "New", "Microsoft.VSTS.Common.Priority": 1,
                                     "Microsoft.VSTS.Common.Severity": "2 - High",
                                     "Microsoft.VSTS.Scheduling.StoryPoints": 3,
                                     "Microsoft.VSTS.Scheduling.TargetDate": "2026-10-20T00:00:00Z",
                                     "System.CreatedDate": "2026-09-01T08:00:00Z",
                                     "Microsoft.VSTS.TCM.ReproSteps": "<div>Export shows 12 not 12.40</div>"},
                "relations": [{"rel": "System.LinkTypes.Related", "url": "https://x/_apis/wit/workItems/500"}]},
    },
}


def child(wid, typ, title, state="New", tags="1.1.0", rels=(), **fields):
    """A work item under feature 600 for the next-item scenario."""
    f = {"System.WorkItemType": typ, "System.TeamProject": "Proj", "System.Title": title, "System.State": state,
         "System.Tags": tags, **fields}
    rel = [{"rel": "System.LinkTypes.Hierarchy-Reverse", "url": "https://x/_apis/wit/workItems/600"}, *rels]
    return str(wid), {"rev": 1, "fields": f, "relations": rel}


P, S, SP = "Microsoft.VSTS.Common.Priority", "Microsoft.VSTS.Common.Severity", "Microsoft.VSTS.Scheduling.StoryPoints"
FEATURE = dict([
    ("600", {"rev": 1, "fields": {"System.WorkItemType": "Feature", "System.TeamProject": "Proj",
                                  "System.Title": "Invoice export v2", "System.State": "Active", "System.Tags": "1.1.0"}}),
    child(601, "Bug", "Totals lose cents", **{P: 2, S: "2 - High"}),
    child(602, "Bug", "Export crashes on empty invoice", "Active", **{P: 1, S: "1 - Critical", "System.AssignedTo":
          {"displayName": "Ann", "uniqueName": "ann@x.co"}, "Custom.BoardColumnTitle": "Dev In Progress"}),
    child(603, "User Story", "Export in CSV", **{P: 1, SP: 8, "System.AssignedTo": {"displayName": "Bob", "uniqueName": "bob@x.co"}}),
    child(604, "User Story", "Export in PDF", tags="1.0.0", **{P: 1}),
    child(605, "User Story", "CSV column picker", rels=[{"rel": "System.LinkTypes.Dependency-Reverse",
          "url": "https://x/_apis/wit/workItems/603", "attributes": {"name": "Predecessor"}}], **{P: 2, SP: 2}),
    child(606, "Change Request", "Show currency symbol", **{P: 2, "System.Description":
          "<div>This depends on ADO 601 being fixed first, since both change the totals.</div>"}),
    child(607, "Bug", "Old rounding bug", "Resolved", **{P: 1, S: "1 - Critical"}),
    child(608, "Bug", "Typo in header", **{P: 3, S: "3 - Medium", SP: 1, "Microsoft.VSTS.CMMI.Blocked": "Yes"}),
])


def run(root, script, *args, check=True):
    r = subprocess.run([PY, str(HERE / script), *args], cwd=str(root), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise AssertionError(f"{script} {args} -> {r.returncode}\n{r.stdout}\n{r.stderr}")
    return r


def main():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / ".claude").mkdir()
        (root / ".claude" / "sdd.json").write_text(json.dumps(
            {"specRoot": "docs/spec", "ado": {"org": "Org", "projects": ["Proj"]}}))
        world = root / "world.json"
        world.write_text(json.dumps({**WORLD, "items": {**WORLD["items"], **FEATURE}}))
        os.environ["SDD_FAKE_ADO"] = str(world)
        cfg = root / "gitconfig"
        cfg.write_text("[user]\n\temail = dev@x.co\n\tname = Dev\n")
        os.environ["GIT_CONFIG_GLOBAL"] = str(cfg)

        # an index built before the planning fields existed gets their columns in place
        idx = root / "docs" / "spec" / ".index"
        idx.mkdir(parents=True)
        import sqlite3
        old = sqlite3.connect(idx / "spec.db")
        old.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, project TEXT, type TEXT, title TEXT, state TEXT, "
                    "area TEXT, iteration TEXT, tags TEXT, assigned TEXT, parent INTEGER, rev INTEGER, hash TEXT, "
                    "fhash TEXT, path TEXT, removed INTEGER DEFAULT 0, missing INTEGER DEFAULT 0, changed TEXT, "
                    "synced_at TEXT, body TEXT, other TEXT)")
        old.commit()
        old.close()

        run(root, "spec.py", "sync", "--id", "501", "--no-embed")
        req = next((root / "docs" / "spec").rglob("501-*/requirements.md")).read_text(encoding="utf-8")
        assert "Export drops cents" in req and "12.40" in req, req
        assert any((root / "docs" / "spec").rglob("500-*/requirements.md")), "the linked CR was not mirrored"
        show = json.loads(run(root, "spec.py", "query", "show", "--id", "501", "--json").stdout)
        assert show and "Bug" in json.dumps(show), show
        row = show[0]
        assert (row["board"], row["priority"], row["severity"], row["effort"]) == ("New", 1, "2 - High", 3), row
        assert row["target"].startswith("2026-10-20") and row["created"].startswith("2026-09-01"), row
        assert row["assigned_email"] == "" and row["blocked"] == "", row
        for cell in ("| Board column | New |", "| Priority | 1 |", "| Severity | 2 - High |", "| Effort | 3 |"):
            assert cell in req, (cell, req)
        assert "| Blocked |" not in req                                   # absent fields stay out of the table

        out = run(root, "spec.py", "claim", "--id", "501").stdout
        assert "claimed" in out, out
        w = json.loads(world.read_text())
        f = w["items"]["501"]["fields"]
        assert f["System.AssignedTo"] == "dev@x.co" and f["System.State"] == "Active"
        assert f["Custom.BoardColumnTitle"] == "Dev In Progress" and w["items"]["501"]["rev"] == 8
        assert w["writes"][0]["ops"][0] == {"op": "test", "path": "/rev", "value": 7}
        row = json.loads(run(root, "spec.py", "query", "show", "--id", "501", "--json").stdout)[0]
        assert (row["board"], row["state"], row["assigned_email"]) == ("Dev In Progress", "Active", "dev@x.co"), row

        w["items"]["500"]["fields"]["System.AssignedTo"] = {"displayName": "Ann", "uniqueName": "ann@x.co"}
        world.write_text(json.dumps(w))
        r = run(root, "spec.py", "claim", "--id", "500", check=False)
        assert r.returncode == 3 and "Ann" in r.stdout, r.stdout

        run(root, "spec.py", "sprint", "--id", "501")
        assert json.loads(world.read_text())["items"]["501"]["fields"]["System.IterationPath"] == "Proj\\2026\\Sprint 20"

        (root / "rc.html").write_text("<div>The export cut the cents.</div>")
        (root / "res.html").write_text("<div>See #500 for the rule.</div>")
        r = run(root, "spec.py", "handover", "--id", "501", "--root-cause-details-file", "rc.html",
                "--resolution-file", "res.html", check=False)
        assert r.returncode == 3 and "ADO 500" in r.stdout, r.stdout
        (root / "res.html").write_text("<div>The export keeps the cents now.</div>")
        run(root, "spec.py", "handover", "--id", "501", "--root-cause-details-file", "rc.html",
            "--resolution-file", "res.html")
        f = json.loads(world.read_text())["items"]["501"]["fields"]
        assert f["System.State"] == "Resolved" and f["Custom.BoardColumnTitle"] == "Dev Completed"

        (root / "c.html").write_text("<div>PR is up. Check the export shows 12.40.</div>")
        run(root, "spec.py", "comment", "--id", "501", "--file", "c.html")
        kinds = [x["method"] for x in json.loads(world.read_text())["writes"]]
        assert kinds == ["PATCH", "PATCH", "PATCH", "COMMENT"], kinds

        # the spec flow's path: asked at the start; no stage after Specify runs until it is chosen
        run(root, "env.py", "progress", "--id", "502", "--flow", "spec", "--phase", "Specify", "--status", "done",
            "--passed", "Claimed")
        r = run(root, "env.py", "can", "--id", "502", "--op", "phase", "--flow", "spec", "--phase", "Open Questions",
                check=False)
        assert r.returncode == 3 and "no path chosen" in r.stdout, r.stdout
        r = run(root, "env.py", "path", "--id", "502", "--set", "short", check=False)
        assert r.returncode != 0 and "--confirmed" in r.stderr, r.stderr
        run(root, "env.py", "path", "--id", "502", "--set", "short", "--confirmed", "short path please")
        r = run(root, "env.py", "can", "--id", "502", "--op", "phase", "--flow", "spec", "--phase", "Open Questions")
        assert "allowed" in r.stdout and "modes/open-questions.md" in r.stdout.replace("\\", "/"), r.stdout
        rec = json.loads(next((root / ".claude" / "worktrees").glob("502-*/workitem.json")).read_text())
        assert rec["path"] == "short" and rec["pathChosen"]["confirmed"] == "short path please"
        rec["stages"]["Decompose"] = {"at": "t", "status": "worked"}
        next((root / ".claude" / "worktrees").glob("502-*/workitem.json")).write_text(json.dumps(rec))
        r = run(root, "env.py", "path", "--id", "502", "--set", "short", "--confirmed", "again", check=False)
        assert r.returncode != 0 and "too late" in r.stderr, r.stderr
        run(root, "env.py", "path", "--id", "502", "--set", "full", "--confirmed", "back to full")
        # the next item under feature 600 for version 1.1.0
        run(root, "spec.py", "sync", "--id", "600", "--no-embed")
        mpath = root / "docs" / "spec" / ".index" / "metrics.json"
        m = json.loads(mpath.read_text())
        it = m["items"]
        assert [b["id"] for b in it["605"]["blockers"]] == [603] and it["603"]["blocking"] == [605]
        assert [b["id"] for b in it["606"]["blockers"]] == [601] and it["601"]["blocking"] == [606]
        assert it["605"]["ancestors"] == [{"id": 600, "type": "Feature", "title": "Invoice export v2"}]
        assert it["600"]["children"] == {"total": 8, "open": 7, "done": 1, "inProgress": 1, "bugsOpen": 3}, it["600"]["children"]
        assert it["602"]["inProgress"] and it["607"]["done"] and it["601"]["versions"] == ["1.1.0"]
        assert it["603"]["complexity"] == 5 and it["601"]["complexity"] is None
        assert {c["kind"] for c in m["changes"]} == {"new"} and len(m["changes"]) == 9
        nxt = lambda: json.loads(run(root, "spec.py", "next", "--scope", "600", "--version", "1.1.0", "--json").stdout)
        res = nxt()
        why = {r["id"]: r["why"] for r in res["unavailable"]}
        assert set(why) == {602, 604, 607}, why
        assert "Ann is working on it" in why[602] and "tagged 1.0.0" in why[604] and why[607] == "Resolved"
        assert {r["id"]: r["ask"] for r in res["needs"]} == {601: ["complexity"], 605: ["blocked"],
                                                             606: ["blocked", "complexity"]}, res["needs"]
        ev = next(r for r in res["needs"] if r["id"] == 606)["evidence"]
        assert ev[0]["id"] == 601 and ev[0]["kind"] == "named in the text" and "depends on ADO 601" in ev[0]["text"]
        assert [r["id"] for r in res["ranked"]] == [608, 603]       # bugs first; ADO's Blocked=Yes on 608 ignored
        assert "--take" in res["ranked"][1]["note"]                # on Bob's name, not started
        judge = lambda *a: run(root, "spec.py", "next-judge", "--scope", "600", *a)
        judge("--id", "601", "--complexity", "3", "--reason", "one formatter and its tests")
        judge("--id", "605", "--blocked", "yes", "--reason", "the picker needs the CSV export from 603")
        judge("--id", "606", "--blocked", "no", "--complexity", "2", "--reason",
              "the symbol is added after formatting; 601's fix does not change that path")
        res = nxt()
        assert [r["id"] for r in res["ranked"]] == [601, 608, 603, 606], res["ranked"]
        dev = {r["id"]: r["devPriority"] for r in res["ranked"]}
        assert dev == {601: 63.3, 608: 26.7, 603: 85.0, 606: 53.3}, dev   # 50/30/20, complex first
        assert [r["id"] for r in res["blocked"]] == [605] and not res["needs"]
        text = run(root, "spec.py", "next", "--scope", "600", "--version", "1.1.0").stdout
        assert "Ready, best first" in text and "Blocked:" in text and "Ann is working on it" in text, text
        # the evidence changes (603 is done): the old judgement no longer applies, 605 is free
        w = json.loads(world.read_text())
        w["items"]["603"]["fields"]["System.State"] = "Closed"
        w["items"]["603"]["rev"] += 1                                  # ADO bumps rev on every change
        world.write_text(json.dumps(w))
        run(root, "spec.py", "sync", "--id", "600", "--no-embed")
        res = nxt()
        assert 605 in [r["id"] for r in res["ranked"]] and not res["blocked"], res
        m = json.loads(mpath.read_text())
        ch = {c["id"]: c for c in m["changes"]}
        assert set(ch) == {603} and ch[603]["kind"] == "incidental", m["changes"]   # only what moved
        assert ch[603]["diff"] == {"state": ["New", "Closed"]}, ch[603]
        assert m["items"]["605"]["blockers"] == [] and m["items"]["603"]["lastChange"]["diff"]["state"][1] == "Closed"
        assert m["items"]["601"]["lastChange"]["kind"] == "new"                    # carried from the sync before
        # a requirement change: material, with what it likely affects
        w = json.loads(world.read_text())
        w["items"]["606"]["fields"]["System.Title"] = "Show the currency symbol on totals"
        w["items"]["606"]["rev"] += 1
        world.write_text(json.dumps(w))
        run(root, "spec.py", "sync", "--id", "600", "--no-embed")
        c606 = next(c for c in json.loads(mpath.read_text())["changes"] if c["id"] == 606)
        assert c606["kind"] == "material" and c606["fields"] == ["Title"], c606
        assert c606["diff"]["title"] == ["Show currency symbol", "Show the currency symbol on totals"]
        assert 600 in [x["id"] for x in c606["affects"]], c606["affects"]           # its feature, by link
        before = json.loads(mpath.read_text())
        run(root, "spec.py", "metrics")
        assert json.loads(mpath.read_text())["changes"] == before["changes"]       # a rebuild keeps them
        run(root, "spec.py", "sync", "--id", "600", "--no-embed")                  # nothing new in ADO
        after = json.loads(mpath.read_text())
        assert after["changes"] == before["changes"] and after["changesAt"] == before["changesAt"]
        assert after["sync"]["at"] >= before["sync"]["at"]
        # taking an item: never someone's work in progress; one on another name only with --take
        w = json.loads(world.read_text())
        w["items"]["603"]["fields"]["System.State"] = "New"
        world.write_text(json.dumps(w))
        r = run(root, "spec.py", "claim", "--id", "603", check=False)
        assert r.returncode == 3 and "--take" in r.stdout, r.stdout
        run(root, "spec.py", "claim", "--id", "603", "--take")
        f = json.loads(world.read_text())["items"]["603"]["fields"]
        assert f["System.AssignedTo"] == "dev@x.co" and f["Custom.BoardColumnTitle"] == "Dev In Progress"
        r = run(root, "spec.py", "claim", "--id", "602", "--take", check=False)
        assert r.returncode == 3 and "working on it" in r.stdout, r.stdout

        # next syncs its scope first; --no-sync ranks from the last sync; a failed sync stops it
        w = json.loads(world.read_text())
        w["items"]["608"]["fields"][P] = 1
        w["items"]["608"]["rev"] += 1
        world.write_text(json.dumps(w))
        prio = lambda *extra: {r["id"]: r["priority"] for r in json.loads(run(
            root, "spec.py", "next", "--scope", "600", "--version", "1.1.0", "--json", *extra).stdout)["ranked"]}
        assert prio("--no-sync")[608] == 3                       # the mirror still has the old priority
        assert prio()[608] == 1                                  # the default synced first (and --json stays clean)
        os.environ["SDD_FAKE_ADO"] = str(root / "no-such-world.json")
        r = run(root, "spec.py", "next", "--scope", "600", "--version", "1.1.0", check=False)
        assert r.returncode != 0 and "Ready" not in r.stdout, r.stdout
        os.environ["SDD_FAKE_ADO"] = str(world)

        # an AI Agent Request: the report names its items and the work left; route sends it once
        w = json.loads(world.read_text())
        w["items"]["700"] = {"rev": 1, "fields": {
            "System.WorkItemType": "AI Agent Request", "System.TeamProject": "Proj", "System.State": "New",
            "System.Title": "Hand-over: export rounding", "System.AreaPath": "Proj\\Export",
            "System.IterationPath": "Proj\\2026\\Sprint 20",
            "System.Description": "<div>Fixed the rounding for Bug 601. The PDF part of ADO 604 is done.</div>"
                                  "<div>Work still to be done: the PDF export drops the cents.</div>"},
            "comments": [{"text": "<div>Tests for 9999 are not yet written: ADO 9999.</div>",
                          "createdBy": {"displayName": "Agent A"}}]}
        world.write_text(json.dumps(w))
        assert json.loads(run(root, "env.py", "type", "--id", "700").stdout)["flow"] == "request"
        r = run(root, "spec.py", "request", "--id", "700", check=False)
        assert r.returncode != 0 and "spec.py sync --id 700" in r.stderr, r.stderr      # mirror it first
        run(root, "spec.py", "sync", "--id", "700", "--no-embed")
        rep = json.loads(run(root, "spec.py", "request", "--id", "700", "--json").stdout)
        refs = {x["id"]: x for x in rep["references"]}
        assert list(refs) == [601, 604, 9999], refs
        assert refs[601]["fits"] == ["bug"] and refs[601]["open"] and refs[604]["fits"] == ["spec"]
        assert not refs[9999]["found"]
        assert rep["workLeft"] == ["Work still to be done: the PDF export drops the cents.",
                                   "Tests for 9999 are not yet written: ADO 9999."], rep["workLeft"]
        md = (root / rep["request"]).read_text(encoding="utf-8")
        assert "Fixed the rounding" in md and "Agent A" in md, md
        r = run(root, "spec.py", "route", "--id", "700", "--flow", "spec", "--to", "601", check=False)
        assert r.returncode == 3 and "runs the bug flow" in r.stdout, r.stdout
        r = run(root, "spec.py", "route", "--id", "700", "--flow", "spec", "--to", "607", check=False)
        assert r.returncode == 3 and "not open" in r.stdout, r.stdout
        (root / "air.html").write_text("<div>The PDF export drops the cents. See #601.</div>")
        r = run(root, "spec.py", "route", "--id", "700", "--flow", "bug", "--title", "PDF export drops the cents",
                "--text-file", "air.html", check=False)
        assert r.returncode == 3 and "ADO 601" in r.stdout, r.stdout                   # no mention, ever
        (root / "air.html").write_text("<div>The PDF export drops the cents. See ADO 601.</div>")
        run(root, "spec.py", "route", "--id", "700", "--flow", "bug", "--title", "PDF export drops the cents",
            "--text-file", "air.html", "--parent", "600", "--related", "601")
        w = json.loads(world.read_text())
        new = max(int(k) for k in w["items"])
        f = w["items"][str(new)]["fields"]
        assert f["System.WorkItemType"] == "Bug" and "ADO 601" in f["Microsoft.VSTS.TCM.ReproSteps"], f
        assert f["System.AreaPath"] == "Proj\\Export" and f["System.IterationPath"] == "Proj\\2026\\Sprint 20"
        rels = {(x["rel"].split(".")[-1], x["url"].split("/")[-1]) for x in w["items"][str(new)]["relations"]}
        assert rels == {("Related", "700"), ("Hierarchy-Reverse", "600"), ("Related", "601")}, rels
        assert w["writes"][-1] == {"method": "COMMENT", "id": 700, "text": w["writes"][-1]["text"]}
        assert f"ADO {new} (Bug" in w["writes"][-1]["text"]
        r = run(root, "spec.py", "route", "--id", "700", "--flow", "bug", "--to", "601", check=False)
        assert r.returncode == 3 and f"ADO {new}" in r.stdout, r.stdout                # once only
        assert f"/sdd bug {new}" in run(root, "spec.py", "request", "--id", "700").stdout
        # an open item the work belongs to: linked to the request, nothing created
        w["items"]["710"] = dict(w["items"]["700"], rev=1, comments=[])
        world.write_text(json.dumps(w))
        run(root, "spec.py", "sync", "--id", "710", "--no-embed")
        run(root, "spec.py", "route", "--id", "710", "--flow", "bug", "--to", "601")
        w = json.loads(world.read_text())
        assert max(int(k) for k in w["items"]) == 710 and w["items"][str(new)]["fields"]["System.WorkItemType"] == "Bug"
        assert w["writes"][-2]["method"] == "PATCH" and w["writes"][-2]["id"] == 601
        assert w["writes"][-2]["ops"][0]["op"] == "test"                                # rev-tested link
        assert any(x["url"].endswith("/710") for x in w["items"]["601"]["relations"])

        view = json.loads(run(root, "env.py", "view", "--json", "--id", "502").stdout)
        assert {i["id"]: i.get("path") for i in view["items"]}[502] == "full", view["items"]
        assert view["flows"]["spec"]["paths"]["short"]["label"].startswith("Short")   # the view reads the paths
    print("ok")


if __name__ == "__main__":
    main()
