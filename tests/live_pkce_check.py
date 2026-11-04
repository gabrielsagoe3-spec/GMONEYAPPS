#!/usr/bin/env python3
"""Explicit live protocol check with a synthetic user; never sends email.

Requires authorized Management API access. Seeds only isolated .invalid fixture
state, exercises the actual PKCE grant and private-profile APIs, and removes the
user, sessions, profile and flow state in finally. This does not test delivery.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sys
import uuid
import urllib.request
import urllib.error
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parents[1]

def main():
    token=os.environ.get('SUPABASE_ACCESS_TOKEN')
    if not token:
        print('Secure SUPABASE_ACCESS_TOKEN is required.',file=sys.stderr);return 1
    c=json.loads(re.search(r'window.GMONEY_DB = (.*);',(ROOT/'assets/config.js').read_text()).group(1))
    host=urlsplit(c['url']).hostname or ''
    if not re.fullmatch(r'[a-z]{20}\.supabase\.co',host):raise ValueError('Unexpected project URL')
    management='https://api.supabase.com/v1/projects/'+host.split('.')[0]+'/database/query'
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs):return None
    opener=urllib.request.build_opener(NoRedirect())
    def sql(query):
        req=urllib.request.Request(management,data=json.dumps({'query':query}).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
        with opener.open(req,timeout=30) as response:return json.load(response)
    def call(path,payload=None,access=None):
        headers={'apikey':c['publishableKey'],'Content-Type':'application/json'}
        if access:headers['Authorization']='Bearer '+access
        req=urllib.request.Request(c['url']+path,data=None if payload is None else json.dumps(payload).encode(),headers=headers)
        with opener.open(req,timeout=25) as response:
            raw=response.read();return json.loads(raw) if raw else None
    uid=str(uuid.uuid4());fid=str(uuid.uuid4());auth_code=str(uuid.uuid4())
    email='gmoney-auth-test-'+uid+'@example.invalid'
    verifier=base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    created=False
    stage="fixture"
    try:
        query="begin; insert into auth.users(instance_id,id,aud,role,email,encrypted_password,confirmation_token,recovery_token,email_change_token_new,email_change,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,is_super_admin,is_sso_user,is_anonymous) values ('00000000-0000-0000-0000-000000000000','"+uid+"','authenticated','authenticated','"+email+"','','','','','',now(),'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now(),false,false,false); insert into auth.flow_state(id,user_id,auth_code,code_challenge_method,code_challenge,provider_type,provider_access_token,provider_refresh_token,authentication_method,created_at,updated_at,auth_code_issued_at) values ('"+fid+"','"+uid+"','"+auth_code+"','s256','"+challenge+"','magiclink','','','magiclink',now(),now(),now()); commit;"
        sql(query);created=True
        stage='token_exchange'
        session=call('/auth/v1/token?grant_type=pkce',{'auth_code':auth_code,'code_verifier':verifier})
        assert session['user']['id']==uid and session['user']['email']==email
        access=session['access_token']
        stage='resume_import'
        assert call('/rest/v1/rpc/claim_candidate_profile',{},access)=={'imported':False}
        stage='profile_save'
        call('/rest/v1/agent_preferences',{'user_id':uid,'full_name':'Synthetic auth integration test','resume_text':'Synthetic test only'},access)
        stage='profile_read'
        assert call('/rest/v1/agent_preferences?select=full_name',access=access)==[{'full_name':'Synthetic auth integration test'}]
        stage='draft_list'
        assert call('/rest/v1/rpc/list_candidate_application_drafts',{},access)==[]
        assert sql("select count(*)::integer as remaining from auth.flow_state where id='"+fid+"'")[0]['remaining']==0
        stage='code_replay'
        try:
            call('/auth/v1/token?grant_type=pkce',{'auth_code':auth_code,'code_verifier':verifier})
            raise AssertionError('Repeated callback code accepted')
        except urllib.error.HTTPError as error:
            assert error.code in (400,401,403,404)
        print('PASS: real PKCE exchange, verified identity, authenticated profile save/read, isolated drafts and callback replay rejection. No emails sent.')
        return 0
    except urllib.error.HTTPError as error:
        print('Synthetic protocol check failed at '+stage+' with HTTP '+str(error.code)+'.',file=sys.stderr)
        try:
            code=json.loads(error.read()).get('code','unspecified')
            if isinstance(code,(str,int)) and re.fullmatch(r'[A-Za-z0-9_]{1,50}',str(code)):print('Safe backend error code:',code,file=sys.stderr)
        except (ValueError,TypeError):pass
        return 1
    finally:
        if created:
            sql("begin; delete from auth.flow_state where id='"+fid+"' and user_id='"+uid+"'; delete from auth.users where id='"+uid+"' and email='"+email+"'; commit;")
            print('Synthetic user, profile and sessions removed.')

if __name__=='__main__':raise SystemExit(main())
