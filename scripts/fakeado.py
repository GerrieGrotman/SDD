"""An offline stand-in for the Azure DevOps REST calls the sdd scripts make — for evals and tests.

Set SDD_FAKE_ADO to a JSON "world" file and sddlib.ado() answers from it instead of calling ADO (no
`az` login needed). Writes change the world and are logged in it, so a test or an eval grader reads
back what the flow wrote. Only the endpoints the scripts use are served; anything else is an error,
so a new call cannot slip through unnoticed.

    {
      "items": {"501": {"rev": 3, "fields": {"System.WorkItemType": "Bug", ...},
                        "relations": [{"rel": "System.LinkTypes.Hierarchy-Reverse",
                                       "url": ".../_apis/wit/workItems/500"}]}},
      "currentIteration": "Proj\\2026\\Sprint 20",        (optional: the team's current sprint)
      "iterations": {...classification node tree...},     (optional: the fallback)
      "writes": []                                        (filled in: every PATCH, create, comment and PR)
    }

An item may hold "comments": [{"text": "<div>…</div>", "createdBy": {"displayName": "…"}}], read back
with the ones the flow posts.
"""
import json
import os
import re
import urllib.parse
from pathlib import Path

ENV = "SDD_FAKE_ADO"
HIER_FWD = "System.LinkTypes.Hierarchy-Forward"


def active():
    return bool(os.environ.get(ENV))


def world_path():
    """SDD_FAKE_ADO as given; a relative path is looked for here and in each folder above, so it
    still resolves from inside a worktree (an eval case names it relative to its workspace)."""
    p = Path(os.environ[ENV])
    if p.is_absolute():
        return p
    here = Path.cwd().resolve()
    for d in [here, *here.parents]:
        if (d / p).is_file():
            return d / p
    raise RuntimeError(f"fake ADO: {p} not found here or in any folder above {here}")


def _load():
    p = world_path()
    return p, json.loads(p.read_text(encoding="utf-8"))


