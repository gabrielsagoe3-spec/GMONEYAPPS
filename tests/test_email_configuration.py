import importlib.util
from pathlib import Path
import sys
import unittest
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'automation'))
spec=importlib.util.spec_from_file_location('email_configuration',ROOT/'automation/configure_email_auth.py')
auth=importlib.util.module_from_spec(spec);spec.loader.exec_module(auth)

def config():
    return {'site_url':auth.SITE,'uri_allow_list':auth.SITE,'external_email_enabled':True,'mailer_autoconfirm':False,
            'mailer_templates_magic_link_content':'<a href="{{ .ConfirmationURL }}">Sign in</a>',
            'mailer_templates_confirmation_content':'<a href="{{ .ConfirmationURL }}">Confirm</a>'}

class EmailConfigurationTests(unittest.TestCase):
    def test_unsupported_old_names_do_not_pass_code_readback(self):
        c=config();c.update(mailer_templates_magic_link='{{ .Token }}',mailer_templates_confirmation='{{ .Token }}')
        self.assertFalse(auth.check(c,'code')['email_templates'])
        self.assertTrue(auth.check(c,'link')['email_templates'])

    def test_both_actual_content_fields_must_match_mode(self):
        c=config();c['mailer_templates_magic_link_content']='{{ .Token }}'
        self.assertFalse(auth.check(c,'code')['email_templates'])
        self.assertFalse(auth.check(c,'link')['email_templates'])
        c['mailer_templates_confirmation_content']='{{ .Token }}'
        self.assertTrue(all(auth.check(c,'code').values()))

    def test_free_link_setup_changes_redirects_without_touching_templates(self):
        c=config();c['site_url']='http://localhost:3000';c['uri_allow_list']='https://existing.example/callback'
        changes=auth.desired_settings(c,'link')
        self.assertEqual(changes['site_url'],auth.SITE)
        self.assertIn('https://existing.example/callback',changes['uri_allow_list'])
        self.assertIn(auth.SITE,changes['uri_allow_list'])
        self.assertFalse(any(k.startswith('mailer_templates') for k in changes))

    def test_code_setup_requires_smtp_and_link_setup_is_repeatable(self):
        c=config()
        with self.assertRaisesRegex(ValueError,'custom SMTP'):auth.desired_settings(c,'code')
        self.assertEqual(auth.desired_settings(c,'link'),{})
        c['smtp_host']='smtp.example.invalid'
        self.assertIn('mailer_templates_magic_link_content',auth.desired_settings(c,'code'))

if __name__=='__main__':unittest.main()
