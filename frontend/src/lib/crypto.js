/**
 * AES-256-GCM encryption layer for InjShield.
 * All crypto runs client-side via the Web Crypto API — keys never leave the browser.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── AES-256-GCM (symmetric, for own balance) ────────────────────────────────

async function importAESKey(keyHex) {
  const raw = hexToBytes(keyHex);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Derive a deterministic AES-256 balance-encryption key from a wallet signature.
 * Signing this fixed message is non-destructive and produces the same key every time,
 * so users never lose access to funds even if localStorage is cleared.
 */
export async function deriveKeyFromWallet(signer) {
  const message =
    "InjShield: Authorize balance key derivation v1\n\n" +
    "Signing this generates your private encryption key. It never leaves your browser.";
  const signature = await signer.signMessage(message);
  // strip 0x, hash the 65-byte signature to get exactly 32 bytes
  const sigBytes = hexToBytes(signature.slice(2));
  const hashBuf = await crypto.subtle.digest("SHA-256", sigBytes);
  return bytesToHex(new Uint8Array(hashBuf));
}

/** Kept for backwards compat / manual override */
export function generateKeyHex() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

export async function encrypt(plaintext, keyHex) {
  const key = await importAESKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    encoded
  );

  const cipherBytes = new Uint8Array(cipherBuf);
  // Web Crypto appends the 16-byte auth tag to the ciphertext
  const data = cipherBytes.slice(0, cipherBytes.length - 16);
  const tag = cipherBytes.slice(cipherBytes.length - 16);

  return JSON.stringify({
    iv: bytesToHex(iv),
    data: bytesToHex(data),
    tag: bytesToHex(tag),
  });
}

export async function decrypt(payload, keyHex) {
  const { iv, data, tag } = JSON.parse(payload);
  const key = await importAESKey(keyHex);

  const cipherBytes = hexToBytes(data);
  const tagBytes = hexToBytes(tag);
  const combined = new Uint8Array(cipherBytes.length + tagBytes.length);
  combined.set(cipherBytes);
  combined.set(tagBytes, cipherBytes.length);

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(iv), tagLength: 128 },
    key,
    combined
  );

  return new TextDecoder().decode(plainBuf);
}

// ─── Encrypted localStorage helpers ──────────────────────────────────────────

/**
 * Encrypt arbitrary JSON with the AES balance key before writing to localStorage.
 * Protects the ECDH private key JWK from plain-text exposure in DevTools.
 */
export async function encryptToStorage(obj, keyHex) {
  return encrypt(JSON.stringify(obj), keyHex);
}

export async function decryptFromStorage(ciphertext, keyHex) {
  return JSON.parse(await decrypt(ciphertext, keyHex));
}

// ─── ECDH P-256 (asymmetric, for receiving private transfers) ─────────────────

/**
 * Generate an ECDH P-256 key pair for receiving private transfers.
 *
 * Store privateKeyJwk in localStorage ("injshield_ecdh_priv").
 * Register publicKeyHex on-chain so senders can encrypt for you.
 */
export async function generateECDHKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKeyHex: bytesToHex(new Uint8Array(publicKeyRaw)), // 65-byte uncompressed point
    privateKeyJwk,
  };
}

async function importECDHPrivateKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"]
  );
}

async function importECDHPublicKey(hex) {
  return crypto.subtle.importKey(
    "raw",
    hexToBytes(hex),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
}

async function deriveSharedAESKey(myPrivKeyJwk, theirPubKeyHex) {
  const myPrivKey = await importECDHPrivateKey(myPrivKeyJwk);
  const theirPubKey = await importECDHPublicKey(theirPubKeyHex);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: theirPubKey },
    myPrivKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Encrypt a transfer amount for a recipient using an ephemeral ECDH key pair.
 *
 * An ephemeral sender key is generated per transfer so no two transfers share
 * the same ECDH secret — forward secrecy at the transfer level.
 *
 * Returns { ciphertext: string, ephemeralPubKeyHex: string }.
 * Both must be stored on-chain so the receiver can reconstruct the shared secret.
 */
export async function encryptForRecipient(plaintext, recipientPublicKeyHex) {
  const { publicKeyHex: ephemeralPubKeyHex, privateKeyJwk: ephemeralPrivJwk } =
    await generateECDHKeyPair();

  const sharedKey = await deriveSharedAESKey(ephemeralPrivJwk, recipientPublicKeyHex);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    sharedKey,
    encoded
  );

  const cipherBytes = new Uint8Array(cipherBuf);
  const data = cipherBytes.slice(0, cipherBytes.length - 16);
  const tag = cipherBytes.slice(cipherBytes.length - 16);

  return {
    ciphertext: JSON.stringify({
      iv: bytesToHex(iv),
      data: bytesToHex(data),
      tag: bytesToHex(tag),
    }),
    ephemeralPubKeyHex,
  };
}

/**
 * Decrypt a pending transfer.
 * @param {string} ciphertext          - JSON string from encryptForRecipient
 * @param {string} ephemeralSenderPubHex - 65-byte hex public key stored on-chain
 * @param {object} myPrivateKeyJwk     - receiver's ECDH private key (from localStorage)
 */
export async function decryptFromSender(ciphertext, ephemeralSenderPubHex, myPrivateKeyJwk) {
  const sharedKey = await deriveSharedAESKey(myPrivateKeyJwk, ephemeralSenderPubHex);
  const { iv, data, tag } = JSON.parse(ciphertext);

  const cipherBytes = hexToBytes(data);
  const tagBytes = hexToBytes(tag);
  const combined = new Uint8Array(cipherBytes.length + tagBytes.length);
  combined.set(cipherBytes);
  combined.set(tagBytes, cipherBytes.length);

  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: hexToBytes(iv), tagLength: 128 },
    sharedKey,
    combined
  );

  return new TextDecoder().decode(plainBuf);
}
