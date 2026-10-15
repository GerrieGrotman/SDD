"""Claude Code hook: in an sdd flow, every question to the user comes with its Links block.

    pre   (PreToolUse, matcher AskUserQuestion) -> blocks the question when no Links block was shown
    stop  (Stop)                                -> sends the agent back when it ended its turn with a
                                                   plain-text question instead of AskUserQuestion

Only active when an sdd flow is: this turn ran an sdd script (env.py / spec.py, not doctor/init/type),
or a work item's progress was written during this session. Exit 2 = block, stderr goes to the agent.
"""
import json
import re
import sys
from pathlib import Path

LINK = re.compile(r"\]\(([^)\s]+)\)")
# A real run of an sdd script: python (or py, uv run python) is the program of a command, and its
# first argument is .../scripts/env.py or spec.py. A grep or cat that only names the file is not a run.
SEGMENT = re.compile(r"&&|\|\||[;|\n]")
SCRIPT = re.compile(r"""^\s*(?:&\s*)?(?:uv\s+run\s+)?"""
                    # a quoted program closes right after its name: "C:/Program Files/python.exe"
                    r"""(?:"(?:[^"]*[\\/])?(?:python3?|py)(?:\.exe)?"|'(?:[^']*[\\/])?(?:python3?|py)(?:\.exe)?'"""
                    r"""|(?:[^\s"']*[\\/])?(?:python3?|py)(?:\.exe)?)"""
                    r"""(?:\s+-\S+)*\s+(?:"(?:[^"]*[\\/])?|'(?:[^']*[\\/])?|(?:[^\s"']*[\\/])?)scripts[\\/]+(env|spec)\.py["']?\s+(\w+)""")
EXEMPT = {"doctor", "init", "type", "view", "upgrade"}  # never mean a flow is running (upgrade = upgrade-config)
ENV_PY = (Path(__file__).resolve().parent.parent / "scripts" / "env.py").as_posix()
HOW = (f"Run `python {ENV_PY} refs --id <id> --ref <spec file or "
       "code path:line> ...` (or the `--status waiting` checkpoint with `--ref`), paste its Links block "
       "directly above the question (no gap: nothing between the Links block and the question), send the listed files with SendUserFile, then ask with AskUserQuestion.")


def rows(path):
    try:
        return [json.loads(x) for x in Path(path).read_text(encoding="utf-8").splitlines() if x.strip()]
    except (OSError, ValueError):
        return []


def blocks(r):
    c = (r.get("message") or {}).get("content")
    return c if isinstance(c, list) else ([{"type": "text", "text": c}] if isinstance(c, str) else [])


def is_real_user(r):
    if r.get("type") != "user" or r.get("isSidechain"):
        return False
    b = blocks(r)
    return bool(b) and not any(x.get("type") == "tool_result" for x in b if isinstance(x, dict))


def current_turn(rs):
    last = max((i for i, r in enumerate(rs) if is_real_user(r)), default=-1)
    return [r for r in rs[last + 1:] if not r.get("isSidechain")]


def turn_text(turn):
    return "\n".join(b.get("text", "") for r in turn if r.get("type") == "assistant"
                     for b in blocks(r) if isinstance(b, dict) and b.get("type") == "text")


HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?^\s*\2\s*$", re.S | re.M)
HERESTRING = re.compile(r"@(['\"])\r?\n.*?^\1@", re.S | re.M)


def sdd_calls(cmd):
    """(script, command, segment) for each real sdd script run in a shell command line. The body of a
    heredoc or a PowerShell here-string is data (a file being written), never a run."""
    cmd = HERESTRING.sub("", HEREDOC.sub("", cmd))
    for seg in SEGMENT.split(re.sub(r"[\\`]\r?\n", " ", cmd)):
        m = SCRIPT.match(seg)
        if m:
            yield m.group(1), m.group(2), seg


def ran_sdd_script(turn):
    for r in turn:
        for b in blocks(r):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                cmd = str((b.get("input") or {}).get("command", ""))
                if any(c not in EXEMPT for _, c, _ in sdd_calls(cmd)):
                    return True
    return False


def ran_links_script(turn):
    """This turn printed a Links block: `env.py refs` or a `progress --status waiting` checkpoint.
    Tool calls are always in the transcript; the chat text before a question is not always written
    yet when the hook runs, so this is the reliable signal."""
    for r in turn:
        for b in blocks(r):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                cmd = str((b.get("input") or {}).get("command", ""))
                for _, c, seg in sdd_calls(cmd):
                    if c == "refs" or (c == "progress" and re.search(r"--status\s+waiting", seg)):
                        return True
    return False


def flow_this_session(rs, cwd=None):
    """This session ran an sdd script in any earlier turn. Read from this session's own transcript
    only: scanning the workspace's workitem.json files also matched flows run by OTHER sessions."""
    return ran_sdd_script([r for r in rs if not r.get("isSidechain")])


def has_links(text):
    links = LINK.findall(text or "")
    return any("_workitems/edit/" in x for x in links) and len(links) >= 2


def ends_with_question(text):
    """The reply's last line asks something. A "?" earlier in the text — a heading such as
    "Did it work? Yes." — is not a question waiting for the user."""
    t = re.sub(r"```.*?```", "", text or "", flags=re.S)
    t = re.sub(r"`[^`]*`|https?://\S+|\]\([^)]*\)", "", t)
    lines = [l.strip() for l in t.splitlines() if l.strip()]
    return bool(lines) and lines[-1].rstrip("*_)]\"' ").endswith("?")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    rs = rows(data.get("transcript_path", ""))
    turn = current_turn(rs)
    if not (ran_sdd_script(turn) or flow_this_session(rs, data.get("cwd"))):
        return 0
    text = turn_text(turn)
    if mode == "pre" and data.get("tool_name") == "AskUserQuestion":
        # links (ADO, PR, files) belong in the chat above the question, never inside it
        if re.search(r"\]\(|https?://|file:///", json.dumps(data.get("tool_input") or {})):
            print("sdd: the question contains links. Put every link (work item, PR, files) in the chat "
                  "message above the question, then ask again with plain text only in the question "
                  "and its options.", file=sys.stderr)
            return 2
        if has_links(text) or ran_links_script(turn):
            return 0
        print("sdd: no Links block this turn. Run `env.py refs` (or the `--status waiting` checkpoint "
              "with `--ref`) in this turn, paste its Links block in the chat, then ask again. " + HOW, file=sys.stderr)
        return 2
    if mode == "stop" and not data.get("stop_hook_active"):
        last = next((b.get("text", "") for r in reversed(turn) if r.get("type") == "assistant"
                     for b in reversed(blocks(r)) if isinstance(b, dict) and b.get("type") == "text"), "")
        if ends_with_question(last):
            print("sdd: you ended the turn with a question in plain text. In an sdd flow every question "
                  "to the user goes through AskUserQuestion, with its Links block above it. Re-ask it "
                  "that way now (or, if it was not a question for the user, end without one). " + HOW,
                  file=sys.stderr)
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
