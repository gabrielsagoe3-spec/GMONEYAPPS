"""Offline tests for safe, scoped automated-report publication."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

MODULE = Path(__file__).resolve().parents[1] / 'automation' / 'publish_report.py'
spec = importlib.util.spec_from_file_location('publish_report', MODULE)
publisher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.report = {'automation': {'runId': 'run-123', 'status': 'completed'}}
        self.kwargs = dict(url='https://example.supabase.co', publishable_key='public-test-key', research_key='private-test-worker-key')

    def test_rpc_uses_separate_worker_key_and_does_not_send_admin_token(self):
        captured = {}
        def opener(request, timeout):
            captured['request'] = request
            self.assertEqual(timeout, 30)
            return io.BytesIO(json.dumps({'published': True, 'runId': 'run-123'}).encode())
        result = publisher.publish(self.report, opener=opener, **self.kwargs)
        request = captured['request']
        self.assertEqual(request.full_url, 'https://example.supabase.co/rest/v1/rpc/publish_automated_research')
        self.assertEqual(json.loads(request.data), {'report': self.report})
        headers = {k.lower(): v for k, v in request.header_items()}
        self.assertEqual(headers['apikey'], 'public-test-key')
        self.assertEqual(headers['x-gmoney-research-key'], 'private-test-worker-key')
        self.assertNotIn('authorization', headers)
        self.assertEqual(result, {'published': True, 'runId': 'run-123'})

    def test_identical_run_retry_is_successful_and_idempotent(self):
        result = publisher.publish(self.report, opener=lambda *a, **kw: io.BytesIO(b'{"published":false,"runId":"run-123"}'), **self.kwargs)
        self.assertFalse(result['published'])

    def test_denial_does_not_print_server_response_or_secret(self):
        def denied(*args, **kwargs):
            raise urllib.error.HTTPError('https://example.supabase.co', 403, 'denied', {}, io.BytesIO(b'private-test-worker-key and internal details'))
        with self.assertRaises(publisher.PublishError) as error:
            publisher.publish(self.report, opener=denied, **self.kwargs)
        self.assertIn('denied', str(error.exception))
        self.assertNotIn('private-test-worker-key', str(error.exception))
        self.assertNotIn('internal', str(error.exception))

    def test_transport_failure_reports_uncertain_publication_without_retrying(self):
        calls = []
        def disconnected(*args, **kwargs):
            calls.append(1)
            raise urllib.error.URLError('sensitive proxy details')
        with self.assertRaisesRegex(publisher.PublishError, 'could not be confirmed') as error:
            publisher.publish(self.report, opener=disconnected, **self.kwargs)
        self.assertEqual(calls, [1])
        self.assertNotIn('sensitive', str(error.exception))

    def test_server_error_is_uncertain_because_publication_may_have_committed(self):
        def failed_after_possible_commit(*args, **kwargs):
            raise publisher.urllib.error.HTTPError(
                'https://example.supabase.co', 503, 'gateway failure', {},
                io.BytesIO(b'private-test-worker-key and internal details'))
        with self.assertRaises(publisher.PublishError) as error:
            publisher.publish(self.report, opener=failed_after_possible_commit, **self.kwargs)
        self.assertIn('could not be confirmed', str(error.exception))
        self.assertIn('same report', str(error.exception))
        self.assertNotIn('previous report remains', str(error.exception))
        self.assertNotIn('private-test-worker-key', str(error.exception))

    def test_redirects_are_blocked_without_forwarding_worker_header(self):
        request = publisher.urllib.request.Request(
            'https://example.supabase.co/rest/v1/rpc/publish_automated_research',
            headers={'x-gmoney-research-key': 'private-test-worker-key'})
        self.assertIsNone(publisher.NoRedirect().redirect_request(
            request, None, 302, 'redirect', {}, 'https://different.example/collect'))
        with patch.object(publisher.urllib.request, 'build_opener') as factory:
            factory.return_value.open.side_effect = publisher.urllib.error.HTTPError(
                request.full_url, 302, 'redirect', {'Location': 'https://different.example/collect'}, None)
            with self.assertRaisesRegex(publisher.PublishError, 'redirect was blocked'):
                publisher.publish(self.report, **self.kwargs)
            self.assertIsInstance(factory.call_args.args[0], publisher.NoRedirect)
            self.assertEqual(factory.return_value.open.call_count, 1)

    def test_wrong_run_response_is_not_claimed_as_success(self):
        with self.assertRaisesRegex(publisher.PublishError, 'could not be confirmed'):
            publisher.publish(self.report, opener=lambda *a, **kw: io.BytesIO(b'{"published":true,"runId":"other"}'), **self.kwargs)

    def test_non_https_or_credential_url_is_rejected_before_network(self):
        for url in ('http://example.com', 'https://user:password@example.com', 'https://example.com/path'):
            with self.subTest(url=url), self.assertRaises(publisher.PublishError):
                publisher.publish(self.report, **{**self.kwargs, 'url': url})

    def test_failed_run_is_not_read_for_publication(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'report.json'
            p.write_text(json.dumps({'automation': {'status': 'failed'}}))
            with self.assertRaisesRegex(publisher.PublishError, 'Only completed'):
                publisher.read_report(p)

    def test_cli_missing_worker_key_exits_nonzero_without_network(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / 'config.js'
            report = Path(tmp) / 'report.json'
            config.write_text('window.GMONEY_DB = {"url":"https://example.supabase.co","publishableKey":"public-test-key"};')
            report.write_text(json.dumps(self.report))
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.dict(os.environ, {}, clear=True), patch.object(publisher.urllib.request, 'urlopen') as remote:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    code = publisher.main([str(report), '--config', str(config)])
                remote.assert_not_called()
            self.assertEqual(code, 1)
            self.assertEqual(stdout.getvalue(), '')
            self.assertIn('GMONEY_RESEARCH_KEY', stderr.getvalue())

    def test_large_report_is_rejected(self):
        with self.assertRaisesRegex(publisher.PublishError, '2 MiB'):
            publisher.publish({'summary': 'x' * publisher.MAX_REPORT_BYTES}, **self.kwargs)


if __name__ == '__main__':
    unittest.main()
