"""Bind update metadata to an explicitly selected GitHub repository."""
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
repo = sys.argv[1]
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
    raise SystemExit("Expected owner/repository")
manifest_path = root / "manifest.json"
manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
manifest["homepage_url"] = f"https://github.com/{repo}"
manifest["author"] = repo.split("/")[0]
manifest["applications"]["zotero"]["update_url"] = f"https://github.com/{repo}/releases/latest/download/update.json"
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Configured repository: {repo}")
