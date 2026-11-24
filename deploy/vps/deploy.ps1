# Deploys this source tree to the VPS (/srv/onceplatform): uploads the source,
# builds the image there and recreates only the app container (a few seconds
# of downtime). The database and its data are not touched; new migrations in
# internal/ do run on app start. Details and rollback: deploy.sh next to this.
#
#   powershell -File deploy\vps\deploy.ps1 [-Server root@<vps-ip>]
# Without -Server: $env:ONCEPLATFORM_VPS, else the first line of
# deploy\vps\server.local (kept out of git: the repository is public).
param([string]$Server = $env:ONCEPLATFORM_VPS)
if (-not $Server -and (Test-Path "$PSScriptRoot\server.local")) { $Server = (Get-Content "$PSScriptRoot\server.local" -TotalCount 1).Trim() }
if (-not $Server) { throw 'Set the server: -Server root@<vps-ip>, $env:ONCEPLATFORM_VPS or deploy\vps\server.local' }

$root = Resolve-Path "$PSScriptRoot\..\.."
$tgz = Join-Path $env:TEMP 'onceplatform-src.tar.gz'

Push-Location $root
tar -czf $tgz --exclude=node_modules --exclude=web/dist --exclude=internal/webui/dist `
    Dockerfile .dockerignore go.mod go.sum cmd internal web cvengine deploy/vps/deploy.sh
$code = $LASTEXITCODE
Pop-Location
if ($code) { throw "tar failed ($code)" }

ssh -n -o BatchMode=yes $Server 'mkdir -p /srv/onceplatform/build'
if ($LASTEXITCODE) { throw 'ssh failed' }
scp -q -o BatchMode=yes $tgz "${Server}:/srv/onceplatform/build/src.tar.gz"
if ($LASTEXITCODE) { throw 'upload failed' }
ssh -n -o BatchMode=yes $Server 'cd /srv/onceplatform/build && rm -rf src && mkdir src && tar -xzf src.tar.gz -C src && sh src/deploy/vps/deploy.sh'
if ($LASTEXITCODE) { throw "deploy failed ($LASTEXITCODE), see output above" }
