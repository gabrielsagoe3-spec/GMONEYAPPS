#!/usr/bin/env python3
"""Download the existing PUBLIC report as the next run's deduplication baseline."""
import argparse
import json
from pathlib import Path
import urllib.error
import urllib.request
from publish_report import public_config
from research_worker import atomic_write

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    config = public_config(Path(__file__).resolve().parents[1] / 'assets/config.js')
    request = urllib.request.Request(config['url'] + '/rest/v1/published_research_reports?slug=eq.current&select=report&limit=1', headers={'apikey':config['publishableKey']})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('Report is too large')
        rows = json.loads(raw)
        if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0].get('report'), dict) or not isinstance(rows[0]['report'].get('records'), list):
            raise ValueError('No valid existing report')
        atomic_write(args.output, rows[0]['report'])
        print('Loaded public research baseline:', len(rows[0]['report']['records']), 'records')
        return 0
    except (urllib.error.URLError, ValueError, OSError):
        print('Could not load the public baseline; stopped before researching or publishing.')
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
