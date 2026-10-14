# -*- coding: utf-8 -*-
"""Build a clean Zotero XPI plugin package.

The single source of truth for the add-on metadata is manifest.json in this
directory — this script never hard-codes it. Zotero 7+ (including 10.0.6)
rejects a plugin whose manifest lacks
applications.zotero.{id,update_url,strict_max_version}.

Ensures:
- All zip entry paths use forward slashes (/)
- All text files are UTF-8 without BOM
- All text files use LF line endings only
"""

import json
import hashlib
import os
import zipfile

SRC_DIR = os.path.dirname(os.path.abspath(__file__))
XPI_PATH = os.path.join(SRC_DIR, "zotero-vocab-book.xpi")

TEXT_FILES = [
    "manifest.json",
    "bootstrap.js",
    "locale/en-US/vocab-book-ui.ftl",
    "locale/zh-CN/vocab-book-ui.ftl",
]

RAW_FILES = [
    "icons/icon.svg",
]


def read_utf8_lf(filepath):
    """Read a file as UTF-8 and normalize to LF line endings."""
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()
    if content.startswith("\ufeff"):
        content = content[1:]
    return content.replace("\r\n", "\n").replace("\r", "\n")


def check_manifest(manifest):
    z = manifest.get("applications", {}).get("zotero", {})
    for field in ("id", "update_url", "strict_min_version", "strict_max_version"):
        if not z.get(field):
            raise SystemExit(
                f"manifest.json is missing applications.zotero.{field} "
                "(required by Zotero 7+)"
            )
    if "*" in z["strict_min_version"]:
        raise SystemExit("strict_min_version must not contain '*'")
    if not z["update_url"].startswith("https://"):
        raise SystemExit(
            "update_url must start with https:// "
            "(otherwise Zotero disables the plugin)"
        )
    if "example.com" in z["update_url"] or not manifest.get("homepage_url", "").startswith("https://github.com/"):
        raise SystemExit("Configure the actual GitHub repository before releasing")


def main():
    manifest = json.loads(read_utf8_lf(os.path.join(SRC_DIR, "manifest.json")))
    check_manifest(manifest)

    files = []
    for rel in TEXT_FILES:
        files.append((rel, read_utf8_lf(os.path.join(SRC_DIR, rel)).encode("utf-8")))
    for rel in RAW_FILES:
        with open(os.path.join(SRC_DIR, rel), "rb") as f:
            files.append((rel, f.read()))

    with zipfile.ZipFile(XPI_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry_path, data in files:
            zf.writestr(entry_path, data)
            print(f"  Added: {entry_path} ({len(data)} bytes)")

    z = manifest["applications"]["zotero"]
    with open(XPI_PATH, "rb") as file:
        digest = hashlib.sha256(file.read()).hexdigest()
    update = {"addons": {z["id"]: {"updates": [{
        "version": manifest["version"],
        "update_link": f'{manifest["homepage_url"]}/releases/download/v{manifest["version"]}/zotero-vocab-book.xpi',
        "update_hash": "sha256:" + digest,
        "applications": {"zotero": {key: z[key] for key in ("strict_min_version", "strict_max_version")}},
    }]}}}
    with open(os.path.join(SRC_DIR, "update.json"), "w", encoding="utf-8", newline="\n") as file:
        json.dump(update, file, indent=2)
        file.write("\n")

    print()
    print("=" * 50)
    print("  XPI built successfully!")
    print(f"  {XPI_PATH}")
    print("=" * 50)

    print()
    print("Verifying XPI contents...")
    problems = 0
    with zipfile.ZipFile(XPI_PATH, "r") as zf:
        for info in zf.infolist():
            data = zf.read(info.filename)
            has_bom = data[:3] == b"\xef\xbb\xbf"
            has_backslash = "\\" in info.filename
            has_cr = b"\r" in data
            ok = not (has_bom or has_backslash or has_cr)
            problems += 0 if ok else 1
            print(
                f"  [{'OK' if ok else 'PROBLEM'}] {info.filename:35s}  "
                f"Size:{len(data):6d}  CR:{has_cr}  Backslash:{has_backslash}  BOM:{has_bom}"
            )

    print()
    print("All checks passed! Install this XPI in Zotero." if not problems else "PROBLEMS FOUND")
    if problems:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
