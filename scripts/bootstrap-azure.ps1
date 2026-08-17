param(
    [string]$ResourceGroup = 'probability-field-lab-rg',
    [string]$Location = 'westeurope',
    [string]$Repository = 'osAlhaddad1/probability-field-lab',
    [string]$SubscriptionId = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI is not installed. Install Microsoft.AzureCLI with winget, reopen PowerShell, and run az login.'
}
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'GitHub CLI is not installed.'
}

if ($SubscriptionId) {
    az account set --subscription $SubscriptionId
    if ($LASTEXITCODE -ne 0) { throw 'Could not select the requested Azure subscription.' }
}

$accountJson = az account show --output json
if ($LASTEXITCODE -ne 0) { throw 'Sign in first with az login.' }
$account = $accountJson | ConvertFrom-Json

Write-Host "Using Azure subscription: $($account.name) [$($account.id)]"
Write-Host "Creating resource group $ResourceGroup in $Location..."
az group create --name $ResourceGroup --location $Location --output none
if ($LASTEXITCODE -ne 0) { throw 'Azure resource group creation failed.' }

$repositoryParts = $Repository.Split('/', 2)
if ($repositoryParts.Count -ne 2) { throw 'Repository must use owner/name format.' }

Write-Host 'Deploying the free-tier App Service and GitHub OIDC identity...'
$deploymentJson = az deployment group create `
    --resource-group $ResourceGroup `
    --template-file (Join-Path $PSScriptRoot '..\infra\main.bicep') `
    --parameters githubOwner=$($repositoryParts[0]) githubRepository=$($repositoryParts[1]) `
    --query properties.outputs `
    --output json `
    --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Azure infrastructure deployment failed.' }
$outputs = $deploymentJson | ConvertFrom-Json

function Set-RepositorySecret([string]$Name, [string]$Value) {
    $Value | gh secret set $Name --repo $Repository
    if ($LASTEXITCODE -ne 0) { throw "Could not set GitHub secret $Name." }
}

Write-Host 'Connecting GitHub Actions to Azure...'
Set-RepositorySecret 'AZURE_CLIENT_ID' $outputs.azureClientId.value
Set-RepositorySecret 'AZURE_TENANT_ID' $outputs.azureTenantId.value
Set-RepositorySecret 'AZURE_SUBSCRIPTION_ID' $outputs.azureSubscriptionId.value

gh variable set AZURE_WEBAPP_NAME --body $outputs.webAppName.value --repo $Repository
if ($LASTEXITCODE -ne 0) { throw 'Could not set the GitHub web app variable.' }

Write-Host 'Starting the first Azure deployment workflow...'
gh workflow run deploy-azure.yml --repo $Repository --ref main
if ($LASTEXITCODE -ne 0) { throw 'Could not start the GitHub Actions workflow.' }

Write-Host ''
Write-Host "Azure app: $($outputs.webAppUrl.value)"
Write-Host "Workflow: https://github.com/$Repository/actions"
Write-Host 'The first deployment usually takes a few minutes.'
