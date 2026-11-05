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
            "sponsorship_required": True, "start_window": "From May 1, 2027 onward", "available_from": "2027-05-01",
            "sponsorship_requirement_note": "Initial work must permit valid OPT/CPT where applicable to the role and dates; future H-1B sponsorship is required.",
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


class HoustonScopeTests(unittest.TestCase):
    def test_named_local_metadata_is_required_and_ambiguous_places_need_texas(self):
        accepted = [
            "Houston", "Houston, TX", "Greater Houston Area", "Houston, Texas, United States",
            "Stafford, TX", "Sugar Land", "Sugar Land, TX", "Missouri City, Texas",
            "Rosenberg, TX", "Pearland, TX", "Katy, TX", "Cypress, TX", "Spring, TX",
            "The Woodlands, TX", "Humble, TX", "Pasadena, TX", "Richmond, TX", "Bellaire, TX",
            "League City, TX", "Fort Bend County, TX", "Harris County, TX",
            "Remote — Houston, TX", "Houston / Sugar Land, TX", "United States - Texas - Katy",
        ]
        rejected = [
            "Houston, MS", "Houston Street, New York", "500 Houston St, Austin, TX",
            "Spring, NY", "Cypress, CA", "Richmond, VA", "Stafford, VA", "Pasadena, CA",
            "Springfield, TX", "Sugar Land Road, Dallas, TX", "Remote US", "Remote Texas",
            "United States", "Texas", "Houston, TX / Boston, MA", "HQ: Houston, TX",
            "Remote US (Houston office)", "Houston County, TX", "Stafford", "Spring", "Cypress",
            "Houston, TX / Remote US", "Houston, TX / London, UK",
        ]
        criteria = {**config()["criteria"], "required_location_scope": "houston_metro"}
        for location in accepted:
            with self.subTest(location=location):
                candidate = job(location=location)
                self.assertTrue(worker.houston_metro_location(candidate))
                record = worker.screen_job(candidate, criteria, NOW)
                self.assertIsNotNone(record)
                self.assertIn("Houston-area role location", record["fit"])
                self.assertTrue(record["verificationRequired"])
        for location in rejected:
            with self.subTest(location=location):
                candidate = job(location=location, content="Our company headquarters is in Houston, Texas.")
                self.assertFalse(worker.houston_metro_location(candidate))
                self.assertIsNone(worker.screen_job(candidate, criteria, NOW))
        self.assertFalse(worker.houston_metro_location({**job(), "country": "CA"}))

    def test_legacy_search_without_required_scope_keeps_other_us_leads(self):
        self.assertIsNotNone(worker.screen_job(job(location="Boston, MA"), config()["criteria"], NOW))
        self.assertIsNotNone(worker.screen_job(job(location="Remote US"), config()["criteria"], NOW))
        bad = config(); bad["criteria"]["required_location_scope"] = "anywhere"
        with self.assertRaises(ValueError):
            worker.validate_config(bad)

    def test_scoped_reports_never_show_nonlocal_excluded_examples(self):
        cfg = config(); cfg["criteria"]["required_location_scope"] = "houston_metro"
        rows = {"jobs": [gh_row(1, location="Boston, MA", content="No visa sponsorship is available."),
                         gh_row(2, location="Stafford, TX"), gh_row(3, location="Remote US")]}
        with patch.object(worker, "fetch_json", return_value=rows):
            report = worker.run_research(cfg)
        self.assertEqual([r["id"] for r in report["records"]], ["greenhouse-example-2"])
        self.assertIn("Houston metro only", report["scope"])
        self.assertIn("Houston-area title-relevant", report["summary"])
        self.assertNotIn("preferred", report["scope"])
        self.assertIn("May 1, 2027", report["records"][0]["next"])
        self.assertIn("future H-1B sponsorship", report["records"][0]["next"])
        with patch.object(worker, "fetch_json", return_value={"jobs": [gh_row(location="Remote US")]}):
            empty = worker.run_research(cfg)
        self.assertEqual(empty["records"], [])
        self.assertEqual(empty["automation"]["status"], "completed")


