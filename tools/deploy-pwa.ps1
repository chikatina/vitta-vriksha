# Fast content-only sync to S3 + CloudFront invalidation for Vitta Vriksha PWA.
#
# Prereqs: AWS CLI v2, configured credentials, an already-deployed VittaVrikshaSite stack.
# Usage:    powershell -ExecutionPolicy Bypass -File tools/deploy-pwa.ps1

$ErrorActionPreference = "Stop"
$stack  = "VittaVrikshaSite"
$region = "us-east-1"

$repoRoot = Split-Path -Parent $PSScriptRoot
$wwwDir   = Join-Path $repoRoot "app\src\main\assets\www"

if (-not (Test-Path $wwwDir)) {
  Write-Error "www/ directory not found at $wwwDir"
  exit 1
}

function Get-RelativePathCompat($basePath, $fullPath) {
  return $fullPath.Substring($basePath.Length).TrimStart('\', '/').Replace('\', '/')
}

Write-Host "Fetching CloudFormation outputs from $stack ($region)..." -ForegroundColor Cyan
$outputsJson = aws cloudformation describe-stacks --stack-name $stack --region $region --query "Stacks[0].Outputs" --output json 2>$null
if ($LASTEXITCODE -ne 0 -or -not $outputsJson) {
  Write-Host "Stack '$stack' does not exist yet in $region." -ForegroundColor Yellow
  Write-Host "Please deploy the stack first using CDK from ChikatiStudio/infra:" -ForegroundColor Yellow
  Write-Host "  cd ..\ChikatiStudio\infra" -ForegroundColor Yellow
  Write-Host "  npx cdk deploy VittaVrikshaSite" -ForegroundColor Yellow
  exit 1
}

$outputs = $outputsJson | ConvertFrom-Json
$bucket  = ($outputs | Where-Object { $_.OutputKey -eq "BucketName" }).OutputValue
$distId  = ($outputs | Where-Object { $_.OutputKey -eq "DistributionId" }).OutputValue

if (-not $bucket -or -not $distId) {
  Write-Error "BucketName or DistributionId output missing from stack."
  exit 1
}

Write-Host "Bucket:       $bucket"
Write-Host "Distribution: $distId"
Write-Host ""

$shortCache  = "public, max-age=0, must-revalidate"
$mediumCache = "public, max-age=3600, must-revalidate"
$longCache   = "public, max-age=31536000, immutable"

Write-Host "Syncing assets to s3://$bucket/..." -ForegroundColor Cyan
aws s3 sync $wwwDir "s3://$bucket" --delete --cache-control $mediumCache --only-show-errors

Write-Host "Fixing MIME types and Cache-Control..." -ForegroundColor Cyan

# Service worker and HTML must never be cached aggressively
aws s3 cp (Join-Path $wwwDir "index.html") "s3://$bucket/index.html" `
  --cache-control $shortCache --content-type "text/html; charset=utf-8" --only-show-errors

if (Test-Path (Join-Path $wwwDir "sw.js")) {
  aws s3 cp (Join-Path $wwwDir "sw.js") "s3://$bucket/sw.js" `
    --cache-control $shortCache --content-type "application/javascript; charset=utf-8" --only-show-errors
}

if (Test-Path (Join-Path $wwwDir "manifest.webmanifest")) {
  aws s3 cp (Join-Path $wwwDir "manifest.webmanifest") "s3://$bucket/manifest.webmanifest" `
    --cache-control $shortCache --content-type "application/manifest+json; charset=utf-8" --only-show-errors
}

# Ensure .mjs ES module files have correct JavaScript MIME type (required for X-Content-Type-Options: nosniff)
Get-ChildItem -Path $wwwDir -Filter "*.mjs" -Recurse | ForEach-Object {
  $rel = Get-RelativePathCompat $wwwDir $_.FullName
  aws s3 cp $_.FullName "s3://$bucket/$rel" `
    --cache-control $mediumCache --content-type "text/javascript; charset=utf-8" --only-show-errors
}

# Ensure .wasm files have correct application/wasm MIME type and long cache
Get-ChildItem -Path $wwwDir -Filter "*.wasm" -Recurse | ForEach-Object {
  $rel = Get-RelativePathCompat $wwwDir $_.FullName
  aws s3 cp $_.FullName "s3://$bucket/$rel" `
    --cache-control $longCache --content-type "application/wasm" --only-show-errors
}

# Ensure fonts have long cache
Get-ChildItem -Path $wwwDir -Filter "*.woff2" -Recurse | ForEach-Object {
  $rel = Get-RelativePathCompat $wwwDir $_.FullName
  aws s3 cp $_.FullName "s3://$bucket/$rel" `
    --cache-control $longCache --content-type "font/woff2" --only-show-errors
}

# Ensure SQLite databases (.db) have application/octet-stream and long cache
Get-ChildItem -Path $wwwDir -Filter "*.db" -Recurse | ForEach-Object {
  $rel = Get-RelativePathCompat $wwwDir $_.FullName
  aws s3 cp $_.FullName "s3://$bucket/$rel" `
    --cache-control $longCache --content-type "application/octet-stream" --only-show-errors
}

Write-Host "Creating CloudFront invalidation..." -ForegroundColor Cyan
aws cloudfront create-invalidation --distribution-id $distId --paths "/*" --output json | Out-Null

Write-Host "Deployment complete! Visit: https://vittavriksha.chikatistudio.com" -ForegroundColor Green
