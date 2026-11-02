#!/usr/bin/env python3
"""Read public employer feeds and produce a reviewable job-research report.

This worker has no application submission or privileged publishing capability.
Matching is transparent, deterministic screening against public search criteria;
it is not a résumé assessment or a guarantee of employment eligibility.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
import uuid

MAX_RESPONSE_BYTES = 25 * 1024 * 1024
MAX_DESCRIPTION_CHARS = 100_000
HTTP_TIMEOUT = 20
PROVIDERS = {"greenhouse", "lever"}


class SourceError(Exception):
    """A feed could not be read or did not have the expected schema."""


class AllSourcesFailed(Exception):
    def __init__(self, automation: dict[str, Any]):
        super().__init__("No employer feed could be read; previous report was preserved.")
        self.automation = automation


class SourceCoverageError(Exception):
    def __init__(self, automation: dict[str, Any]):
        super().__init__("Employer source coverage was incomplete and no findings were selected; previous report was preserved.")
        self.automation = automation


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.hidden = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in {"script", "style"}:
            self.hidden += 1
        elif tag in {"p", "li", "div", "br", "h1", "h2", "h3", "h4"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        elif tag in {"p", "li", "div"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.hidden:
            self.parts.append(data)


def plain_text(value: Any) -> str:
    raw = str(value or "")[:MAX_DESCRIPTION_CHARS]
    # Greenhouse commonly returns entity-encoded HTML inside JSON content.
    for _ in range(2):
        decoded = unescape(raw)
        if decoded == raw:
            break
        raw = decoded
    parser = _Text()
    parser.feed(raw)
    return "\n".join(" ".join(line.split()) for line in "".join(parser.parts).splitlines() if line.strip())


def safe_url(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        url = urlsplit(value)
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            return None
        if url.port not in {None, 443}:
            return None
        # Retain identity parameters (such as gh_jid) and remove tracking only.
        query = [(k, v) for k, v in parse_qsl(url.query, keep_blank_values=True)
                 if not k.lower().startswith("utm_") and k.lower() not in {"source", "ref", "referrer", "lever-source"}]
        return urlunsplit(("https", url.netloc, url.path, urlencode(query), ""))
    except ValueError:
        return None


def source_url(source: dict[str, Any]) -> str:
    board = source["board"]
    if source["provider"] == "greenhouse":
        return f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs?content=true"
    return f"https://api.lever.co/v0/postings/{board}?mode=json"


def validate_config(config: Any) -> dict[str, Any]:
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError("Config must be a version 1 object.")
    criteria = config.get("criteria")
    if not isinstance(criteria, dict) or criteria.get("country") != "US":
        raise ValueError("This worker currently supports U.S. search criteria only.")
    roles = criteria.get("role_patterns")
    if not isinstance(roles, list) or not roles or any(not isinstance(r, str) or not r.strip() for r in roles):
        raise ValueError("criteria.role_patterns must contain nonempty title phrases.")
    if not isinstance(criteria.get("preferred_locations", []), list) or any(not isinstance(v, str) for v in criteria.get("preferred_locations", [])):
        raise ValueError("preferred_locations must be a list of names.")
    for name in ("entry_level", "sponsorship_required"):
        if not isinstance(criteria.get(name), bool):
            raise ValueError(f"criteria.{name} must be a boolean.")
    for name, default in (("max_records", 30), ("max_excluded", 5)):
        value = config.get(name, default)
        if type(value) is not int or value < 0 or value > 200 or (name == "max_records" and value < 1):
            raise ValueError(f"{name} must be a bounded nonnegative integer.")
    sources = config.get("sources")
    if not isinstance(sources, list) or not sources or len(sources) > 20:
        raise ValueError("Configure between 1 and 20 employer sources.")
    identities: set[tuple[str, str]] = set()
    for source in sources:
        if not isinstance(source, dict) or source.get("provider") not in PROVIDERS:
            raise ValueError("Each source must use greenhouse or lever.")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", str(source.get("board", ""))):
            raise ValueError("Each source must identify an employer board slug.")
        if not isinstance(source.get("name"), str) or not source["name"].strip():
            raise ValueError("Each source must have an employer name.")
        identity = (source["provider"], source["board"])
        if identity in identities:
            raise ValueError("Duplicate employer sources are not allowed.")
        identities.add(identity)
    return config


def fetch_json(url: str) -> Any:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "GMoneyResearch/1.0 (public employer listings)"})
    try:
        # Inherits HTTPS_PROXY and the environment's verified CA trust.
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise SourceError("Feed exceeds the response size limit.")
        return json.loads(payload)
    except HTTPError as error:
        raise SourceError(f"HTTP {error.code}") from error
    except URLError as error:
        raise SourceError(f"Network request failed ({type(error.reason).__name__}).") from error
    except (TimeoutError, OSError) as error:
        raise SourceError(f"Network request failed ({type(error).__name__}).") from error
    except (ValueError, UnicodeDecodeError) as error:
        raise SourceError("Feed did not contain valid JSON.") from error


def parse_feed(source: dict[str, Any], data: Any) -> tuple[list[dict[str, Any]], int]:
    provider = source["provider"]
    if provider == "greenhouse":
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list):
            raise SourceError("Unexpected Greenhouse feed schema.")
        rows = data["jobs"]
    else:
        if not isinstance(data, list):
            raise SourceError("Unexpected Lever feed schema.")
        rows = data
    if len(rows) > 10_000:
        raise SourceError("Feed exceeds the job count limit.")
    jobs, invalid = [], 0
    for row in rows:
        if not isinstance(row, dict):
            invalid += 1
            continue
        identifier = row.get("id")
        title = row.get("title") if provider == "greenhouse" else row.get("text")
        url = safe_url(row.get("absolute_url") if provider == "greenhouse" else row.get("hostedUrl"))
        if not isinstance(identifier, (str, int)) or not str(identifier) or not isinstance(title, str) or not title.strip() or not url:
            invalid += 1
            continue
        if provider == "greenhouse":
            location_data = row.get("location")
            location = location_data.get("name", "") if isinstance(location_data, dict) else ""
            description = plain_text(row.get("content", ""))
            commitment = ""
            country = row.get("country", "")
        else:
            categories = row.get("categories") if isinstance(row.get("categories"), dict) else {}
            location = categories.get("location", "")
            commitment = categories.get("commitment", "")
            lists = row.get("lists") if isinstance(row.get("lists"), list) else []
            fragments = [row.get("descriptionPlain") or row.get("description", "")]
            for item in lists:
                if isinstance(item, dict):
                    fragments.extend([item.get("text", ""), item.get("content", "")])
            fragments.append(row.get("additionalPlain") or row.get("additional", ""))
            description = plain_text("\n".join(str(part or "") for part in fragments))
            country = row.get("country", "")
        jobs.append({
            "id": f"{provider}-{source['board']}-{identifier}",
            "company": source["name"], "title": plain_text(title),
            "location": plain_text(location) or "Not specified by employer feed",
            "country": country if isinstance(country, str) else "",
            "commitment": plain_text(commitment), "description": description,
            "url": url, "provider": provider, "sourceId": f"{provider}:{source['board']}",
        })
    # A changed/malformed schema must not silently turn a populated feed into an empty success.
    if rows and not jobs:
        raise SourceError("No usable job records found in populated feed.")
    return jobs, invalid


NEGATIVE_SPONSORSHIP = [
    r"\b(?:no|without)\s+(?:(?:current|future|or|and|employment|work|visa|immigration)\s+){0,5}sponsorship\b",
    r"\b(?:do|does|will|can)\s+not\s+(?:currently\s+)?(?:provide|offer|support|sponsor)\b[^\n.;]{0,100}\b(?:visa|sponsorship|work authorization)\b",
    r"\b(?:cannot|can't|unable to|not able to)\s+(?:(?:provide|offer)\s+)?(?:visa\s+|work\s+|immigration\s+)?sponsor(?:ship)?\b",
    r"\b(?:visa|immigration|employment|work)\s+sponsorship\s*(?::\s*no\b|(?:is|will be)\s+not\s+(?:available|offered|provided|supported))",
    r"\b(?:must|should)\s+not\s+require\b[^\n.;]{0,80}\bsponsorship\b",
    r"\bnot\s+(?:eligible|available)\s+for\s+(?:visa\s+)?sponsorship\b",
    r"\bwithout\s+(?:the\s+)?(?:need\s+for|requiring)\s+(?:(?:current|future|or|and|visa|work)\s+){0,5}sponsorship\b",
]
POSITIVE_SPONSORSHIP = [
    r"\b(?:visa|immigration|employment|work)\s+sponsorship\s+(?:(?:may|can|will)\s+be\s+|is\s+)?(?:available|offered|provided|supported)\b",
    r"\b(?:provide|offer|support)\s+(?:employment\s+|work\s+|immigration\s+|visa\s+){1,3}sponsorship\b",
    r"\b(?:we|company)\s+(?:will\s+|can\s+|may\s+)?sponsor\s+(?:work\s+|employment\s+)?visas?\b",
    r"\bvisa\s+sponsorship\s*:\s*yes\b",
]


def sponsorship_evidence(description: str) -> dict[str, Any]:
    negative, positive = [], []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", description):
        text = sentence.strip()
        if not text:
            continue
        is_negative = any(re.search(pattern, text, re.I) for pattern in NEGATIVE_SPONSORSHIP)
        # Reject a positive substring governed by a nearby negation, while
        # preserving genuinely conflicting clauses in the same sentence.
        is_positive = False
        for pattern in POSITIVE_SPONSORSHIP:
            for match in re.finditer(pattern, text, re.I):
                prefix = text[max(0, match.start() - 60):match.start()]
                negated = re.search(r"\b(?:not|no|cannot|can't|unable to|without)(?:\s+(?:currently|now|ever|able to|employment|work|immigration|visa)){0,5}\s*$", prefix, re.I)
                if not negated:
                    is_positive = True
        if is_negative:
            negative.append(text[:600])
        if is_positive:
            positive.append(text[:600])
    if negative and positive:
        return {"status": "unknown", "label": "Conflicting sponsorship statements; role-specific confirmation required", "quotes": (negative[:1] + positive[:1])}
    if negative:
        return {"status": "not_offered", "label": "Employer text states sponsorship is unavailable", "quotes": negative[:2]}
    if positive:
        return {"status": "mentioned", "label": "Sponsorship mentioned; H-1B eligibility is not confirmed", "quotes": positive[:2]}
    return {"status": "unknown", "label": "Sponsorship not established by this posting", "quotes": []}


US_CITIES = re.compile(r"\b(?:Houston|Austin|Dallas|San Francisco|New York|Boston|Chicago|Seattle|Denver|Atlanta|Los Angeles|San Diego|Phoenix|Miami|Washington|Palo Alto|Mountain View|Menlo Park|Salt Lake City|Charlotte|San Jose|Bellevue|Sunnyvale|Orlando|Tampa|Philadelphia|Nashville|Columbus|Raleigh|Pittsburgh)\b", re.I)
US_STATES = r"AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY"
NON_US = re.compile(r"\b(?:United Kingdom|UK|Canada|Germany|France|India|Ireland|Australia|Japan|Singapore|Brazil|Mexico|Poland|Netherlands|Spain|Italy|Israel|London|Toronto|Vancouver|Berlin|Paris|Dublin|Bengaluru|Bangalore|Hyderabad|Mumbai|Sydney|Melbourne|Tokyo|Warsaw|Amsterdam|Madrid|Tel Aviv)\b", re.I)


def geography(job: dict[str, Any]) -> str:
    country = job.get("country", "").strip().upper()
    if country in {"US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"}:
        return "us"
    if country and (re.fullmatch(r"[A-Z]{2,3}", country) or NON_US.search(country)):
        return "outside_us"
    location = job["location"]
    explicit_us = re.search(r"\bUnited States\b|\bU\.S\.(?:A\.)?|\bUSA?\b", location) or re.search(r",\s*(?:" + US_STATES + r")\b", location)
    if explicit_us:
        return "us"
    if NON_US.search(location):
        if US_CITIES.search(location) and re.search(r"\s[/;|]\s", location):
            return "unknown"  # Mixed-country locations need role-specific verification.
        return "outside_us"
    if US_CITIES.search(location):
        return "us"
    return "unknown"


def screen_job(job: dict[str, Any], criteria: dict[str, Any], checked_at: str) -> dict[str, Any] | None:
    title = job["title"]
    title_lower = title.casefold()
    matched = [phrase for phrase in criteria["role_patterns"] if phrase.casefold() in title_lower]
    if not matched:
        return None
    score, exclusions, reasons = 30, [], []
    reasons.append(f"Title matches the configured '{matched[0]}' role family.")
    senior = re.search(r"\b(?:senior|sr\.?|staff|principal|lead|manager|director|head|vice president|vp|chief)\b", title, re.I)
    if criteria["entry_level"] and senior:
        exclusions.append(f"The title signals a {senior.group(0)} position rather than an entry-level opening.")
    if re.search(r"\bintern(?:ship)?\b", title + " " + job["commitment"], re.I):
        exclusions.append("The posting is an internship; the configured search is for full-time work.")
    required_years = None
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", job["description"]):
        if re.search(r"\b(?:preferred|not required|does not require|do not require)\b", sentence, re.I):
            continue
        required_years = re.search(r"\b(?:at least|minimum(?: of)?|requires?|must have)\s+(\d{1,2})\+?\s+years?\b", sentence, re.I)
        if required_years:
            break
    if criteria["entry_level"] and required_years and int(required_years.group(1)) > 2:
        exclusions.append(f"The posting explicitly requires at least {required_years.group(1)} years of experience.")
    geo = geography(job)
    if geo == "outside_us":
        exclusions.append("The employer feed lists a location outside the configured U.S. search.")
    elif geo == "us":
        reasons.append("The feed identifies a U.S. location; exact work-location eligibility still needs review.")
        score += 20
    else:
        reasons.append("U.S. work-location eligibility is not established; remote does not automatically mean U.S.-eligible.")
    preferred = [place for place in criteria.get("preferred_locations", []) if place.casefold() in job["location"].casefold()]
    if preferred:
        reasons.append(f"Location includes the preferred area: {preferred[0]}.")
        score += 20
    if re.search(r"\b(?:entry.level|new grad(?:uate)?|junior|early career|associate|analyst i)\b", title, re.I):
        reasons.append("The title contains an early-career signal; qualifications still need review.")
        score += 10
    sponsorship = sponsorship_evidence(job["description"])
    if criteria["sponsorship_required"] and sponsorship["status"] == "not_offered":
        exclusions.append("The posting's no-sponsorship statement conflicts with the configured sponsorship requirement.")
    elif sponsorship["status"] == "mentioned":
        score += 5
    category = "excluded" if exclusions else "verify"
    finding = "Listed in the employer's public job feed at retrieval time. "
    finding += " ".join(exclusions) if exclusions else "This is a research lead, not a verified application-ready match."
    fit = " ".join(reasons) + " No candidate résumé was evaluated. Compensation, qualifications, and the requested start window are unverified."
    evidence = sponsorship["label"]
    if sponsorship["quotes"]:
        evidence += ' Employer text: ' + ' | '.join('“' + quote + '”' for quote in sponsorship["quotes"])
    return {
        "id": job["id"], "company": job["company"], "title": title,
        "location": job["location"], "decision": "Ruled out" if exclusions else "Verify first",
        "category": category, "sponsorship": evidence,
        "sponsorshipStatus": sponsorship["status"], "sponsorshipEvidence": sponsorship["quotes"],
        "finding": finding, "fit": fit,
        "next": ("Do not apply under the current criteria. Review the stated exclusion before reconsidering."
                 if exclusions else "Review the full employer posting and confirm sponsorship, required experience, pay, and the requested start window before preparing an application."),
        "url": job["url"], "checkedAt": checked_at[:10], "retrievedAt": checked_at,
        "sourceType": "employer_feed", "sourceId": job["sourceId"],
        "matchScore": 0 if exclusions else score,
        "matchReasons": reasons, "exclusionReasons": exclusions,
        "verificationRequired": True,
    }


def _read_source(source: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    meta = {"id": f"{source['provider']}:{source['board']}", "name": source["name"], "provider": source["provider"], "url": source_url(source), "status": "ok", "fetched": 0, "invalid": 0}
    try:
        jobs, invalid = parse_feed(source, fetch_json(meta["url"]))
        meta.update(fetched=len(jobs), invalid=invalid)
        return jobs, meta
    except SourceError as error:
        meta.update(status="failed", error=str(error))
        return [], meta


def run_research(config: dict[str, Any], *, trigger: str = "manual", previous: dict[str, Any] | None = None) -> dict[str, Any]:
    validate_config(config)
    if previous is not None and (not isinstance(previous, dict) or not isinstance(previous.get("records"), list)):
        raise ValueError("Previous report must contain a records array.")
    started = datetime.now(timezone.utc).isoformat()
    automation: dict[str, Any] = {"runId": str(uuid.uuid4()), "status": "completed", "startedAt": started, "finishedAt": None, "execution": "one_shot", "trigger": trigger, "sources": [], "stats": {"fetched": 0, "relevant": 0, "selected": 0, "duplicates": 0, "new": 0}}
    jobs: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=min(4, len(config["sources"]))) as pool:
        for source_jobs, meta in pool.map(_read_source, config["sources"]):
            jobs.extend(source_jobs)
            automation["sources"].append(meta)
    automation["stats"]["fetched"] = len(jobs)
    successes = sum(source["status"] == "ok" for source in automation["sources"])
    if not successes:
        automation.update(status="failed", finishedAt=datetime.now(timezone.utc).isoformat())
        raise AllSourcesFailed(automation)
    if successes != len(automation["sources"]):
        automation["status"] = "partial"
    selected = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    for job in jobs:
        if job["id"] in seen_ids or job["url"] in seen_urls:
            automation["stats"]["duplicates"] += 1
            continue
        seen_ids.add(job["id"])
        seen_urls.add(job["url"])
        record = screen_job(job, config["criteria"], started)
        if record:
            selected.append(record)
    automation["stats"]["relevant"] = len(selected)
    selected.sort(key=lambda r: (r["category"] != "verify", -r["matchScore"], r["company"], r["id"]))
    excluded_seen = 0
    records = []
    previous_ids = {r.get("id") for r in (previous or {}).get("records", []) if isinstance(r, dict)}
    for record in selected:
        if record["category"] == "excluded":
            excluded_seen += 1
            if excluded_seen > config.get("max_excluded", 5):
                continue
        record["isNew"] = record["id"] not in previous_ids
        records.append(record)
        if len(records) == config.get("max_records", 30):
            break
    automation["stats"].update(selected=len(records), new=sum(r["isNew"] for r in records))
    automation["finishedAt"] = datetime.now(timezone.utc).isoformat()
    if automation["status"] == "partial" and not records:
        # A failed source might contain every relevant opening. Do not turn
        # incomplete coverage into an apparently valid empty replacement.
        automation["status"] = "failed"
        raise SourceCoverageError(automation)
    verify = sum(r["category"] == "verify" for r in records)
    excluded = len(records) - verify
    partial = " Some employer feeds failed; this is a partial search." if automation["status"] == "partial" else ""
    return {
        "updatedAt": started[:10],
        "mode": "Automated employer-feed research; applications require review",
        "scope": ("Working search assumptions: " + str(config["criteria"].get("label", "configured title families")) + "; U.S. locations with " + (", ".join(config["criteria"].get("preferred_locations", [])) or "no specific city") + " preferred. " + ("Sponsorship required. " if config["criteria"]["sponsorship_required"] else "Sponsorship is recorded without being an exclusion. ") + str(config["criteria"].get("start_window", "Start window is not confirmed.")) + ". This run covers only the configured employer feeds, not LinkedIn or Indeed."),
        "summary": f"Automatically retrieved {len(jobs)} job records from {successes} of {len(config['sources'])} employer feeds. Selected {verify} leads for verification and {excluded} excluded examples; {automation['stats']['relevant']} title-relevant records were screened before display limits. No candidate résumé was evaluated and no applications were submitted." + partial,
        "records": records,
        "additionalSources": [{"title": source["name"] + " — public " + source["provider"] + " feed", "url": source["url"], "note": (f"Retrieved {source['fetched']} records in this run." if source["status"] == "ok" else "Could not retrieve this feed: " + source["error"])} for source in automation["sources"]],
        "automation": automation,
    }


def atomic_write(output: Path, report: dict[str, Any]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output.parent, prefix=".research-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.json"))
    parser.add_argument("--output", type=Path, default=Path(__file__).with_name("latest-report.json"))
    parser.add_argument("--previous", type=Path, help="Prior report JSON for cross-run newness comparisons; otherwise reuse the existing output file.")
    parser.add_argument("--once", action="store_true", help="Run once (the default); this command does not register a scheduler.")
    parser.add_argument("--trigger", choices=("manual", "scheduled"), default="manual", help="Record how the caller invoked this run; does not enable a schedule.")
    args = parser.parse_args(argv)
    try:
        config = validate_config(json.loads(args.config.read_text()))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.with_suffix(args.output.suffix + ".lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Another worker is already writing this report.")
            previous = None
            if args.previous is not None:
                previous = json.loads(args.previous.read_text())
            elif args.output.exists():
                try:
                    previous = json.loads(args.output.read_text())
                    if not isinstance(previous, dict) or not isinstance(previous.get("records"), list):
                        previous = None
                except (ValueError, OSError):
                    previous = None
            report = run_research(config, trigger=args.trigger, previous=previous)
            atomic_write(args.output, report)
        print(json.dumps({"runId": report["automation"]["runId"], "status": report["automation"]["status"], "stats": report["automation"]["stats"], "output": str(args.output)}))
        return 0
    except (AllSourcesFailed, SourceCoverageError) as error:
        print(json.dumps({"error": str(error), "automation": error.automation}), file=sys.stderr)
        return 1
    except (ValueError, OSError) as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
