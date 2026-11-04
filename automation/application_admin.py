#!/usr/bin/env python3
"""Inspect the private application backend and manage its nightly-report cron.

Uses the configured Management API credential without printing candidate data,
connector tokens, lease tokens, headers or response bodies. Windows executes
applications; this administrative helper never submits an employer form.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from native_admin import NoRedirect
from publish_report import public_config

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "enable-reports", "disable-reports", "build-reports"])
    args = parser.parse_args()
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        parser.error("SUPABASE_ACCESS_TOKEN must be available through secure environment settings.")
    hostname = urlsplit(public_config(ROOT / "assets/config.js")["url"]).hostname or ""
    if not re.fullmatch(r"[a-z]{20}\.supabase\.co", hostname):
        parser.error("Expected the existing hosted Supabase project URL.")
    endpoint = "https://api.supabase.com/v1/projects/" + hostname.split(".")[0] + "/database/query"
    opener = urllib.request.build_opener(NoRedirect())

    def sql(query):
        request = urllib.request.Request(endpoint, data=json.dumps({"query": query}).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with opener.open(request, timeout=45) as response:
            return json.load(response)

    try:
        installed = sql("select to_regprocedure('public.get_application_workspace()') is not null as installed")[0]["installed"]
        if not installed:
            print(json.dumps({"installed": False}))
            return 0 if args.action == "status" else 1
        if args.action == "enable-reports":
            result = sql("select cron.schedule('gmoney-nightly-applications','* * * * *',"
                "$$select private.gmoney_build_due_application_reports();$$) as job_id")
        elif args.action == "disable-reports":
            result = sql("update cron.job set active=false where jobname='gmoney-nightly-applications'; "
                "select false as schedule_enabled")
        elif args.action == "build-reports":
            result = sql("select private.gmoney_build_due_application_reports() as generated")
        else:
            result = sql("""select jsonb_build_object(
              'installed',true,
              'schedule',(select coalesce(jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active)),'[]')
                from cron.job where jobname='gmoney-nightly-applications'),
              'enabled_report_owners',(select count(*) from private.gmoney_application_report_preferences where enabled),
              'active_connectors',(select count(*) from private.gmoney_application_connectors where revoked_at is null and expires_at>now()),
              'recent_workers',(select count(*) from private.gmoney_application_connectors where revoked_at is null and expires_at>now() and last_seen_at>now()-interval '10 minutes'),
              'jobs',(select coalesce(jsonb_object_agg(status,n),'{}') from (select status,count(*) n from private.gmoney_application_jobs group by status) counts),
              'reports',(select count(*) from private.gmoney_application_reports)
            ) as status""")
        print(json.dumps(result))
        return 0
    except urllib.error.HTTPError as error:
        print("Management request failed with HTTP " + str(error.code) + ".", file=sys.stderr)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TimeoutError):
        print("Application backend operation could not be confirmed.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
