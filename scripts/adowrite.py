"""Rev-tested writes to Azure DevOps work items: the claim, the QA hand-over, the sprint move, a comment,
and the route of an AI Agent Request to the item that takes its work (a link, or a new item).

Every patch starts with a JSON Patch `test /rev` op, so a write never overwrites a change someone
else made since the read. On HTTP 412 it reads the item again, decides again from what is there
now, and retries (3 tries in all). The decisions are plain functions of the item's fields, so they
are tested without ADO. spec.py claim / handover / sprint / comment / route are the commands. A create
has no prior revision, so it needs no rev test.
"""
import re
import subprocess
import urllib.parse
from datetime import date, datetime

from sddlib import ado, get_items, org_url

PATCH = "application/json-patch+json"
ASSIGNED, STATE, COLUMN = "System.AssignedTo", "System.State", "Custom.BoardColumnTitle"
TAGS, ITERATION, TYPE, PROJECT = "System.Tags", "System.IterationPath", "System.WorkItemType", "System.TeamProject"
TITLE, AREA, DESCRIPTION = "System.Title", "System.AreaPath", "System.Description"
REPRO, ACCEPTANCE = "Microsoft.VSTS.TCM.ReproSteps", "Microsoft.VSTS.Common.AcceptanceCriteria"
RELATED, PARENT = "System.LinkTypes.Related", "System.LinkTypes.Hierarchy-Reverse"
ROOT_CAUSE_DETAILS, RESOLUTION, ROOT_CAUSE = ("Custom.RootCauseDetails", "Microsoft.VSTS.Common.Resolution",
                                              "Microsoft.VSTS.CMMI.RootCause")
READ = [TYPE, PROJECT, "System.Title", STATE, ASSIGNED, COLUMN, TAGS, ITERATION]
DONE_STATES = ("Resolved", "Closed", "Done", "Removed")
# `#80459` in ADO text is a mention: ADO posts "Mentioned in" back onto that item. `AB#80459` is not.
MENTION = re.compile(r"(?<![\w#&/])#\d{3,}\b")


class Refused(Exception):
    """The item's state says stop: a person decides. The message says what to ask."""


class Conflict(Exception):
    """Someone else kept changing the item while we wrote (HTTP 412 on every try)."""


def mentions(text):
    return MENTION.findall(text or "")


def refuse_mentions(text, what):
    found = mentions(text)
    if found:
        raise Refused(f"{what} names {', '.join(found)}. ADO reads `#<id>` as a mention and posts a comment "
                      f"onto that item. Write `ADO {found[0][1:]}` instead (AB#<id> stays fine in a commit or PR title).")


def my_email():
    r = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True)
    return (r.stdout or "").strip()


def assignee(fields):
    """(email, display) of System.AssignedTo; ("", "") when unassigned — ADO leaves the field out."""
    v = fields.get(ASSIGNED)
    if isinstance(v, dict):
        return (v.get("uniqueName") or "").lower(), v.get("displayName") or v.get("uniqueName") or ""
    m = re.search(r"<([^>]+)>", v or "")
    return ((m.group(1) if m else (v or "")).lower(), v or "")


def add(field, value):
    return {"op": "add", "path": f"/fields/{field}", "value": value}


# ---------------------------------------------------------------- decisions

IN_PROGRESS_STATES, IN_PROGRESS_BOARDS = ("Active",), ("Dev In Progress",)


def in_progress(fields, states=IN_PROGRESS_STATES, boards=IN_PROGRESS_BOARDS):
    """Someone is working on it: Active, or in Dev In Progress on the board."""
    low = lambda v: (v or "").strip().lower()
    return low(fields.get(STATE)) in {low(x) for x in states} or low(fields.get(COLUMN)) in {low(x) for x in boards}


def claim_ops(fields, me, reopen=False, take=False, busy=(IN_PROGRESS_STATES, IN_PROGRESS_BOARDS)):
    """The claim: assigned to me, Active, Dev In Progress, written together. Never takes an item someone
    is working on (Active or Dev In Progress). An item on someone else's name that is not started is
    free to take under the team's rule, but only with `take` — after the user picked it."""
    who, display = assignee(fields)
    if who and who != me.lower():
        if in_progress(fields, *busy):
            raise Refused(f"{display} is working on it ({fields.get(STATE)}, {fields.get(COLUMN) or 'no board column'}). "
                          "Never take a work item someone is working on: pick another, or ask them")
        if not take:
            raise Refused(f"on {display}'s name but not started. The team rule lets you take it: ask the user, "
                          "then run claim again with --take")
    state = fields.get(STATE, "")
    if state in DONE_STATES and not reopen:
        raise Refused(f"state is {state}: it is already fixed, or this is a regression. Ask the user; after their "
                      "yes, run claim again with --reopen")
    ops = [] if who == me.lower() else [add(ASSIGNED, me)]
    if state != "Active":
        ops.append(add(STATE, "Active"))
    if fields.get(COLUMN) != "Dev In Progress":
        ops.append(add(COLUMN, "Dev In Progress"))
    return ops


