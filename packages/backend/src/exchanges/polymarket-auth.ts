import { privateKeyToAccount } from 'viem/accounts'
import { rGet, rSet, decrypt, encrypt } from '../db/redis.js'
import { config } from '../config.js'

const CLOB = config.polymarket.clobHost

const CLOB_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137,
} as const

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
} as const

export interface ApiCredentials {
  apiKey: string
  secret: string
  passphrase: string
  address: string
}

// Fetch the CLOB server timestamp (GET /time returns a plain Unix integer)
async function getServerTimestamp(): Promise<string> {
  const res = await fetch(`${CLOB}/time`)
  if (!res.ok) throw new Error(`Failed to get CLOB timestamp: ${res.status}`)
  const text = await res.text()
  // Response is a plain integer string, e.g. "1779188153"
  return text.trim()
}

// Build L1 headers via EIP-712 signature
async function buildL1Headers(
  privKey: string,
  nonce = 0,
): Promise<{ headers: Record<string, string>; address: string; timestamp: string }> {
  const account = privateKeyToAccount(privKey as `0x${string}`)
  const timestamp = await getServerTimestamp()

  const signature = await account.signTypedData({
    domain: CLOB_AUTH_DOMAIN,
    types: CLOB_AUTH_TYPES,
    primaryType: 'ClobAuth',
    message: {
      address: account.address,
      timestamp,
      nonce: BigInt(nonce),
      message: 'This message attests that I control the given wallet',
    },
  })

  return {
    address: account.address,
    timestamp,
    headers: {
      'Content-Type': 'application/json',
      POLY_ADDRESS: account.address,
      POLY_SIGNATURE: signature,
      POLY_TIMESTAMP: timestamp,
      POLY_NONCE: String(nonce),
    },
  }
}

// POST /auth/api-key — creates a NEW set of API credentials
export async function createApiKey(privKey: string, nonce = 0): Promise<ApiCredentials> {
  const { headers, address } = await buildL1Headers(privKey, nonce)

  const res = await fetch(`${CLOB}/auth/api-key`, {
    method: 'POST',
    headers,
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Polymarket create-api-key failed (${res.status}): ${body}`)
  }

  const data = await res.json() as { apiKey: string; secret: string; passphrase: string }
  return { ...data, address }
}

// GET /auth/derive-api-key — derives EXISTING credentials (same nonce = same key)
export async function deriveApiKey(privKey: string, nonce = 0): Promise<ApiCredentials> {
  const { headers, address } = await buildL1Headers(privKey, nonce)

  const res = await fetch(`${CLOB}/auth/derive-api-key`, {
    method: 'GET',
    headers,
  })

  if (!res.ok) {
    const body = await res.text()
    // If no key exists yet for this nonce, fall back to create
    if (res.status === 404) {
      return createApiKey(privKey, nonce)
    }
    throw new Error(`Polymarket derive-api-key failed (${res.status}): ${body}`)
  }

  const data = await res.json() as { apiKey: string; secret: string; passphrase: string }
  return { ...data, address }
}

// Convenience: derive credentials from stored encrypted private key, save to Redis
export async function deriveAndSaveCredentials(nonce = 0): Promise<{ address: string; apiKey: string }> {
  const walletRaw = await rGet('poly:settings:wallets')
  if (!walletRaw) throw new Error('No Polymarket private key stored. Add it in Settings → Wallet Private Keys first.')

  const wallets = JSON.parse(decrypt(walletRaw)) as { polymarketPrivKey?: string }
  if (!wallets.polymarketPrivKey) throw new Error('Polymarket private key not set in wallet settings.')

  const creds = await deriveApiKey(wallets.polymarketPrivKey, nonce)

  // Save credentials encrypted
  await rSet(
    'poly:settings:polymarket',
    await encrypt(JSON.stringify({ apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase })),
  )

  // Cache the signer address separately for UI display
  await rSet('poly:settings:polymarket:address', creds.address)

  return { address: creds.address, apiKey: creds.apiKey }
}

export async function getSignerAddress(): Promise<string | null> {
  return rGet('poly:settings:polymarket:address')
}
