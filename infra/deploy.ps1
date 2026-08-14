<#
Provisions Azure resources for Guess Party and prints the values needed to finish setup.
Run this yourself after `az login` — it uses your Azure identity/subscription and creates billable resources.

Usage:
  ./infra/deploy.ps1 -ResourceGroup rg-guess-party-prod -Location eastus -AppName guess-party -BudgetAlertEmail you@example.com
#>
param(
  [string]$ResourceGroup = "rg-guess-party-prod",
  [string]$Location = "eastus",
  [string]$AppName = "guess-party",
  [Parameter(Mandatory = $true)][string]$BudgetAlertEmail,
  [int]$MonthlyBudgetAmount = 25,
  [string]$AppServicePlanSku = "B1"
)

$ErrorActionPreference = "Stop"

function Invoke-AzCommand {
  # Native `az` failures don't stop the script via $ErrorActionPreference, so check the exit code explicitly.
  param([Parameter(Mandatory = $true)][string]$Description)
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed (az exit code $LASTEXITCODE). See the error above."
  }
}

Write-Host "Checking Azure CLI login..."
az account show --only-show-errors 1>$null 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "Not logged in to Azure CLI. Run 'az login' first, then re-run this script."
}

Write-Host "Ensuring the 'communication' CLI extension is installed (avoids an interactive prompt polluting JSON output)..."
az config set extension.use_dynamic_install=yes_without_prompt --only-show-errors | Out-Null
az extension add --name communication --only-show-errors 2>$null

Write-Host "Creating resource group $ResourceGroup in $Location..."
az group create --name $ResourceGroup --location $Location --only-show-errors | Out-Null
Invoke-AzCommand "Resource group creation"

Write-Host "Deploying App Service, Communication Services, App Insights via Bicep..."
$deployment = az deployment group create `
  --resource-group $ResourceGroup `
  --template-file "$PSScriptRoot/main.bicep" `
  --parameters appName=$AppName appOrigin="https://placeholder.azurewebsites.net" `
    budgetAlertEmail=$BudgetAlertEmail monthlyBudgetAmount=$MonthlyBudgetAmount appServicePlanSku=$AppServicePlanSku `
  --only-show-errors `
  | ConvertFrom-Json
Invoke-AzCommand "Bicep deployment"

$webAppName = $deployment.properties.outputs.webAppName.value
$webAppUrl = $deployment.properties.outputs.webAppUrl.value
$emailServiceName = $deployment.properties.outputs.emailServiceName.value
$emailDomainName = $deployment.properties.outputs.emailDomainName.value

Write-Host "`nWeb app created: $webAppName"
Write-Host "URL: $webAppUrl"

Write-Host "`nFixing APP_ORIGIN to the real URL now that it's known..."
az webapp config appsettings set --resource-group $ResourceGroup --name $webAppName `
  --settings APP_ORIGIN=$webAppUrl --only-show-errors | Out-Null
Invoke-AzCommand "Setting APP_ORIGIN"

Write-Host "`nLooking up the Azure-managed email sender domain (can take a minute to provision)..."
$domain = az communication email domain show --resource-group $ResourceGroup `
  --email-service-name $emailServiceName --name $emailDomainName --only-show-errors | ConvertFrom-Json
Invoke-AzCommand "Looking up email domain"
$senderAddress = "DoNotReply@$($domain.properties.mailFromSenderDomain)"

Write-Host "Setting ACS_SENDER_ADDRESS = $senderAddress"
az webapp config appsettings set --resource-group $ResourceGroup --name $webAppName `
  --settings ACS_SENDER_ADDRESS=$senderAddress --only-show-errors | Out-Null
Invoke-AzCommand "Setting ACS_SENDER_ADDRESS"

Write-Host "`n--- Next: set up GitHub Actions OIDC federated login ---"
Write-Host "Run infra/setup-github-oidc.ps1 -ResourceGroup $ResourceGroup -AppName $AppName -GitHubOrg <org> -GitHubRepo <repo>"
Write-Host "`nDone. Web app: $webAppUrl"