def handover_ops(fields, tag=None, root_cause_details=None, resolution=None, root_cause=None):
    """The hand-over to QA: Resolved with Dev Completed, written together. An Issue needs Root Cause
    Details and Resolution; a Bug takes them too. A tag is appended to the tags, never replaces them."""
    if fields.get(TYPE) == "Issue" and not (root_cause_details and resolution):
        raise Refused("an Issue needs Root Cause Details and Resolution: pass --root-cause-details-file and "
                      "--resolution-file")
    refuse_mentions(root_cause_details, "Root Cause Details")
    refuse_mentions(resolution, "Resolution")
    ops = []
    if fields.get(COLUMN) != "Dev Completed":
        ops.append(add(COLUMN, "Dev Completed"))
    if fields.get(STATE) != "Resolved":
        ops.append(add(STATE, "Resolved"))
    if root_cause_details:
        ops.append(add(ROOT_CAUSE_DETAILS, root_cause_details))
    if resolution:
        ops.append(add(RESOLUTION, resolution))
    if root_cause:
        ops.append(add(ROOT_CAUSE, root_cause))
    if tag:
        tags = [t.strip() for t in (fields.get(TAGS) or "").split(";") if t.strip()]
        if tag not in tags:
            ops.append(add(TAGS, "; ".join(tags + [tag])))
    return ops


# ---------------------------------------------------------------- AI Agent Request: read and route

# How a handover names a work item: ADO 4471, ADO-4471, AB#4471, #4471, work item 4471, Bug 4471,
# User Story 4471, a _workitems/edit/4471 link. A bare number is never a reference (versions, counts).
ITEM_REF = re.compile(r"(?:\bADO[\s#:-]*|\bAB#|(?<![\w&/])#|_workitems/edit/|\bwork\s*items?\s*|"
                      r"\b(?:bug|issue|user\s+story|tech\s+story|story|change\s+request|task|feature|epic|pbi)"
                      r"\s*#?\s*)(\d{3,})\b", re.I)
# A statement that work is left: "work still to be done", "remaining", "not yet implemented", "TODO".
TODO = re.compile(r"still\s+to\s+(?:be\s+)?do|still\s+needs?|remain(?:s|ing)|left\s+to\s+do|"
                  r"\bnot\s+yet\b|\bnot\s+(?:done|finished|implemented|complete|started|fixed|tested|written)\b|"
                  r"outstanding|\bto-?do\b|next\s+steps?|\bpending\b|follow[\s-]?ups?|incomplete|"
                  r"unfinished|\byet\s+to\b|work\s+in\s+progress|\bwip\b|open\s+items?", re.I)


def referenced_ids(text, skip=()):
    """Work item ids the text names, in the order they first appear, without `skip`."""
    out = []
    for m in ITEM_REF.finditer(text or ""):
        i = int(m.group(1))
        if i not in out and i not in skip:
            out.append(i)
    return out


def todo_lines(text):
    """The lines and sentences of plain text that say work is left, as written."""
    out = []
    for line in (text or "").splitlines():
        for sent in re.split(r"(?<=[.!?])\s+(?=[A-Z])", line.strip(" -*\t")):
            sent = sent.strip()
            if sent and TODO.search(sent) and sent not in out:
                out.append(sent)
    return out


def flow_of(typ, request_types=("AI Agent Request",)):
    """The sdd flow a work item type runs: bug, spec, or request (an AI Agent Request, routed first)."""
    if typ in request_types:
        return "request"
    return "bug" if typ in ("Bug", "Issue") else "spec"


def route_fit(fields, flow, done_states=DONE_STATES, request_types=("AI Agent Request",)):
    """None when an existing item can take the request's work on `flow`; else why not. It must be open,
    and its type must run that flow: the bug flow takes only a Bug or Issue, the spec flow the rest."""
    typ, state = fields.get(TYPE, ""), fields.get(STATE, "")
    if typ in request_types:
        return f"it is an {typ} itself, not the item that does the work"
    if state in tuple(done_states) + ("Removed",):
        return f"it is {state}: not open"
    if flow_of(typ, request_types) != flow:
        return f"a {typ} runs the {flow_of(typ, request_types)} flow, not the {flow} flow"
    return None


def item_url(cfg, wid):
    return f"{org_url(cfg)}/_apis/wit/workItems/{int(wid)}"


def link_op(relations, rel, url, comment=None):
    """[] when the link is already there, else the op that adds it."""
    wid = url.rstrip("/").split("/")[-1]
    if any(r.get("rel") == rel and r.get("url", "").rstrip("/").split("/")[-1] == wid for r in relations or []):
        return []
    value = {"rel": rel, "url": url}
    if comment:
        value["attributes"] = {"comment": comment}
    return [{"op": "add", "path": "/relations/-", "value": value}]


