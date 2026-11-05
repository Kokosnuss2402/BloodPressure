// End-to-end encryption for the cloud backup. Records are encrypted in the
// browser with AES-256-GCM; the key is derived from the user's backup
// passphrase with PBKDF2-SHA-256. The server only ever stores ciphertext.
//
// Each ciphertext is bound to its record id (AES-GCM additional data), so the
// server cannot swap the contents of two records.

export const KDF_ITERATIONS = 600000;
const CHECK_PLAINTEXT = 'vitals-log-key-check-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export const randomSalt = () => toB64(crypto.getRandomValues(new Uint8Array(16)));

/** Derive a non-extractable AES-GCM key from a passphrase. */
export async function deriveKey(passphrase, saltB64, iterations = KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a JSON value; `aad` (e.g. the record id) must match on decryption. */
export async function encryptJSON(key, value, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}

export async function decryptJSON(key, box, aad) {
  if (!box || box.v !== 1) throw new Error('Unsupported encryption format');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(box.iv), additionalData: enc.encode(aad) },
    key,
    fromB64(box.ct),
  );
  return JSON.parse(dec.decode(pt));
}

/** A small encrypted value stored with the backup to detect a wrong passphrase. */
export const makeCheck = (key) => encryptJSON(key, CHECK_PLAINTEXT, 'key-check');

export async function verifyCheck(key, check) {
  try {
    return (await decryptJSON(key, check, 'key-check')) === CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}