class ScreeningTests(unittest.TestCase):
    def test_only_explicit_work_start_dates_are_ranked_with_source_quotes(self):
        criteria = config()["criteria"]
        baseline = worker.screen_job(job(), criteria, NOW)
        for text in ["Start date: June 1, 2027.", "Starting June 2027.", "Start date: 2027-05-01.", "Starting May 2027.", "Start date: Jun. 1, 2027.", "Starting from June 2027."]:
            with self.subTest(text=text):
                result = worker.screen_job(job(content=text), criteria, NOW)
                self.assertGreater(result["matchScore"], baseline["matchScore"])
                self.assertIn("Explicit employer start timing is on or after 2027-05-01", result["fit"])
                self.assertIn('“' + text + '”', result["fit"])
                self.assertEqual(result["category"], "verify")
                self.assertTrue(result["verificationRequired"])
                self.assertIn("qualifications", result["fit"])
        result = worker.screen_job(job(content="Start date: June 1, 2027. Applications close May 1, 2027."), criteria, NOW)
        self.assertGreater(result["matchScore"], baseline["matchScore"])

    def test_graduation_posting_deadline_and_other_dates_do_not_supply_start_dates(self):
        criteria = config()["criteria"]
        baseline = worker.screen_job(job(), criteria, NOW)
        for text in [
            "Graduation must be between May 2027 and August 2027.",
            "Posted 2027-05-01. Application deadline: June 1, 2027.",
            "2027-06-01", "Applications starting June 2027.",
            "Graduates starting June 2027.", "Starting salary: $70,000 in June 2027.",
            "The project starts June 2027.",
            "Health coverage starts June 2027.", "Our visa sponsorship program starts June 2027.",
            "Required training starts June 2027.",
        ]:
            with self.subTest(text=text):
                evidence = worker.start_date_evidence(text, "2027-05-01", NOW)
                self.assertEqual(evidence["status"], "unknown")
                self.assertEqual(evidence["quotes"], [])
                result = worker.screen_job(job(content=text), criteria, NOW)
                self.assertEqual(result["category"], "verify")
                self.assertEqual(result["matchScore"], baseline["matchScore"])

    def test_earlier_start_requires_review_unless_explicitly_mandatory(self):
        criteria = config()["criteria"]
        baseline = worker.screen_job(job(), criteria, NOW)
        for text in ["Start date: April 30, 2027.", "Starting April 2027.", "Start immediately.", "Immediate start.", "Starting as soon as possible."]:
            with self.subTest(text=text):
                result = worker.screen_job(job(content=text), criteria, NOW)
                self.assertEqual(result["category"], "verify")
                self.assertLess(result["matchScore"], baseline["matchScore"])
                self.assertIn("employer flexibility is unverified", result["fit"])
                self.assertIn('“' + text + '”', result["fit"])
        for text in ["Candidates must start by April 30, 2027.", "Candidates must be available to start April 1, 2027.", "Must start immediately."]:
            with self.subTest(text=text):
                result = worker.screen_job(job(content=text), criteria, NOW)
                self.assertEqual(result["category"], "excluded")
                self.assertIn("explicitly requires a start before", " ".join(result["exclusionReasons"]))
        self.assertEqual(worker.start_date_evidence("Start immediately.", "2027-05-01", "2027-05-02")["status"], "unknown")

    def test_ambiguous_invalid_and_month_boundary_dates_remain_unverified(self):
        for text in [
            "Start date: June 1, 2027 or July 1, 2027.",
            "Must start April 1, 2027. Start date: June 1, 2027.",
            "Start date: June 1, 2027. Start immediately.",
            "Start immediately or June 1, 2027.",
            "Start date: June 1, 2027 or later.",
            "Start date between April 1, 2027 and June 1, 2027.",
            "Start date: February 30, 2027.", "Start date: 2027-02-30.",
            "Start date: TBD.", "Applicants are not required to start April 1, 2027.",
            "For other roles, candidates must start April 1, 2027.",
            "Required start date: January 2027; alternative timing can be discussed.",
            "Must start April 2027. Flexible start dates are available.",
            "Start by July 1, 2027.", "Start date no later than June 2027.",
            "Candidates must not start May 1, 2027.", "Do not start June 2027.",
            "This is not a must start January 2027 requirement.",
            "The requirement 'must start January 2027' does not apply.",
            "Must start from April 2027.",
        ]:
            with self.subTest(text=text):
                self.assertEqual(worker.start_date_evidence(text, "2027-05-01", NOW)["status"], "unknown")
                self.assertEqual(worker.screen_job(job(content=text), config()["criteria"], NOW)["category"], "verify")
        self.assertEqual(worker.start_date_evidence("Starting May 2027.", "2027-05-15", NOW)["status"], "unknown")
        self.assertEqual(worker.start_date_evidence("Must start April 2027.", "2027-04-15", NOW)["status"], "unknown")
        self.assertEqual(worker.start_date_evidence("Start date: May 15, 2027.", "2027-05-15", NOW)["status"], "compatible")

    def test_cohort_year_is_only_a_weak_unverified_signal_and_application_discloses_availability(self):
        criteria = config()["criteria"]
        baseline = worker.screen_job(job(title="New Graduate Business Analyst"), criteria, NOW)
        cohort = worker.screen_job(job(title="2027 New Graduate Business Analyst"), criteria, NOW)
        explicit = worker.screen_job(job(content="Starting June 2027."), criteria, NOW)
        self.assertGreater(cohort["matchScore"], baseline["matchScore"])
        self.assertLess(cohort["matchScore"], explicit["matchScore"])
        self.assertIn("Unverified cohort-year signal", cohort["fit"])
        self.assertIn("does not establish a start date or graduation eligibility", cohort["fit"])
        self.assertNotIn("2027-01-01", cohort["fit"])
        self.assertIn("you may apply while employer start timing is unconfirmed", cohort["next"])
        self.assertIn("full-time availability from May 1, 2027", cohort["next"])
        self.assertIn("your expected graduation", cohort["next"])
        self.assertNotIn("before preparing", cohort["next"])
        self.assertEqual(set(cohort), set(baseline))

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
        self.assertEqual(criteria["available_from"], "2027-05-01")
        self.assertNotIn("unconfirmed", criteria["start_window"].lower())
        self.assertTrue(criteria["sponsorship_required"])
        self.assertIn("valid OPT/CPT where applicable", criteria["sponsorship_requirement_note"])
        self.assertIn("future H-1B sponsorship is required", criteria["sponsorship_requirement_note"])
        self.assertEqual(criteria["preferred_locations"], ["Houston", "Stafford", "Sugar Land"])
        self.assertEqual(criteria["required_location_scope"], "houston_metro")

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

    def test_opt_cpt_acceptance_does_not_establish_future_h1b_sponsorship(self):
        for phrase in [
            "We accept candidates with valid OPT or CPT.",
            "No sponsorship required during OPT.",
            "No visa sponsorship is needed while on STEM OPT.",
            "No sponsorship is required during CPT.",
        ]:
            with self.subTest(phrase=phrase):
                record = worker.screen_job(job(content=phrase), config()["criteria"], NOW)
                self.assertEqual(record["sponsorshipStatus"], "unknown")
                self.assertEqual(record["category"], "verify")
                self.assertTrue(record["verificationRequired"])
                self.assertIn("verify initial OPT/CPT acceptance for the role and work dates", record["next"])
                self.assertIn("future H-1B sponsorship", record["next"])

    def test_explicit_h1b_sponsorship_offers_still_require_verification(self):
        for phrase in [
            "We offer H-1B sponsorship for eligible roles.",
            "H1B sponsorship is available.",
            "We sponsor H-1B visas.",
            "No sponsorship required during OPT, but we offer H1B sponsorship.",
        ]:
            with self.subTest(phrase=phrase):
                record = worker.screen_job(job(content=phrase), config()["criteria"], NOW)
                self.assertEqual(record["sponsorshipStatus"], "mentioned")
                self.assertEqual(record["category"], "verify")
                self.assertTrue(record["verificationRequired"])
                self.assertEqual(record["sponsorshipEvidence"], [phrase])

    def test_explicit_h1b_sponsorship_denials_are_excluded(self):
        for phrase in [
            "No H-1B sponsorship.",
            "We do not offer H1B sponsorship.",
            "We do not sponsor H-1B visas.",
            "H-1B sponsorship is not available.",
            "No sponsorship required during OPT; future H-1B sponsorship is not available.",
        ]:
            with self.subTest(phrase=phrase):
                record = worker.screen_job(job(content=phrase), config()["criteria"], NOW)
                self.assertEqual(record["sponsorshipStatus"], "not_offered")
                self.assertEqual(record["category"], "excluded")
                self.assertEqual(record["sponsorshipEvidence"], [phrase])
        for phrase in [
            "H-1B sponsorship is not guaranteed.",
            "We do not offer H-1B sponsorship, but H1B sponsorship is available for other roles.",
        ]:
            with self.subTest(phrase=phrase):
                self.assertEqual(worker.sponsorship_evidence(phrase)["status"], "unknown")

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
    def test_compatible_start_leads_outrank_unknown_and_earlier_starts(self):
        rows = {"jobs": [gh_row(1, content="Start date: April 1, 2027."), gh_row(2),
                         gh_row(3, location="Austin, TX", content="Starting June 2027."),
                         gh_row(4, content="Must start April 1, 2027.")]}
        with patch.object(worker, "fetch_json", return_value=rows):
            report = worker.run_research(config())
        self.assertEqual([record["id"] for record in report["records"]],
                         [f"greenhouse-example-{number}" for number in (3, 2, 1, 4)])

    def test_report_scope_explains_both_authorization_requirements(self):
        cfg = config()
        with patch.object(worker, "fetch_json", return_value={"jobs": [gh_row()]}):
            report = worker.run_research(cfg)
        self.assertIn(cfg["criteria"]["sponsorship_requirement_note"], report["scope"])
        self.assertNotIn("sponsorship_requirement_note", report["records"][0])

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
