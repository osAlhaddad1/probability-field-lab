$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$outputDir = Join-Path $projectRoot 'out'

if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}

$sourceFiles = Get-ChildItem -Path (Join-Path $projectRoot 'src') -Recurse -Filter '*.java' | ForEach-Object { $_.FullName }
Write-Host 'Compiling Probability Field Lab...'
& javac -encoding UTF-8 -d $outputDir $sourceFiles
if ($LASTEXITCODE -ne 0) { throw 'Java compilation failed.' }

Write-Host 'Opening http://localhost:8080'
Start-Process 'http://localhost:8080'
& java "-Dexperiment.root=$projectRoot" -cp $outputDir probexperiment.Main
