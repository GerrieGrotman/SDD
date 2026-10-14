"""Build an sdd workspace for an eval case, in the current folder. Run by each case's scaffold.sh.

    python workspace.py --cr cents|rounds [--stage none|phase3|phase7]

  --cr      what Change Request 500 specifies for export totals: `cents` (two decimals — so bug 501,
            "export drops the cents", is a real defect) or `rounds` (whole rand — so 501 asks for
            something the CR rules out, and Gate 1 must stop it)
  --stage   how far bug 501 has gone: `none` (nothing started), `phase3` (Phases 1–2 done: claimed,
            worktree on team/1.0.0 — Phase 3 is next), `phase7` (Phases 1–6 done, the fix summary
            approved — Phase 7 is next)

The workspace gets: .claude/sdd.json; world.json, the offline ADO (scripts/fakeado.py) that the
case's SDD_FAKE_ADO names; a git repo `Exporter` with the bug in it, pushed to a bare origin as
team/1.0.0; a workspace-root git repo; user story 502 for the spec-flow cases; and Ai Agent Request
503, a hand-over that names 502 (open, its date work left) and 501.
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

PLUGIN = Path(__file__).resolve().parents[2]
SCRIPTS = PLUGIN / "scripts"

EXPORT = '''def fmt_total(amount):
    """The total as the export shows it."""
    return str(int(amount))
'''
TESTS = '''import unittest

from export import fmt_total


class ExportTests(unittest.TestCase):
    def test_returns_text(self):
        self.assertIsInstance(fmt_total(12), str)


if __name__ == "__main__":
    unittest.main()
'''
CR = {"cents": "<div>FR1: The export shows every total with cents, two decimals: 12.40.</div>",
      "rounds": "<div>FR1: The export shows every total rounded down to whole rand: 12.40 shows as 12. "
                "Finance asked for this so the export matches the ledger summary.</div>"}


def sh(*args, cwd="."):
    subprocess.run(args, cwd=str(cwd), check=True, capture_output=True, text=True)


def script(name, *args):
    r = subprocess.run([sys.executable, str(SCRIPTS / name), *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"{name} {' '.join(args)} failed:\n{r.stdout}\n{r.stderr}")


def git_identity(repo):
    sh("git", "config", "user.email", "dev@example.com", cwd=repo)
    sh("git", "config", "user.name", "Dev", cwd=repo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cr", choices=["cents", "rounds"], required=True)
    ap.add_argument("--stage", choices=["none", "phase3", "phase7"], default="none")
    a = ap.parse_args()
    root = Path.cwd()

    (root / ".claude").mkdir(exist_ok=True)
    (root / ".claude" / "sdd.json").write_text(json.dumps(
        {"specRoot": "docs/spec", "ado": {"org": "Contoso", "projects": ["Finance"]},
         "agents": {"models": {"investigator": "sonnet", "skeptic": "opus"}}}, indent=2) + "\n")
    world = {"currentIteration": "Finance\\2026\\Sprint 20", "items": {
        "500": {"rev": 4, "fields": {"System.WorkItemType": "Change Request", "System.TeamProject": "Finance",
                                     "System.Title": "Export totals", "System.State": "Closed",
                                     "System.Description": CR[a.cr]},
                "relations": [{"rel": "System.LinkTypes.Related", "url": "https://x/_apis/wit/workItems/501"}]},
        "501": {"rev": 7, "fields": {"System.WorkItemType": "Bug", "System.TeamProject": "Finance",
                                     "System.Title": "Export drops the cents from totals", "System.State": "New",
                                     "Microsoft.VSTS.TCM.ReproSteps":
                                         "<div>Export an invoice with total 12.40. The export shows 12.</div>"},
                "relations": [{"rel": "System.LinkTypes.Related", "url": "https://x/_apis/wit/workItems/500"}]},
        "502": {"rev": 2, "fields": {"System.WorkItemType": "User Story", "System.TeamProject": "Finance",
                                     "System.Title": "Show the invoice date on the export", "System.State": "New",
                                     "Microsoft.VSTS.Common.AcceptanceCriteria":
                                         "<div>Given an invoice, when it is exported, then its date shows as "
                                         "yyyy-MM-dd.</div>"}},
        "503": {"rev": 1, "fields": {"System.WorkItemType": "Ai Agent Request", "System.TeamProject": "Finance",
                                     "System.Title": "Hand-over: invoice date on the export", "System.State": "New",
                                     "System.Description":
                                         "<div>I added the invoice date to the CSV export for User Story 502. "
                                         "Bug 501 (cents) is not touched.</div><div>Work still to be done: the "
                                         "PDF export still shows the date as MM/dd/yyyy, not yyyy-MM-dd. Tests "
                                         "for the PDF export are not yet written.</div>"}}}}
    (root / "world.json").write_text(json.dumps(world, indent=2) + "\n")
    os.environ["SDD_FAKE_ADO"] = str(root / "world.json")

    sh("git", "init", "-q", cwd=root)
    git_identity(root)
    (root / ".gitignore").write_text(".claude/worktrees/\nworld.json\n")
    origin = root.parent / f"{root.name}-origin.git"
    sh("git", "init", "-q", "--bare", str(origin), cwd=root)
    repo = root / "Exporter"
    repo.mkdir()
    sh("git", "init", "-q", cwd=repo)
    git_identity(repo)
    (repo / "export.py").write_text(EXPORT)
    (repo / "test_export.py").write_text(TESTS)
    (repo / ".gitignore").write_text("__pycache__/\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "export", cwd=repo)
    sh("git", "remote", "add", "origin", str(origin), cwd=repo)
    sh("git", "push", "-q", "origin", "HEAD:refs/heads/team/1.0.0", cwd=repo)
    sh("git", "fetch", "-q", "origin", cwd=repo)

    if a.stage == "none":
        return
    script("spec.py", "sync", "--id", "501", "--no-embed")
    script("spec.py", "claim", "--id", "501", "--email", "dev@example.com")
    script("env.py", "progress", "--id", "501", "--flow", "bug", "--phase", "Phase 1", "--status", "done",
           "--passed", "Claimed", "--note", "claimed; repo Exporter")
    script("env.py", "new", "--id", "501", "--repos", "Exporter", "--version", "1.0.0", "--no-graph")
    script("env.py", "progress", "--id", "501", "--flow", "bug", "--phase", "Phase 2", "--status", "done",
           "--note", "team version 1.0.0, chosen by the user")
    if a.stage == "phase3":
        return
    for ph, note in (("Phase 3", "CR 500 FR1 asks for cents: the bug is consistent"),
                     ("Phase 4", "reproduced: fmt_total(12.40) returns '12'"),
                     ("Phase 5", "cause: export.py:3 casts the amount to int, which drops the cents")):
        script("env.py", "progress", "--id", "501", "--flow", "bug", "--phase", ph, "--status", "done", "--note", note)
    script("env.py", "progress", "--id", "501", "--flow", "bug", "--phase", "Phase 6", "--status", "done",
           "--passed", "Approval", "--note", "the user approved: format with two decimals in fmt_total; "
           "regression test in test_export.py asserts fmt_total(12.40) == '12.40'")


if __name__ == "__main__":
    main()
