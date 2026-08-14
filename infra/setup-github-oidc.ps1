<#
Creates an Azure AD App Registration + federated credential so GitHub Actions can deploy
via OIDC (no long-lived secrets), and assigns it Contributor on the resource group.
Run this yourself after ./infra/deploy.ps1 — it modifies your Azure AD tenant.

Usage:
  ./infra/setup-github-oidc.ps1 -ResourceGroup rg-guess-party-prod -AppName guess-party `
    -GitHubOrg your-github-username -GitHubRepo guess-party -GitHubBranch main
#>
param(
  [Parameter(Mandatory = $true)][string]$ResourceGroup,
  [string]$AppName = "guess-party",
  [Parameter(Mandatory = $true)][string]$GitHubOrg,
  [Parameter(Mandatory = $true)][string]$GitHubRepo,
  [string]$GitHubBranch = "main"
)

$ErrorActionPreference = "Stop"

$subscriptionId = az account show --query id -o tsv
$tenantId = az account show --query tenantId -o tsv

Write-Host "Creating Azure AD App Registration '$AppName-deploy'..."
$appId = az ad app create --display-name "$AppName-deploy" --query appId -o tsv

Write-Host "Creating service principal..."
az ad sp create --id $appId | Out-Null

Write-Host "Assigning Contributor role scoped to resource group $ResourceGroup..."
$rgId = az group show --name $ResourceGroup --query id -o tsv
az role assignment create --assignee $appId --role Contributor --scope $rgId | Out-Null

Write-Host "Creating federated credential for GitHub Actions (branch: $GitHubBranch)..."
$credentialJson = @{
  name        = "github-actions-$GitHubBranch"
  issuer      = "https://token.actions.githubusercontent.com"
  subject     = "repo:$GitHubOrg/${GitHubRepo}:ref:refs/heads/$GitHubBranch"
  description = "GitHub Actions OIDC for $GitHubOrg/$GitHubRepo ($GitHubBranch)"
  audiences   = @("api://AzureADTokenExchange")
} | ConvertTo-Json -Compress

$credentialJson | Out-File -FilePath "$env:TEMP\fed-cred.json" -Encoding utf8
az ad app federated-credential create --id $appId --parameters "$env:TEMP\fed-cred.json" | Out-Null

Write-Host "`n--- Add these as GitHub repository secrets (Settings > Secrets and variables > Actions) ---"
Write-Host "AZURE_CLIENT_ID       = $appId"
Write-Host "AZURE_TENANT_ID       = $tenantId"
Write-Host "AZURE_SUBSCRIPTION_ID = $subscriptionId"
Write-Host "`nAlso update AZURE_WEBAPP_NAME in .github/workflows/deploy.yml to match the deployed web app name."
