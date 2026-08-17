@description('Azure region used by the App Service plan and web app.')
param location string = resourceGroup().location

@description('GitHub account that owns the deployment repository.')
param githubOwner string = 'osAlhaddad1'

@description('GitHub repository trusted to deploy through OpenID Connect.')
param githubRepository string = 'probability-field-lab'

@description('Git branch trusted to deploy through OpenID Connect.')
param githubBranch string = 'main'

@description('App Service plan SKU. F1 stays inside the free tier where available.')
param skuName string = 'F1'

@description('App Service plan tier matching skuName.')
param skuTier string = 'Free'

var suffix = toLower(uniqueString(subscription().subscriptionId, resourceGroup().id))
var appName = 'prob-field-${suffix}'
var planName = 'prob-field-plan-${suffix}'
var deployIdentityName = 'prob-field-github-${suffix}'
var contributorRoleDefinitionId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b24988ac-6180-42a0-ab88-20f7382dd24c'
)

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: skuName
    tier: skuTier
    size: skuName
    capacity: 1
  }
  properties: {
    reserved: true
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'JAVA|21-java21'
      alwaysOn: skuName != 'F1' && skuName != 'D1'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        {
          name: 'EXPERIMENT_DATA_ROOT'
          value: '/home/data/probability-field-lab'
        }
        {
          name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE'
          value: 'true'
        }
      ]
    }
  }
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: deployIdentityName
  location: location
}

resource githubMainCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-main'
  properties: {
    audiences: [
      'api://AzureADTokenExchange'
    ]
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubOwner}/${githubRepository}:ref:refs/heads/${githubBranch}'
  }
}

resource deploymentRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(webApp.id, deployIdentity.id, contributorRoleDefinitionId)
  scope: webApp
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleDefinitionId
  }
}

output webAppName string = webApp.name
output webAppUrl string = 'https://${webApp.properties.defaultHostName}'
output azureClientId string = deployIdentity.properties.clientId
output azureTenantId string = subscription().tenantId
output azureSubscriptionId string = subscription().subscriptionId
