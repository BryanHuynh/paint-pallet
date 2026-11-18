param([Parameter(Mandatory = $true)][string]$DependenciesDir)

$ErrorActionPreference = 'Stop'
$name = 'embree-4.4.1.x64.windows'
$sha256 = '5aa1fa3161a720f9c610b06c652b80f421cb2b1fe8221fdf92b74157336fdf8f'
$archive = Join-Path $DependenciesDir "$name.zip"
$root = Join-Path $DependenciesDir $name

if (!(Test-Path -LiteralPath (Join-Path $root 'lib/embree4.lib'))) {
  New-Item -ItemType Directory -Path $DependenciesDir -Force | Out-Null
  if (!(Test-Path -LiteralPath $archive)) {
    $partial = "$archive.partial"
    curl.exe --fail --location --silent --show-error --output $partial "https://github.com/RenderKit/embree/releases/download/v4.4.1/$name.zip"
    if ($LASTEXITCODE -ne 0) { throw "Could not download Embree $name." }
    if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
      throw "Downloaded Embree archive does not match the pinned SHA-256."
    }
    Move-Item -LiteralPath $partial -Destination $archive
  }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha256) {
    throw "Cached Embree archive does not match the pinned SHA-256."
  }
  tar.exe -xf $archive -C $DependenciesDir
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned Embree archive.' }
}

return (Resolve-Path -LiteralPath $root).Path
