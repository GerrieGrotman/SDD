"""Self-check for edit_guard.py: python test_edit_guard.py  (temp files only)."""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HOOK = Path(__file__).with_name("edit_guard.py")
SDD = "python C:/plugins/sdd/scripts/env.py new --id 5 --repos RepoA --version 1.0.0"


def transcript(path, flow=True, earlier=False):
    run = {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": SDD}}]}}
    user = lambda t: {"type": "user", "message": {"role": "user", "content": t}}
    rows = [user("fix 5")] + ([run] if flow else [])
    if earlier:
        rows += [user("now edit")]  # the sdd run was in an earlier turn of this session
    path.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")


def run(tp, cwd, file_path, tool="Edit", key="file_path"):
    data = {"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": {key: str(file_path)},
            "transcript_path": str(tp), "cwd": str(cwd)}
    p = subprocess.run([sys.executable, str(HOOK), "pre"], input=json.dumps(data), capture_output=True, text=True)
    return p.returncode, p.stderr


def main():
    fails = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp).resolve()      # the hook resolves paths: a short (8.3) TEMP name would not match
        (root / ".claude").mkdir()
        (root / ".claude" / "sdd.json").write_text(json.dumps({"specRoot": "docs/spec", "ado": {"org": "O", "projects": ["P"]}}))
        (root / "RepoA" / ".git").mkdir(parents=True)
        (root / "RepoA" / "src").mkdir()
        (root / "Group" / "RepoB" / ".git").mkdir(parents=True)          # a grandchild repo
        wt = root / ".claude" / "worktrees" / "5-fix-it" / "src" / "RepoA"
        (wt / "src").mkdir(parents=True)
        (root / "docs" / "spec").mkdir(parents=True)
        tp = root / "t.jsonl"
        transcript(tp)

        def expect(code, file_path, why, **kw):
            got, err = run(tp, kw.pop("cwd", root), file_path, **kw)
            if got != code:
                fails.append(f"{why}: exit {got}, wanted {code} ({err.strip()[:160]})")
            return err

        err = expect(2, root / "RepoA" / "src" / "a.cs", "main checkout repo file")
        if str(wt / "src" / "a.cs") not in err:
            fails.append(f"no worktree hint in: {err}")
        expect(2, "RepoA/src/a.cs", "relative path from the workspace root")
        expect(2, root / "RepoA" / "src" / "a.cs", "a file in a repo, cwd inside the repo", cwd=root / "RepoA")
        err = expect(2, root / "Group" / "RepoB" / "x.cs", "grandchild repo, no worktree for it", tool="Write")
        if "env.py new" not in err:
            fails.append(f"no `env.py new` hint in: {err}")
        expect(2, root / "RepoA" / "n.ipynb", "a notebook", tool="NotebookEdit", key="notebook_path")
        expect(0, wt / "src" / "a.cs", "the worktree")
        expect(0, root / "docs" / "spec" / "5-BUG-x" / "design.md", "the spec folder")
        expect(0, root / "CLAUDE.md", "the workspace CLAUDE.md")
        expect(0, root / ".claude" / "scripts" / "run.ps1", ".claude/scripts")
        expect(0, Path(tmp).parent / "elsewhere.txt", "outside the workspace")
        transcript(tp, earlier=True)
        expect(2, root / "RepoA" / "src" / "a.cs", "flow started in an earlier turn")
        transcript(tp, flow=False)
        expect(0, root / "RepoA" / "src" / "a.cs", "no sdd flow in this session")
    print("\n".join(fails) or "ok")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
