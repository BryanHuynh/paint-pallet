$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$nativeDir = Join-Path $repoRoot 'native'
$buildDir = Join-Path $nativeDir 'build'

$vcvars = 'C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat'
$cmake = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$ninja = 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'

if (!(Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }
if (!(Test-Path $cmake)) { throw "cmake.exe not found at $cmake" }
if (!(Test-Path $ninja)) { throw "ninja.exe not found at $ninja" }

$cmd = "call `"$vcvars`" && `"$cmake`" -S `"$nativeDir`" -B `"$buildDir`" -G Ninja -DCMAKE_MAKE_PROGRAM=`"$ninja`" -DCMAKE_BUILD_TYPE=Release && `"$cmake`" --build `"$buildDir`""
cmd /c $cmd
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
Write-Host "Built x64 worker at $buildDir\paint_pallet_worker.exe"
