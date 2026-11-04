#!/usr/bin/env python3
"""Build the public Windows setup ZIP from an explicit, credential-free file list."""
from hashlib import sha256
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    "Setup.cmd", "README.md", "WINDOWS.md", "package.json", "package-lock.json",
    "src/answers.mjs", "src/api.mjs", "src/browser.mjs", "src/check.mjs",
    "src/notify.mjs", "src/runner.mjs", "src/runtime.mjs", "src/server.mjs", "src/worker.mjs",
    "scripts/common.ps1", "scripts/install-task.ps1", "scripts/install-windows.ps1",
    "scripts/run-server.ps1", "scripts/run-worker.ps1", "scripts/show-report.ps1",
]


def main():
    output = ROOT / "downloads/GMoney-Windows-Connector.zip"
    output.parent.mkdir(exist_ok=True)
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as bundle:
        for name in sorted(FILES):
            entry = ZipInfo("GMoney-Windows-Connector/" + name, date_time=(2026, 11, 4, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, (ROOT / "connector" / name).read_bytes())
    digest = sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(digest + "  " + output.name + "\n")
    print(f"Built {len(FILES)} source files: {output.relative_to(ROOT)} ({output.stat().st_size} bytes)")
    print("SHA256: " + digest)


if __name__ == "__main__":
    main()
