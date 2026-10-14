# Use the same validated build path on Windows and CI.
$ErrorActionPreference = "Stop"
python -X utf8 (Join-Path $PSScriptRoot "build-xpi.py")
if ($LASTEXITCODE -ne 0) { throw "XPI build failed (exit $LASTEXITCODE)" }
