# Azure deployment

The project deploys as an executable Java 21 JAR to Azure App Service. The Bicep template creates:

- a Linux App Service plan using the free `F1` SKU;
- a Java 21 web app with HTTPS-only traffic;
- persistent experiment storage under `/home/data/probability-field-lab`;
- a user-assigned Azure identity with a GitHub OIDC credential restricted to this repository's stable owner/repository IDs and `main` branch;
- a role assignment scoped to the web app.

No Azure client secret or publish profile is stored in GitHub.

## One-time setup

Run these commands in PowerShell. Azure sign-in is the only interactive step.

```powershell
winget install --exact --id Microsoft.AzureCLI --accept-package-agreements --accept-source-agreements
```

Close and reopen PowerShell so `az` is available, then run:

```powershell
az login
az account list --output table
az account set --subscription "YOUR AZURE FOR STUDENTS SUBSCRIPTION NAME OR ID"
Set-Location "C:\Users\osami\OneDrive\Documents\codex erp sales mcp server\prob experiment"
.\scripts\bootstrap-azure.ps1
```

The bootstrap script creates the Azure resources, stores the three OIDC identifiers as GitHub Actions secrets, sets the generated app name as a repository variable, and starts the first deployment.

## Normal deployments

Every push to `main` builds, smoke-tests, and deploys the app. You can also start it manually:

```powershell
gh workflow run deploy-azure.yml --repo osAlhaddad1/probability-field-lab --ref main
gh run watch --repo osAlhaddad1/probability-field-lab
```

## Optional paid tier

The default `F1` plan can sleep when idle and has daily compute limits. To use a basic paid plan, redeploy the template with `B1`:

```powershell
az deployment group create `
  --resource-group probability-field-lab-rg `
  --template-file .\infra\main.bicep `
  --parameters skuName=B1 skuTier=Basic
```

## Remove Azure resources

This deletes the web app and its saved Azure experiment data:

```powershell
az group delete --name probability-field-lab-rg --yes
```