def create_ops(typ, title, text, request_fields, acceptance=None, links=()):
    """A new work item for a request's work: the title, the text (Repro Steps on a Bug, else the
    Description), the acceptance criteria if given, and the request's area and iteration. `links` are
    (rel, url) pairs. Refuses a `#<id>` mention in any of it."""
    title = (title or "").strip()
    if not title:
        raise Refused("the new item needs a title")
    if not (text or "").strip():
        raise Refused("the new item needs its text: what the request says is left to do")
    for v, what in ((title, "the title"), (text, "the text"), (acceptance, "the acceptance criteria")):
        refuse_mentions(v, what)
    ops = [add(TITLE, title), add(REPRO if typ in ("Bug", "Issue") else DESCRIPTION, text)]
    if acceptance:
        ops.append(add(ACCEPTANCE, acceptance))
    for f in (AREA, ITERATION):
        if request_fields.get(f):
            ops.append(add(f, request_fields[f]))
    for rel, url in links:
        ops += link_op([], rel, url)
    return ops


def iteration_ops(fields, path):
    return [] if fields.get(ITERATION) == path else [add(ITERATION, path)]


def _day(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).date() if s else None


def pick_iteration(node, today):
    """The iteration path whose dates hold `today`, from the classification-node tree; the shortest
    range wins (a sprint inside a release). Node paths look like \\Project\\Iteration\\2026\\Sprint 18;
    System.IterationPath wants Project\\2026\\Sprint 18."""
    best = None

    def walk(n):
        nonlocal best
        at = n.get("attributes") or {}
        start, end = _day(at.get("startDate")), _day(at.get("finishDate"))
        if start and end and start <= today <= end and (best is None or end - start < best[0]):
            best = (end - start, n.get("path") or "")
        for c in n.get("children") or []:
            walk(c)

    walk(node)
    if not best:
        return None
    parts = [p for p in best[1].split("\\") if p]
    if len(parts) > 1 and parts[1] == "Iteration":
        del parts[1]
    return "\\".join(parts)


# ---------------------------------------------------------------- ADO calls

def read(cfg, wid, relations=False):
    """The item's READ fields; with relations, every field and its links."""
    got = get_items(cfg, [wid], relations=True) if relations else get_items(cfg, [wid], READ)
    if not got:
        raise Refused(f"work item {wid} not found (deleted, or no access)")
    return got[0]


def write(cfg, wid, plan, tries=3, dry_run=False, whole=False):
    """Read, decide (`plan(fields)` -> ops), patch with the rev test. On 412: read again, decide again.
    -> (item as read, ops written). No ops -> nothing to write, nothing sent. With `whole`, plan gets
    the whole item, links too (`plan(item)`)."""
    for attempt in range(tries):
        w = read(cfg, wid, relations=whole)
        ops = plan(w if whole else w["fields"])
        if not ops or dry_run:
            return w, ops
        body = [{"op": "test", "path": "/rev", "value": w["rev"]}] + ops
        try:
            ado("PATCH", f"{org_url(cfg)}/_apis/wit/workitems/{wid}?api-version=7.1", body, content_type=PATCH)
            return w, ops
        except RuntimeError as e:
            if "HTTP 412" not in str(e):
                raise
    raise Conflict(f"work item {wid} changed under every one of {tries} tries. Ask the user what to do")


def current_iteration(cfg, project, team=None, today=None):
    """The current sprint's path: the team's current iteration, else the iteration whose dates hold today
    (a team with no iteration schedule)."""
    today = today or date.today()
    q = urllib.parse.quote
    team = team or f"{project} Team"
    try:
        r = ado("GET", f"{org_url(cfg)}/{q(project)}/{q(team)}/_apis/work/teamsettings/iterations"
                       f"?$timeframe=current&api-version=7.1")
        if (r or {}).get("value"):
            return r["value"][0]["path"]
    except RuntimeError:
        pass
    tree = ado("GET", f"{org_url(cfg)}/{q(project)}/_apis/wit/classificationnodes/Iterations?$depth=20&api-version=7.1")
    path = pick_iteration(tree or {}, today)
    if not path:
        raise Refused(f"no iteration in {project} holds today's date ({today}). Ask the user which sprint to use")
    return path


def comment(cfg, project, wid, html_text):
    refuse_mentions(html_text, "the comment")
    q = urllib.parse.quote
    return ado("POST", f"{org_url(cfg)}/{q(project)}/_apis/wit/workItems/{wid}/comments?format=html"
                       f"&api-version=7.1-preview.4", {"text": html_text})


def create(cfg, project, typ, ops):
    """Create a work item of `typ` in `project` from the ops. -> the new item."""
    q = urllib.parse.quote
    return ado("POST", f"{org_url(cfg)}/{q(project)}/_apis/wit/workitems/${q(typ)}?api-version=7.1", ops,
               content_type=PATCH)


def comments(cfg, project, wid):
    """The item's comments, oldest first, as {by, at, text (HTML)}."""
    q = urllib.parse.quote
    r = ado("GET", f"{org_url(cfg)}/{q(project)}/_apis/wit/workItems/{wid}/comments?order=asc"
                   f"&api-version=7.1-preview.4")
    return [{"by": ((c.get("createdBy") or {}).get("displayName") or ""), "at": c.get("createdDate") or "",
             "text": c.get("text") or ""} for c in (r or {}).get("comments") or []]