def _save(p, world):
    p.write_text(json.dumps(world, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _link_ids(item, rel):
    out = []
    for r in item.get("relations") or []:
        m = re.search(r"/workItems/(\d+)$", r.get("url", ""), re.I)
        if m and r.get("rel") == rel:
            out.append(int(m.group(1)))
    return out


def _children(items, wid):
    """Hierarchy-Forward links, plus items whose Hierarchy-Reverse link points at wid."""
    kids = set(_link_ids(items.get(str(wid), {}), HIER_FWD))
    kids |= {int(k) for k, v in items.items() if wid in _link_ids(v, "System.LinkTypes.Hierarchy-Reverse")}
    return sorted(kids)


def _apply(w, ops):
    """JSON Patch ops on a fake item: field adds and replaces, and relation adds."""
    for o in ops:
        if o["op"] in ("add", "replace") and o["path"].startswith("/fields/"):
            w.setdefault("fields", {})[o["path"][len("/fields/"):]] = o["value"]
        elif o["op"] == "add" and o["path"] == "/relations/-":
            w.setdefault("relations", []).append(o["value"])


def request(method, url, body=None):
    p, world = _load()
    items = world.setdefault("items", {})
    writes = world.setdefault("writes", [])
    path = urllib.parse.urlparse(url).path

    if path.endswith("/workitemsbatch"):
        out = []
        for i in body["ids"]:
            w = items.get(str(i))
            if not w:
                continue
            fields = dict(w.get("fields") or {})
            if body.get("fields"):
                fields = {k: v for k, v in fields.items() if k in body["fields"]}
            d = {"id": int(i), "rev": w.get("rev", 1), "fields": fields}
            if body.get("$expand") == "relations":
                d["relations"] = w.get("relations") or []
            out.append(d)
        return {"value": out}

    if path.endswith("/wiql"):
        q = body["query"]
        if "WorkItemLinks" in q:
            root = int(re.search(r"\[System\.Id\]\s*=\s*(\d+)", q).group(1))
            rows, todo, seen = [{"source": None, "target": {"id": root}}], [root], {root}
            while todo:
                cur = todo.pop()
                for k in _children(items, cur):
                    if k not in seen:
                        seen.add(k)
                        todo.append(k)
                        rows.append({"source": {"id": cur}, "target": {"id": k}})
            return {"workItemRelations": rows}
        proj = re.search(r"\[System\.TeamProject\]\s*=\s*'([^']*)'", q)
        ids = [int(k) for k, v in items.items()
               if not proj or (v.get("fields") or {}).get("System.TeamProject") == proj.group(1)]
        return {"workItems": [{"id": i} for i in sorted(ids)]}

    m = re.search(r"/_apis/wit/workitems/(\d+)$", path, re.I)
    if method == "PATCH" and m:
        wid = m.group(1)
        w = items.get(wid) or {}
        if not w:
            raise RuntimeError(f"ADO PATCH {url} -> HTTP 404: work item {wid} does not exist")
        test = next((o for o in body if o["op"] == "test" and o["path"] == "/rev"), None)
        if test and test["value"] != w.get("rev", 1):
            raise RuntimeError(f"ADO PATCH {url} -> HTTP 412: rev {test['value']} is not {w.get('rev', 1)}")
        _apply(w, body)
        w["rev"] = w.get("rev", 1) + 1
        writes.append({"method": "PATCH", "id": int(wid), "ops": body})
        _save(p, world)
        return {"id": int(wid), "rev": w["rev"]}

    m = re.search(r"/([^/]+)/_apis/wit/workitems/\$([^/]+)$", path, re.I)
    if method == "POST" and m:
        wid = max([int(k) for k in items] + [0]) + 1
        w = {"rev": 1, "fields": {"System.WorkItemType": urllib.parse.unquote(m.group(2)),
                                  "System.TeamProject": urllib.parse.unquote(m.group(1)), "System.State": "New"}}
        _apply(w, body)
        items[str(wid)] = w
        writes.append({"method": "CREATE", "id": wid, "ops": body})
        _save(p, world)
        return {"id": wid, "rev": 1, "fields": w["fields"]}

    m = re.search(r"/_apis/wit/workItems/(\d+)/comments$", path, re.I)
    if method == "POST" and m:
        writes.append({"method": "COMMENT", "id": int(m.group(1)), "text": body["text"]})
        _save(p, world)
        return {"id": len(writes)}
    if method == "GET" and m:
        wid = int(m.group(1))
        posted = [{"text": x["text"], "createdBy": {"displayName": "sdd"}} for x in writes
                  if x.get("method") == "COMMENT" and x.get("id") == wid]
        return {"comments": list((items.get(str(wid)) or {}).get("comments") or []) + posted}

    if path.endswith("/teamsettings/iterations"):
        cur = world.get("currentIteration")
        return {"value": [{"path": cur}] if cur else []}
    if "/classificationnodes/" in path.lower():
        return world.get("iterations") or {}

    if path.endswith("/pullrequests") and method == "POST":
        prs = world.setdefault("pullRequests", [])
        pr = {"pullRequestId": 9000 + len(prs) + 1, "status": "active", "isDraft": body.get("isDraft", False),
              "title": body["title"], "description": body["description"], "sourceRefName": body["sourceRefName"],
              "targetRefName": body["targetRefName"], "workItemRefs": body.get("workItemRefs", []),
              "reviewers": [], "mergeStatus": "succeeded"}
        prs.append(pr)
        writes.append({"method": "PR", "pullRequestId": pr["pullRequestId"], "title": pr["title"],
                       "description": pr["description"]})
        _save(p, world)
        return pr
    m = re.search(r"/pullrequests/(\d+)$", path)
    if method == "GET" and m:
        pr = next((x for x in world.get("pullRequests", []) if x["pullRequestId"] == int(m.group(1))), None)
        if pr:
            return pr

    raise RuntimeError(f"fake ADO ({ENV}): no answer for {method} {url}")
