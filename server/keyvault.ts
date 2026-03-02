import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential, ClientSecretCredential } from '@azure/identity';
import { log } from './index';

const secretCache = new Map<string, string>();
let kvClient: SecretClient | null = null;
let kvInitAttempted = false;

function getKeyVaultClient(): SecretClient | null {
  if (kvClient) return kvClient;
  if (kvInitAttempted) return null;
  kvInitAttempted = true;

  const vaultUrl = process.env.AZURE_KEYVAULT_URL || process.env.KEY_VAULT_URL;
  if (!vaultUrl) {
    log('[keyvault] Key Vault not configured (set AZURE_KEYVAULT_URL or KEY_VAULT_URL)', 'keyvault');
    return null;
  }

  const tenantId = process.env.AZURE_TENANT_ID || process.env.KEY_VAULT_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID || process.env.KEY_VAULT_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET || process.env.KEY_VAULT_CLIENT_SECRET;

  let credential;
  if (tenantId && clientId && clientSecret) {
    credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    log(`[keyvault] Using ClientSecretCredential for ${vaultUrl}`, 'keyvault');
  } else {
    credential = new DefaultAzureCredential();
    log(`[keyvault] Using DefaultAzureCredential (managed identity) for ${vaultUrl}`, 'keyvault');
  }

  kvClient = new SecretClient(vaultUrl, credential);
  return kvClient;
}

export async function getSecretFromKeyVault(secretName: string): Promise<string | null> {
  const cached = secretCache.get(secretName);
  if (cached) return cached;

  const client = getKeyVaultClient();
  if (!client) return null;

  try {
    const secret = await client.getSecret(secretName);
    if (secret.value) {
      secretCache.set(secretName, secret.value);
      log(`[keyvault] Retrieved secret '${secretName}'`, 'keyvault');
      return secret.value;
    }
    log(`[keyvault] Secret '${secretName}' found but has no value`, 'keyvault');
    return null;
  } catch (err: any) {
    log(`[keyvault] Lookup failed for '${secretName}': ${err.message}`, 'keyvault');
    return null;
  }
}
