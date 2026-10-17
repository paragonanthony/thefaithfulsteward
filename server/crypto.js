import crypto from 'node:crypto';

// Secrets at rest (bank access URLs, QuickBooks refresh tokens, Claude API keys) are encrypted with AES-256-GCM.
// The key comes from ENCRYPTION_KEY; PLAID_ENCRYPTION_KEY is still accepted (it was the original name).
const keyMaterials = () => [...new Set([process.env.ENCRYPTION_KEY, process.env.PLAID_ENCRYPTION_KEY].filter(Boolean))];
const toKey = (m) => crypto.createHash('sha256').update(String(m)).digest();

export const hasEncryptionKey = () => keyMaterials().length > 0;

export function encrypt(plain) {
  const [material] = keyMaterials();
  if (!material) throw new Error('ENCRYPTION_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', toKey(material), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Decrypt with whichever configured key encrypted the value. */
export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  for (const material of keyMaterials()) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', toKey(material), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    } catch { /* try the next key */ }
  }
  throw new Error('Could not decrypt a stored secret (has ENCRYPTION_KEY changed?)');
}
