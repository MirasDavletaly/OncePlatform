"""Smoke test against a disposable local portal (creates synthetic tasks).

TEST_PORTAL_URL=http://localhost:18080
TEST_PORTAL_USER / TEST_PORTAL_PASSWORD must name a test admin.
Requires only Python's standard library. Never point at a working portal.
"""
import csv
import http.cookiejar
import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid


base = os.environ.get("TEST_PORTAL_URL", "http://localhost:18080").rstrip("/")
assert urllib.parse.urlparse(base).hostname in ("localhost", "127.0.0.1"), "Local disposable portal only"
jar = http.cookiejar.CookieJar()
client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def request(path, data=None, method=None, expected=200, token=None):
    headers = {"Accept": "application/json, text/event-stream", "Origin": base}
    if data is not None:
        headers["Content-Type"] = "application/json"
    for cookie in jar:
        if cookie.name == "portal_csrf":
            headers["X-CSRF-Token"] = cookie.value
    if token:
        headers["Authorization"] = "Bearer " + token
        headers["MCP-Protocol-Version"] = "2025-03-26"
    req = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None,
                                 method=method, headers=headers)
    try:
        response = client.open(req, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    body = response.read().decode("utf-8-sig")
    assert response.status == expected, (path, response.status, body)
    return json.loads(body) if "application/json" in response.headers.get("Content-Type", "") else body


request("/api/v1/auth/csrf")
request("/api/v1/auth/login", {"username": os.environ["TEST_PORTAL_USER"], "password": os.environ["TEST_PORTAL_PASSWORD"]})
token_response = request("/api/v1/me/tokens", {"name": "shortlist smoke test", "expires_in_days": 1}, expected=201)
token = token_response["token"]
ids = []
sequence = 0


def rpc(method, params):
    global sequence
    sequence += 1
    result = request("/mcp", {"jsonrpc": "2.0", "id": sequence, "method": method, "params": params}, token=token)
    assert "error" not in result, result
    return result["result"]


def tool(name, arguments, error=False):
    result = rpc("tools/call", {"name": name, "arguments": arguments})
    assert bool(result.get("isError")) == error, result
    if error:
        return " ".join(item.get("text", "") for item in result.get("content", []))
    if "structuredContent" in result:
        return result["structuredContent"]
    return json.loads(result["content"][0]["text"])


try:
    rpc("initialize", {"protocolVersion": "2025-03-26", "clientInfo": {"name": "shortlist-test", "version": "1"}, "capabilities": {}})
    schema = {item["name"]: item["inputSchema"] for item in rpc("tools/list", {})["tools"]}
    assert "fit_score" in schema["create_ticket"]["properties"]
    assert "clear_fields" in schema["update_ticket"]["properties"]
    assert "loss_reason" in schema["change_ticket_status"]["properties"]
    source = "https://example.org/test/" + uuid.uuid4().hex
    ticket = tool("create_ticket", {"title": "MCP shortlist smoke", "source_url": source, "deadline": "2026-10-25",
        "fit_score": 5, "complexity": 2, "market": "KZ", "applications_count": 0,
        "budget_amount": "9007199254740992.01", "currency": "USD", "customer": "=Formula-safe customer"})["ticket"]
    ids.append(ticket["id"])
    assert ticket["fit_score"] == 5 and ticket["applications_count"] == 0
    assert ticket["budget_amount"] == "9007199254740992.01"
    duplicate = request("/api/v1/tickets", {"title": "Duplicate", "source_url": source.replace("example.org", "EXAMPLE.org:443")}, expected=409)
    assert duplicate["error"]["code"] == "duplicate_source_url"
    assert duplicate["error"]["details"]["ticket"]["id"] == ticket["id"]
    assert ticket["number"] in tool("create_ticket", {"title": "MCP duplicate", "source_url": source}, error=True)
    check = request("/api/v1/tickets/source-check?" + urllib.parse.urlencode({"source_url": source}))
    assert check["duplicate"]["id"] == ticket["id"]
    filters = {"fit_min": 4, "applications_max": 3, "source_url": source, "deadline_from": "2026-10-19", "deadline_to": "2026-10-25",
               "budget_min": "9007199254740992.01", "currency": "USD", "sort": "budget_amount"}
    query = urllib.parse.urlencode(filters)
    page = request("/api/v1/tickets?" + query)
    assert page["total"] == 1 and page["items"][0]["id"] == ticket["id"]
    assert tool("list_tickets", filters)["total"] == 1
    rows = list(csv.DictReader(io.StringIO(request("/api/v1/tickets/export.csv?" + query)), delimiter=";"))
    assert len(rows) == 1 and rows[0]["Fit"] == "5" and rows[0]["Applications"] == "0"
    assert rows[0]["Amount"] == "9007199254740992.01" and rows[0]["Currency"] == "USD"
    assert rows[0]["Customer"].startswith("'=Formula")
    for query in ["fit_min=wrong", "fit_min=6", "applications_max=-1", "budget_min=1", "sort=budget_amount"]:
        request("/api/v1/tickets?" + query, expected=422)
    request("/api/v1/tickets/" + ticket["id"], {"fit_score": 1.5}, method="PATCH", expected=400)
    updated = tool("update_ticket", {"ticket_id": ticket["id"], "clear_fields": ["fit_score", "budget_amount"], "applications_count": 3})["ticket"]
    assert updated["fit_score"] is None and updated["budget_amount"] is None and updated["complexity"] == 2
    updated = request("/api/v1/tickets/" + ticket["id"], {"applications_count": None, "fit_score": 4}, method="PATCH")
    assert updated["applications_count"] is None and updated["fit_score"] == 4
    request("/api/v1/tickets/" + ticket["id"], {"deadline": "2020-01-01"}, method="PATCH")
    tool("change_ticket_status", {"ticket_id": ticket["id"], "status": "sent"})
    assert tool("list_tickets", {"source_url": source, "overdue": True})["total"] == 0
    assert ticket["id"] not in [item["id"] for item in tool("get_overview", {})["overdue"]]
    error = tool("change_ticket_status", {"ticket_id": ticket["id"], "status": "closed", "result": "lost"}, error=True)
    assert "loss_reason_required" in error
    lost = tool("change_ticket_status", {"ticket_id": ticket["id"], "status": "closed", "result": "lost", "loss_reason": "requirements", "comment": "Customer confirmed missing certification"})["ticket"]
    assert lost["loss_reason"] == "requirements"
    assert tool("list_tickets", {"loss_reason": "requirements", "source_url": source})["total"] == 1
    assert tool("get_overview", {})["lost_by_reason"]["requirements"] >= 1
    history = tool("get_ticket", {"ticket_id": ticket["id"]})["status_history"]
    assert history[-1]["loss_reason"] == "requirements" and history[-1]["via"] == "mcp"
    print("PASS: HTTP + authenticated MCP create/update/filter/CSV/duplicate/null/lost/overdue scenarios")
finally:
    for ticket_id in ids:
        request("/api/v1/tickets/" + ticket_id, method="DELETE", expected=204)
    request("/api/v1/me/tokens/" + token_response["item"]["id"], method="DELETE", expected=204)
