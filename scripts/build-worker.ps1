$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nativeDir = Join-Path $repoRoot 'native'
$buildDir = Join-Path $nativeDir 'build'

function Find-Tool([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$clOnPath = Find-Tool 'cl.exe'
$cmakeExe = Find-Tool 'cmake.exe'
$ninjaExe = Find-Tool 'ninja.exe'

if ($clOnPath -and $cmakeExe) {
  $genArgs = @('-S', $nativeDir, '-B', $buildDir, '-DCMAKE_BUILD_TYPE=Release')
  if ($ninjaExe) {
    $genArgs += @('-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$ninjaExe")
  }
  & $cmakeExe @genArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  & $cmakeExe --build $buildDir
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Write-Host "Built x64 worker at $buildDir\paint_pallet_worker.exe"
  exit 0
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path $vswhere)) {
  throw "Neither an active MSVC dev shell nor vswhere.exe at $vswhere was found."
}

$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (-not $vsPath) {
  $vsPath = & $vswhere -latest -products * -property installationPath | Select-Object -First 1
}
if (-not $vsPath) {
  throw "No Visual Studio installation with C++ x64 tools found via vswhere."
}

$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
if (!(Test-Path $vcvars)) {
  throw "vcvars64.bat not found under $vsPath"
}

if (-not $cmakeExe) {
  $bundledCmake = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
  if (Test-Path $bundledCmake) { $cmakeExe = $bundledCmake }
}
if (-not $cmakeExe) {
  throw "cmake.exe not found on PATH or under $vsPath"
}

if (-not $ninjaExe) {
  $bundledNinja = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
  if (Test-Path $bundledNinja) { $ninjaExe = $bundledNinja }
}

$generatorPart = if ($ninjaExe) { "-G Ninja -DCMAKE_MAKE_PROGRAM=`"$ninjaExe`"" } else { '' }
$cmdLine = "call `"$vcvars`" && `"$cmakeExe`" -S `"$nativeDir`" -B `"$buildDir`" $generatorPart -DCMAKE_BUILD_TYPE=Release && `"$cmakeExe`" --build `"$buildDir`""
cmd /c $cmdLine
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
Write-Host "Built x64 worker at $buildDir\paint_pallet_worker.exe"
