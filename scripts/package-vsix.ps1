param(
    [switch]$Install
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageJsonPath = Join-Path $repoRoot "package.json"

if (-not (Test-Path $packageJsonPath)) {
    throw "Could not find package.json at $packageJsonPath"
}

$package = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
$vsixName = "$($package.name)-$($package.version).vsix"
$vsixPath = Join-Path $repoRoot $vsixName
$vscePath = Join-Path $repoRoot "node_modules\.bin\vsce.cmd"

Push-Location $repoRoot
try {
    Write-Host "Compiling extension..."
    npm run compile
    if ($LASTEXITCODE -ne 0) {
        throw "Compilation failed."
    }

    Write-Host "Packaging VSIX..."
    if (-not (Test-Path $vscePath)) {
        throw "Could not find $vscePath. Run 'npm install' first."
    }

    & $vscePath package
    if ($LASTEXITCODE -ne 0) {
        throw "VSIX packaging failed."
    }

    Write-Host "Created: $vsixPath"

    if ($Install) {
        $codeCli = Get-Command code.cmd -ErrorAction SilentlyContinue
        if (-not $codeCli) {
            $codeCli = Get-Command code -ErrorAction SilentlyContinue
        }

        if (-not $codeCli) {
            throw "The 'code' CLI was not found. In VS Code, open the Command Palette and run 'Shell Command: Install 'code' command in PATH', then run this script again."
        }

        Write-Host "Installing VSIX in VS Code..."
        & $codeCli.Source --install-extension $vsixPath --force
        if ($LASTEXITCODE -ne 0) {
            throw "VSIX installation failed."
        }

        Write-Host "Installed: $vsixPath"
    }
}
finally {
    Pop-Location
}
