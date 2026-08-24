// Provisions the Azure resources for Guess Party's first production deployment:
// App Service Plan (Linux) + Web App, Communication Services + Email (Azure-managed domain),
// Log Analytics + Application Insights, wired together via App Settings.
targetScope = 'resourceGroup'

@description('Base name used to derive resource names (must be globally unique for the web app).')
param appName string = 'guess-party'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('App Service Plan SKU. B1 minimum for Always On + reliable WebSockets.')
param appServicePlanSku string = 'B1'

@description('Public origin of the app once deployed, e.g. https://guess-party.azurewebsites.net')
param appOrigin string

@description('Monthly cost budget in USD; triggers email alerts at 80% and 100%.')
param monthlyBudgetAmount int = 25

@description('Email address to notify when the budget threshold is hit.')
param budgetAlertEmail string

@description('Comma-separated admin emails granted access to the question gallery (set independently from the deployed code, so it is never overwritten by a redeploy).')
@secure()
param adminEmails string = ''

@description('First day of the current month, used as the budget start date. Do not override.')
param budgetStartDate string = utcNow('yyyy-MM-01')

var webAppName = '${appName}-${uniqueString(resourceGroup().id)}'
var planName = '${appName}-plan'
var acsName = '${appName}-acs'
var emailServiceName = '${appName}-email'
var logAnalyticsName = '${appName}-logs'
var appInsightsName = '${appName}-insights'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
  }
}

resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: emailServiceName
  location: 'global'
  properties: {
    dataLocation: 'United States'
  }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
  }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: acsName
  location: 'global'
  properties: {
    dataLocation: 'United States'
    linkedDomains: [
      emailDomain.id
    ]
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: appServicePlanSku
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      alwaysOn: appServicePlanSku != 'F1' // Always On isn't supported on the Free tier
      webSocketsEnabled: true
      healthCheckPath: '/health'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'APP_ORIGIN', value: appOrigin }
        { name: 'GUESS_PARTY_DATA_DIR', value: '/home/data' }
        { name: 'ADMIN_EMAILS', value: adminEmails }
        { name: 'ACS_CONNECTION_STRING', value: acs.listKeys().primaryConnectionString }
        // Azure-managed domain's actual sender address is only known after provisioning; deploy.ps1 sets this after the fact.
        { name: 'ACS_SENDER_ADDRESS', value: '' }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsights.properties.ConnectionString }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '0' }
      ]
    }
  }
}

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: '${appName}-monthly-budget'
  properties: {
    category: 'Cost'
    amount: monthlyBudgetAmount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${budgetStartDate}T00:00:00Z'
    }
    notifications: {
      actualAt80Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        contactEmails: [
          budgetAlertEmail
        ]
        thresholdType: 'Actual'
      }
      actualAt100Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        contactEmails: [
          budgetAlertEmail
        ]
        thresholdType: 'Actual'
      }
    }
  }
}

output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output emailServiceName string = emailService.name
output emailDomainName string = emailDomain.name
