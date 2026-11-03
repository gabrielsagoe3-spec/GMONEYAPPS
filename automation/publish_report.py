#!/usr/bin/env python3
"""Publish public job research with a narrowly scoped worker credential.

The credential can invoke only the dedicated report RPC; it is not a Supabase
administrator key. Never print request headers or server response bodies.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_REPORT_BYTES = 2 * 1024 * 1024


class PublishError(Exception):
    """A safe-to-display publication failure."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never forward the scoped credential to a redirected destination."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def public_config(path: Path) -> dict:
    try:
        source = path.read_text(encoding="utf-8")
        match = re.search(r"window\.GMONEY_DB\s*=\s*(\{.*?\})\s*;", source, re.S)
        if not match:
            raise ValueError
        config = json.loads(match.group(1))
        return {"url": config["url"], "publishableKey": config["publishableKey"]}
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise PublishError("Could not read the browser-safe Supabase configuration.") from exc


def read_report(path: Path) -> dict:
    try:
        if path.stat().st_size > MAX_REPORT_BYTES:
            raise PublishError("Report exceeds the 2 MiB publication limit.")
        report = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(report, dict):
            raise ValueError
        if report.get("automation", {}).get("status") not in ("completed", "partial"):
            raise PublishError("Only completed or partially completed research runs can be published.")
        return report
    except (OSError, ValueError, AttributeError, TypeError) as exc:
        raise PublishError("Could not read a valid research report.") from exc


def publish(report: dict, *, url: str, publishable_key: str, research_key: str,
            timeout: int = 30, opener=None) -> dict:
    """Publish once. A repeated identical run ID is idempotent on the server."""
    try:
        parsed = urllib.parse.urlsplit(url)
        parsed.port  # Validate malformed port syntax before building a request.
    except (ValueError, TypeError) as exc:
        raise PublishError("Supabase URL must be an HTTPS origin.") from exc
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or
            parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise PublishError("Supabase URL must be an HTTPS origin.")
    if not publishable_key or not research_key:
        raise PublishError("A publishable key and GMONEY_RESEARCH_KEY are required.")
    payload = json.dumps({"report": report}, ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_REPORT_BYTES:
        raise PublishError("Report exceeds the 2 MiB publication limit.")
    request = urllib.request.Request(
        url.rstrip("/") + "/rest/v1/rpc/publish_automated_research",
        data=payload, method="POST", headers={
            "apikey": publishable_key,
            "Content-Type": "application/json",
            "x-gmoney-research-key": research_key,
        },
    )
    try:
        send = opener or urllib.request.build_opener(NoRedirect()).open
        with send(request, timeout=timeout) as response:
            result = json.load(response)
    except urllib.error.HTTPError as exc:
        # Database error text can contain request details; never log response bodies.
        if 300 <= exc.code < 400:
            raise PublishError("Publication redirect was blocked. Verify the configured Supabase origin.") from exc
        if exc.code in (401, 403):
            raise PublishError("Publication was denied. Check the scoped worker credential.") from exc
        if exc.code >= 500:
            raise PublishError(f"Publication could not be confirmed (HTTP {exc.code}). Retry this same report safely before creating another run.") from exc
        raise PublishError(f"Publication failed with HTTP {exc.code}; the previous report remains available.") from exc
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise PublishError("Publication could not be confirmed. Retry this same report safely before creating another run.") from exc
    if (not isinstance(result, dict) or not isinstance(result.get("published"), bool) or
            result.get("runId") != report.get("automation", {}).get("runId")):
        raise PublishError("Unexpected publication response; publication could not be confirmed.")
    return {"published": result["published"], "runId": result["runId"]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--config", type=Path,
                        default=Path(__file__).resolve().parents[1] / "assets" / "config.js")
    args = parser.parse_args(argv)
    try:
        report = read_report(args.report)
        config = public_config(args.config)
        key = os.environ.get("GMONEY_RESEARCH_KEY", "")
        result = publish(report,
                         url=os.environ.get("GMONEY_SUPABASE_URL", config["url"]),
                         publishable_key=os.environ.get("GMONEY_SUPABASE_PUBLISHABLE_KEY", config["publishableKey"]),
                         research_key=key)
        print(json.dumps(result))
        return 0
    except PublishError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
