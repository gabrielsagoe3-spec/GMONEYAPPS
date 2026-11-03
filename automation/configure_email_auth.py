#!/usr/bin/env python3
"""Configure and read-back-check Supabase email authentication.

Default email-link mode works with the free provider. Code templates require custom SMTP.
Uses official *_content fields and never sends email or prints credentials.
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
from publish_report import public_config

SITE = 'https://gabrielsagoe3-spec.github.io/GMONEYAPPS/'
TEMPLATE = '''<h2>Your G Money sign-in code</h2>
<p>Enter this code in the G Money Your profile tab:</p>
<p style="font-size:28px;letter-spacing:4px;font-weight:bold">{{ .Token }}</p>
<p>Use the most recent code. If you did not request it, ignore this email.</p>'''
FIELDS = ('mailer_templates_magic_link_content', 'mailer_templates_confirmation_content')
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def check(config, mode):
    return {
        'email_templates': all(('ConfirmationURL' in (config.get(k) or '')) if mode == 'link' else ('{{ .Token }}' in (config.get(k) or '') and 'ConfirmationURL' not in (config.get(k) or '')) for k in FIELDS),
        'site_url': config.get('site_url') == SITE,
        'redirect_allowed': SITE in [x.strip() for x in (config.get('uri_allow_list') or '').split(',')],
        'email_enabled': config.get('external_email_enabled') is True,
        'email_confirmation_required': config.get('mailer_autoconfirm') is False,
    }

def desired_settings(config, mode):
    allowed=[x.strip() for x in (config.get('uri_allow_list') or '').split(',') if x.strip()]
    if SITE not in allowed:allowed.append(SITE)
    desired={'site_url':SITE,'uri_allow_list':','.join(allowed)}
    if mode=='code':
        if not config.get('smtp_host'):
            raise ValueError('Code templates require custom SMTP on this project; use link mode with the default provider.')
        desired.update({**{k:TEMPLATE for k in FIELDS},'mailer_subjects_magic_link':'Your G Money sign-in code','mailer_subjects_confirmation':'Your G Money sign-in code'})
    return {k:v for k,v in desired.items() if config.get(k)!=v}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply',action='store_true',help='Apply supported settings and verify saved values.')
    parser.add_argument('--mode',choices=['link','code'],default='link')
    args=parser.parse_args()
    token=os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:parser.error('SUPABASE_ACCESS_TOKEN is required through secure environment settings.')
    public=public_config(Path(__file__).resolve().parents[1]/'assets/config.js')
    host=urlsplit(public['url']).hostname or ''
    if not re.fullmatch(r'[a-z]{20}\.supabase\.co',host):parser.error('Unexpected hosted project URL.')
    url='https://api.supabase.com/v1/projects/'+host.split('.')[0]+'/config/auth'
    opener=urllib.request.build_opener(NoRedirect())
    def request(payload=None):
        req=urllib.request.Request(url,data=None if payload is None else json.dumps(payload).encode(),method='GET' if payload is None else 'PATCH',headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with opener.open(req,timeout=30) as response:return json.load(response)
    try:
        config=request()
        if args.apply:
            changes=desired_settings(config,args.mode)
            if changes:request(changes)
            config=request()  # Persistence is verified; PATCH success alone is insufficient.
        checks=check(config,args.mode)
        print(json.dumps({'mode':args.mode,'checks':checks,'custom_smtp_configured':bool(config.get('smtp_host')),'email_sent':False}))
        return 0 if all(checks.values()) else 1
    except urllib.error.HTTPError as error:
        print('Email configuration request failed with HTTP '+str(error.code)+'.',file=sys.stderr)
        return 1
    except ValueError as error:
        print(str(error),file=sys.stderr)
        return 1
    except (urllib.error.URLError,OSError,TimeoutError):
        print('Email configuration could not be confirmed.',file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
