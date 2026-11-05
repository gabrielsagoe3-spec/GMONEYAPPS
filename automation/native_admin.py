#!/usr/bin/env python3
"""Manage the native worker using an injected Supabase Management API token.

Never prints credentials, private documents, request headers or response bodies.
Scheduled jobs use independent scoped credentials and do not need this token.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.error
import urllib.request
import uuid
from publish_report import public_config

ROOT = Path(__file__).resolve().parents[1]
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['deploy','sync-config','trigger','status','enable-schedule','disable-schedule'])
    args = parser.parse_args()
    token = os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        parser.error('SUPABASE_ACCESS_TOKEN must be available through secure environment settings.')
    config = public_config(ROOT/'assets/config.js')
    from urllib.parse import urlsplit
    hostname = urlsplit(config['url']).hostname or ''
    if not re.fullmatch(r'[a-z]{20}\.supabase\.co', hostname):
        parser.error('Expected the existing hosted Supabase project URL.')
    base = 'https://api.supabase.com/v1/projects/' + hostname.split('.')[0]
    opener = urllib.request.build_opener(NoRedirect())
    def api(path, payload=None, data=None, content_type='application/json'):
        if data is None and payload is not None:
            data=json.dumps(payload).encode()
        request=urllib.request.Request(base+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':content_type})
        try:
            with opener.open(request,timeout=100) as response:
                raw=response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raise RuntimeError('Management request failed with HTTP '+str(error.code)+'.') from None
        except (urllib.error.URLError,ValueError,TimeoutError):
            raise RuntimeError('Management request could not be confirmed.') from None
    def sql(query):
        return api('/database/query', {'query':query})
    try:
        if args.action=='deploy':
            source=(ROOT/'supabase/functions/gmoney-research/index.ts').read_bytes()
            boundary='gmoney-'+uuid.uuid4().hex
            metadata=json.dumps({'entrypoint_path':'index.ts','verify_jwt':False,'name':'G Money research'})
            body=(f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n{metadata}\r\n--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="index.ts"\r\nContent-Type: application/typescript\r\n\r\n'.encode()+source+f'\r\n--{boundary}--\r\n'.encode())
            result=api('/functions/deploy?slug=gmoney-research',data=body,content_type='multipart/form-data; boundary='+boundary)
            print(json.dumps({k:result.get(k) for k in ['slug','status','version']}))
        elif args.action=='sync-config':
            research=json.loads((ROOT/'automation/config.json').read_text())
            if not isinstance(research.get('sources'),list) or not 1<=len(research['sources'])<=6:
                raise RuntimeError('The hosted worker supports between one and six employer feeds per run.')
            api('/secrets',[{'name':'GMONEY_RESEARCH_CONFIG','value':json.dumps(research)}])
            print('Confirmed search configuration saved to the hosted worker.')
        elif args.action=='trigger':
            print(json.dumps(sql("select private.gmoney_trigger_research('manual') as request_id")))
        elif args.action=='status':
            query="select jsonb_build_object('schedule',(select to_jsonb(s) from public.research_automation_status s where slug='current'),'latest_run',(select jsonb_build_object('request_id',id,'http',status_code,'timed_out',timed_out) from net._http_response order by id desc limit 1),'cron_jobs',(select coalesce(jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active)),'[]'::jsonb) from cron.job where jobname='gmoney-job-research')) as status"
            print(json.dumps(sql(query)))
        elif args.action=='enable-schedule':
            print(json.dumps(sql("select cron.schedule('gmoney-job-research','17 */6 * * *',$$select private.gmoney_trigger_research('scheduled');$$) as job_id; update public.research_automation_status set schedule_enabled=true,schedule_expression='17 */6 * * *',backend='supabase',updated_at=now() where slug='current'; select schedule_enabled from public.research_automation_status where slug='current'")))
        else:
            sql("update cron.job set active=false where jobname='gmoney-job-research'; update public.research_automation_status set schedule_enabled=false,updated_at=now() where slug='current'")
            print('Recurring research disabled.')
        return 0
    except (RuntimeError,OSError,ValueError) as error:
        print(str(error),file=sys.stderr)
        return 1

if __name__=='__main__':
    raise SystemExit(main())
