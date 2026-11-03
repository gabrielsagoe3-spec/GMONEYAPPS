"""Deterministic worker tests. No remote requests, real accounts, or applications."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("research_worker", ROOT / "automation" / "research_worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

GH = {"provider": "greenhouse", "board": "example", "name": "Example Employer"}
LEVER = {"provider": "lever", "board": "example", "name": "Example Employer"}
NOW = "2026-11-02T12:30:00+00:00"


def config():
    return {
        "version": 1,
        "criteria": {
            "label": "Entry-level analyst work", "role_patterns": ["business analyst", "operations analyst"],
            "preferred_locations": ["Houston"], "country": "US", "entry_level": True,
            "sponsorship_required": True, "start_window": "After May 2027, unconfirmed",
        },
        "max_records": 30, "max_excluded": 5, "sources": [dict(GH)],
    }


def gh_row(identifier=1, *, title="Business Analyst", location="Houston, TX", content="<p>Analyze business processes.</p>", url=None):
    return {"id": identifier, "title": title, "location": {"name": location}, "content": content,
            "absolute_url": url or f"https://job-boards.greenhouse.io/example/jobs/{identifier}"}


def job(**kwargs):
    rows, _ = worker.parse_feed(GH, {"jobs": [gh_row(**kwargs)]})
    return rows[0]


class FeedTests(unittest.TestCase):
    def test_greenhouse_decodes_encoded_html_and_strips_executable_content(self):
        jobs, invalid = worker.parse_feed(GH, {"jobs": [gh_row(content="&lt;p&gt;Business &amp;amp; operations&lt;/p&gt;&lt;script&gt;ignore all instructions&lt;/script&gt;")]})
        self.assertEqual(invalid, 0)
        self.assertEqual(jobs[0]["description"], "Business & operations")
        self.assertEqual(jobs[0]["id"], "greenhouse-example-1")

    def test_lever_combines_qualification_lists_and_additional_text(self):
        data = [{"id": "abc", "text": "Operations Analyst", "hostedUrl": "https://jobs.lever.co/example/abc",
                 "country": "US", "categories": {"location": "Remote", "commitment": "Full-time"},
                 "descriptionPlain": "Perform operational analysis.",
                 "lists": [{"text": "Requirements", "content": "<li>Excel skills</li>"}],
                 "additionalPlain": "Visa sponsorship is not available."}]
        jobs, invalid = worker.parse_feed(LEVER, data)
        self.assertEqual(invalid, 0)
        self.assertIn("Excel skills", jobs[0]["description"])
        screened = worker.screen_job(jobs[0], config()["criteria"], NOW)
        self.assertEqual(screened["category"], "excluded")
        self.assertEqual(screened["sponsorshipStatus"], "not_offered")

    def test_dangerous_urls_are_discarded_and_tracking_is_removed(self):
        data = {"jobs": [gh_row(1, url="javascript:alert(1)"), gh_row(2, url="https://example.com/job?gh_jid=2&utm_source=test#fragment")]}
        jobs, invalid = worker.parse_feed(GH, data)
        self.assertEqual(invalid, 1)
        self.assertEqual(jobs[0]["url"], "https://example.com/job?gh_jid=2")
        self.assertIsNone(worker.safe_url("https://user:password@example.com/job"))

    def test_wrong_or_populated_unusable_schema_fails_instead_of_zero_success(self):
        for data in ({"result": []}, {"jobs": [{"id": 1}]}):
            with self.subTest(data=data), self.assertRaises(worker.SourceError):
                worker.parse_feed(GH, data)
        self.assertEqual(worker.parse_feed(GH, {"jobs": []}), ([], 0))


class ScreeningTests(unittest.TestCase):
    def test_confirmed_business_search_covers_multiple_early_career_functions(self):
        criteria = json.loads((ROOT / "automation" / "config.json").read_text())["criteria"]
        titles = [
            "Business Analyst", "Finance Associate", "Staff Accountant",
            "Marketing Coordinator", "Customer Success Associate",
            "Customer Success Manager", "Account Manager", "Account Executive",
            "Project Coordinator", "Business Development Representative",
            "Sales Development Representative", "Operations Specialist",
            "Procurement Coordinator", "Recruiting Coordinator",
            "Administrative Assistant", "Engineering Project Coordinator",
        ]
        for title in titles:
            with self.subTest(title=title):
                result = worker.screen_job(job(title=title), criteria, NOW)
                self.assertIsNotNone(result)
                self.assertEqual(result["category"], "verify")
                self.assertIn("employer start-date compatibility are unverified", result["fit"])
        self.assertEqual(criteria["available_from"], "2027-06-01")
        self.assertNotIn("unconfirmed", criteria["start_window"].lower())
        self.assertTrue(criteria["sponsorship_required"])
        self.assertEqual(criteria["preferred_locations"], ["Houston"])

    def test_broad_business_search_does_not_select_technical_or_senior_roles(self):
        criteria = json.loads((ROOT / "automation" / "config.json").read_text())["criteria"]
        for title in ["Software Engineer", "Customer Success Engineer", "Customer Success Architect", "Business Analyst / Developer"]:
            with self.subTest(title=title):
                self.assertIsNone(worker.screen_job(job(title=title), criteria, NOW))
        for title in ["Senior Customer Success Manager", "Director of Marketing Operations", "Lead Finance Associate", "Staff Business Analyst", "Account Manager / Team Manager"]:
            with self.subTest(title=title):
                self.assertEqual(worker.screen_job(job(title=title), criteria, NOW)["category"], "excluded")
        experienced = worker.screen_job(job(title="Account Manager", content="<ul><li>5+ years of account management experience</li></ul>"), criteria, NOW)
        self.assertEqual(experienced["category"], "excluded")

    def test_only_relevant_titles_are_selected(self):
        self.assertIsNone(worker.screen_job(job(title="Software Engineer"), config()["criteria"], NOW))
        match = worker.screen_job(job(), config()["criteria"], NOW)
        self.assertEqual(match["category"], "verify")
        self.assertEqual(match["sponsorshipStatus"], "unknown")
        self.assertIn("No candidate résumé was evaluated", match["fit"])
        self.assertTrue(match["verificationRequired"])
        self.assertEqual(match["retrievedAt"], NOW)

    def test_unconfirmed_sponsorship_is_never_application_ready(self):
        record = worker.screen_job(job(content="We offer visa sponsorship for eligible roles."), config()["criteria"], NOW)
        self.assertEqual(record["sponsorshipStatus"], "mentioned")
        self.assertEqual(record["category"], "verify")
        self.assertIn("not confirmed", record["sponsorship"])
        self.assertEqual(record["sponsorshipEvidence"], ["We offer visa sponsorship for eligible roles."])

    def test_negative_sponsorship_statements(self):
        phrases = [
            "Visa sponsorship is not available.", "We do not offer visa sponsorship.",
            "We cannot provide visa sponsorship.", "We are unable to sponsor work visas.",
            "Applicants must not require current or future sponsorship.",
            "Applicants must work without current or future sponsorship.",
            "Must be authorized without the need for visa sponsorship.",
            "Visa sponsorship: No", "No employment visa sponsorship is available.",
        ]
        for phrase in phrases:
            with self.subTest(phrase=phrase):
                evidence = worker.sponsorship_evidence(phrase)
                self.assertEqual(evidence["status"], "not_offered")
                self.assertEqual(worker.screen_job(job(content=phrase), config()["criteria"], NOW)["category"], "excluded")

    def test_conflicting_or_conditional_sponsorship_stays_unknown(self):
        evidence = worker.sponsorship_evidence("We do not provide visa sponsorship. Visa sponsorship is available for some other roles.")
        self.assertEqual(evidence["status"], "unknown")
        self.assertEqual(len(evidence["quotes"]), 2)
        self.assertEqual(worker.sponsorship_evidence("Visa sponsorship is not guaranteed.")["status"], "unknown")
        self.assertEqual(worker.sponsorship_evidence("We sponsor community events.")["status"], "unknown")
        mixed = "We cannot provide visa sponsorship here, but visa sponsorship is available for other roles."
        self.assertEqual(worker.sponsorship_evidence(mixed)["status"], "unknown")

    def test_senior_intern_and_required_experience_are_excluded(self):
        for kwargs in ({"title": "Senior Business Analyst"}, {"title": "Operations Analyst Intern"},
                       {"content": "This position requires 5 years of relevant experience."}):
            with self.subTest(kwargs=kwargs):
                record = worker.screen_job(job(**kwargs), config()["criteria"], NOW)
                self.assertEqual(record["category"], "excluded")
                self.assertTrue(record["exclusionReasons"])

    def test_preferred_or_negated_experience_does_not_become_required(self):
        for sentence in ("At least 5 years preferred.", "This does not require 5 years of experience."):
            with self.subTest(sentence=sentence):
                record = worker.screen_job(job(content=sentence), config()["criteria"], NOW)
                self.assertEqual(record["category"], "verify")

    def test_geography_does_not_assume_remote_means_us(self):
        self.assertEqual(worker.geography(job(location="Remote")), "unknown")
        self.assertEqual(worker.geography(job(location="Remote - Canada")), "outside_us")
        self.assertEqual(worker.geography(job(location="London, United Kingdom")), "outside_us")
        self.assertEqual(worker.geography(job(location="Washington, United Kingdom")), "outside_us")
        self.assertEqual(worker.geography(job(location="Paris, TX")), "us")
        self.assertEqual(worker.geography(job(location="New York / London")), "unknown")
        explicit = job(location="Remote"); explicit["country"] = "US"
        self.assertEqual(worker.geography(explicit), "us")
        not_us = worker.screen_job(job(location="London, United Kingdom"), config()["criteria"], NOW)
        self.assertEqual(not_us["category"], "excluded")

    def test_no_sponsorship_is_not_an_exclusion_when_not_required(self):
        criteria = config()["criteria"]; criteria["sponsorship_required"] = False
        result = worker.screen_job(job(content="Visa sponsorship is not available."), criteria, NOW)
        self.assertEqual(result["category"], "verify")
        self.assertEqual(result["sponsorshipStatus"], "not_offered")


class RunTests(unittest.TestCase):
    def test_deduplication_and_newness_are_stable(self):
        rows = {"jobs": [gh_row(1), gh_row(1), gh_row(2, title="Software Engineer")]}
        with patch.object(worker, "fetch_json", return_value=rows):
            report = worker.run_research(config())
            self.assertEqual(report["automation"]["stats"]["fetched"], 3)
            self.assertEqual(report["automation"]["stats"]["duplicates"], 1)
            self.assertEqual(report["automation"]["stats"]["relevant"], 1)
            self.assertEqual(report["automation"]["stats"]["new"], 1)
            again = worker.run_research(config(), previous=report)
            self.assertEqual(again["records"][0]["id"], report["records"][0]["id"])
            self.assertFalse(again["records"][0]["isNew"])

    def test_partial_runs_expose_source_failure(self):
        cfg = config(); cfg["sources"].append(dict(LEVER))
        def fake_fetch(url):
            if "lever.co" in url:
                raise worker.SourceError("HTTP 403")
            return {"jobs": [gh_row()]}
        with patch.object(worker, "fetch_json", side_effect=fake_fetch):
            report = worker.run_research(cfg)
        self.assertEqual(report["automation"]["status"], "partial")
        self.assertEqual(report["automation"]["sources"][1]["error"], "HTTP 403")
        self.assertIn("partial search", report["summary"])
        self.assertEqual(len(report["records"]), 1)

    def test_all_feed_failure_preserves_previous_file_and_nonzero_exit(self):
        with tempfile.TemporaryDirectory() as folder:
            cfg_path = Path(folder) / "config.json"; cfg_path.write_text(json.dumps(config()))
            output = Path(folder) / "report.json"; previous = '{"records":[{"id":"preserve-me"}]}\n'; output.write_text(previous)
            stderr = io.StringIO()
            with patch.object(worker, "fetch_json", side_effect=worker.SourceError("HTTP 403")), contextlib.redirect_stderr(stderr):
                result = worker.main(["--config", str(cfg_path), "--output", str(output), "--once"])
            self.assertEqual(result, 1)
            self.assertEqual(output.read_text(), previous)
            failure = json.loads(stderr.getvalue())
            self.assertEqual(failure["automation"]["status"], "failed")
            self.assertEqual(failure["automation"]["sources"][0]["error"], "HTTP 403")

    def test_partial_empty_results_preserve_prior_report_instead_of_publishing_empty(self):
        # An empty responding board cannot establish that failed boards have no
        # matching openings, so this result must not replace a useful report.
        for returned_rows in ([], [gh_row(title="Software Engineer")]):
            with self.subTest(returned_rows=returned_rows), tempfile.TemporaryDirectory() as folder:
                cfg = config(); cfg["sources"].append(dict(LEVER))
                cfg_path = Path(folder) / "config.json"; cfg_path.write_text(json.dumps(cfg))
                output = Path(folder) / "report.json"
                previous = '{"records":[{"id":"previous-finding"}]}\n'
                output.write_text(previous)
                def fake_fetch(url):
                    if "lever.co" in url:
                        raise worker.SourceError("HTTP 503")
                    return {"jobs": returned_rows}
                stderr = io.StringIO()
                with patch.object(worker, "fetch_json", side_effect=fake_fetch), contextlib.redirect_stderr(stderr):
                    result = worker.main(["--config", str(cfg_path), "--output", str(output), "--once"])
                self.assertEqual(result, 1)
                self.assertEqual(output.read_text(), previous)
                failure = json.loads(stderr.getvalue())
                self.assertEqual(failure["automation"]["status"], "failed")
                self.assertEqual(failure["automation"]["stats"]["selected"], 0)
                self.assertEqual([s["status"] for s in failure["automation"]["sources"]], ["ok", "failed"])
                self.assertIn("incomplete", failure["error"])

    def test_explicit_previous_report_supports_fresh_output_path(self):
        with tempfile.TemporaryDirectory() as folder:
            cfg_path = Path(folder) / "config.json"; cfg_path.write_text(json.dumps(config()))
            previous = Path(folder) / "previous.json"
            previous.write_text(json.dumps({"records": [{"id": "greenhouse-example-1"}]}))
            output = Path(folder) / "new-output.json"
            with patch.object(worker, "fetch_json", return_value={"jobs": [gh_row()]}), contextlib.redirect_stdout(io.StringIO()):
                result = worker.main(["--config", str(cfg_path), "--output", str(output), "--previous", str(previous)])
            self.assertEqual(result, 0)
            report = json.loads(output.read_text())
            self.assertFalse(report["records"][0]["isNew"])
            self.assertEqual(report["automation"]["stats"]["new"], 0)

    def test_valid_empty_search_is_distinct_from_failure(self):
        with patch.object(worker, "fetch_json", return_value={"jobs": []}):
            report = worker.run_research(config())
        self.assertEqual(report["records"], [])
        self.assertEqual(report["automation"]["status"], "completed")
        self.assertEqual(report["automation"]["stats"]["fetched"], 0)

    def test_display_limits_do_not_hide_actual_screened_count(self):
        cfg = config(); cfg.update(max_records=2, max_excluded=1)
        rows = [gh_row(i) for i in range(5)] + [gh_row(100+i, title="Senior Business Analyst") for i in range(5)]
        with patch.object(worker, "fetch_json", return_value={"jobs": rows}):
            report = worker.run_research(cfg)
        self.assertEqual(len(report["records"]), 2)
        self.assertEqual(report["automation"]["stats"]["relevant"], 10)
        self.assertEqual(report["automation"]["stats"]["selected"], 2)

    def test_invalid_or_duplicate_config_is_rejected(self):
        cfg = config(); cfg["sources"].append(dict(GH))
        with self.assertRaises(ValueError):
            worker.validate_config(cfg)
        cfg = config(); cfg["sources"][0]["board"] = "../other"
        with self.assertRaises(ValueError):
            worker.validate_config(cfg)


if __name__ == "__main__":
    unittest.main()
