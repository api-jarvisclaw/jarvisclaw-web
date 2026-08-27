# Optional name filter, so a second collection can be added without re-uploading the first.
# The directory holds two sets: the Franklin gallery (36 files) and the Seedance prompt collection
# (110, prefixed sd-). Re-sending all 146 every time is slow and pointless, and each redundant PUT
# is another chance at a partial write on a file that was already correct.
#
#   .\upload-showcase.ps1              # everything
#   .\upload-showcase.ps1 -Match 'sd-' # only the seedance assets
#
# `param` MUST be the first statement in the file — PowerShell rejects it anywhere else, and the
# error names a line far from the cause. Hence the block sitting above the file's own header
# comment rather than beside the loop it belongs to.
param([string]$Match = '')

# Uploads the prompt-gallery assets to R2 under showcase/.
#
# PowerShell rather than sh, and that is not a preference. Running the .sh version through Git
# Bash on this machine resolves `wrangler` to the npm shim under a /mnt/c path, whose bundled
# workerd native binary does not exist for that platform — it fails inside workerd's
# generateBinPath with a stack trace that says nothing about the cause.
#
# --Remote is MANDATORY. Without it `wrangler r2 object put` writes to a LOCAL simulated bucket,
# prints "Upload complete", and the object is then unreadable through the live Worker. The
# success message is identical either way, which is what makes the mistake expensive.
#
# The prefix is showcase/, deliberately not gallery/ and not media/:
#   media/     expires after 1 day (lifecycle rule media-cache-1d) — it is a cache
#   gallery/   no expiry — media a user paid for
#   showcase/  no expiry — these curated examples, which must never look broken
# An all-prefixes expiry rule would delete every one of these overnight. Do not add one.

# NOT 'Stop'. wrangler writes a proxy warning to stderr on every invocation, and Windows
# PowerShell wraps a native command's stderr lines in ErrorRecords — with 'Stop' the first of
# those aborts the whole script after one file, which is exactly what happened. Exit codes are
# checked explicitly instead, which is the only reliable signal here.
$ErrorActionPreference = 'Continue'
$bucket = 'jarvisclaw-media'
$dir = Join-Path $PSScriptRoot 'showcase'

$types = @{
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.png'  = 'image/png'
  '.webp' = 'image/webp'
  '.mp4'  = 'video/mp4'
}

$done = 0
$skipped = 0
$failed = @()
foreach ($f in Get-ChildItem $dir -File) {
  if ($Match -ne '' -and $f.Name -notlike "$Match*") { $skipped++; continue }
  $ct = $types[$f.Extension.ToLower()]
  if (-not $ct) { Write-Host "skipping $($f.Name) (unknown type)"; continue }
  Write-Host "-> showcase/$($f.Name) ($ct)"
  wrangler r2 object put "$bucket/showcase/$($f.Name)" --file $f.FullName --content-type $ct --remote
  if ($LASTEXITCODE -eq 0) { $done++ } else { $failed += $f.Name }
}

Write-Host ""
Write-Host "uploaded $done, skipped $skipped, failed $($failed.Count)"
if ($failed.Count -gt 0) { $failed | ForEach-Object { Write-Host "  FAILED $_" } }
Write-Host "verify: curl -sI https://cdn.jarvisclaw.ai/showcase/ecom-crocs.jpg"
