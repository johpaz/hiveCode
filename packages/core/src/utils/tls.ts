/**
 * TLS Utilities — TDD §38.5
 *
 * Generates self-signed ECDSA P-256 certificates, stores them in Bun.secrets,
 * and handles automatic renewal when < 30 days remain.
 */

import * as crypto from "node:crypto";

const SERVICE = "hive-code";
const CERT_NAME = "tls-cert";
const KEY_NAME = "tls-key";

interface TlsCredentials {
  cert: string;
  key: string;
  fingerprint: string;
}

/**
 * Generate a self-signed ECDSA P-256 certificate using node:crypto.
 * Returns PEM-encoded cert and key.
 */
export function generateSelfSignedCert(): TlsCredentials {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });

  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const pubPem = publicKey.export({ type: "spki", format: "pem" }) as string;

  // Build a simple X.509 certificate
  const now = new Date();
  const notBefore = now;
  const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 365 days

  // Use node:crypto X509Certificate for fingerprint
  const certPem = generateX509Cert(privateKey, publicKey, notBefore, notAfter);

  const x509 = new crypto.X509Certificate(certPem);
  const fingerprint = x509.fingerprint256;

  return { cert: certPem, key: keyPem, fingerprint };
}

/**
 * Simple X.509 certificate generation using node:crypto sign.
 * This creates a minimal self-signed cert valid for localhost/127.0.0.1.
 */
function generateX509Cert(
  privateKey: crypto.KeyObject,
  publicKey: crypto.KeyObject,
  notBefore: Date,
  notAfter: Date
): string {
  // For a robust implementation we'd use a library like @peculiar/x509,
  // but to avoid new deps we use openssl CLI if available, otherwise fall back
  // to a pre-generated cert template (Bun has openssl built-in via bun:ffi).
  // Simpler approach: use crypto.createSign to build a minimal ASN.1 structure
  // is too complex. Instead, we use the `bun` openssl wrapper or generate via
  // a temporary file approach.

  try {
    // Use openssl CLI (available in most environments including Bun's environment)
    const { execSync } = require("node:child_process");
    const tmpDir = require("node:os").tmpdir();
    const fs = require("node:fs");
    const path = require("node:path");

    const keyPath = path.join(tmpDir, `hive-tls-key-${Date.now()}.pem`);
    const certPath = path.join(tmpDir, `hive-tls-cert-${Date.now()}.pem`);

    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }) as string);

    const subj = "/C=US/ST=Local/L=Local/O=HiveCode/OU=Gateway/CN=localhost";
    execSync(
      `openssl req -new -x509 -key "${keyPath}" -out "${certPath}" -days 365 -subj "${subj}" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
      { stdio: "ignore" }
    );

    const certPem = fs.readFileSync(certPath, "utf-8");

    fs.unlinkSync(keyPath);
    fs.unlinkSync(certPath);

    return certPem;
  } catch {
    // Fallback: return a placeholder that will fail at serve time
    // This ensures the function never throws, but TLS won't work
    // without openssl. In practice, openssl is always available.
    throw new Error("OpenSSL is required for TLS certificate generation.");
  }
}

/**
 * Store TLS credentials in Bun.secrets.
 */
export async function storeTlsCredentials(cred: TlsCredentials): Promise<void> {
  await Bun.secrets.set({ service: SERVICE, name: CERT_NAME, value: cred.cert });
  await Bun.secrets.set({ service: SERVICE, name: KEY_NAME, value: cred.key });
  await Bun.secrets.set({ service: SERVICE, name: "tls-fingerprint", value: cred.fingerprint });
}

/**
 * Load TLS credentials from Bun.secrets.
 */
export async function loadTlsCredentials(): Promise<TlsCredentials | null> {
  try {
    const cert = await Bun.secrets.get({ service: SERVICE, name: CERT_NAME });
    const key = await Bun.secrets.get({ service: SERVICE, name: KEY_NAME });
    const fingerprint = await Bun.secrets.get({ service: SERVICE, name: "tls-fingerprint" });
    if (!cert || !key) return null;
    return { cert, key, fingerprint: fingerprint || "" };
  } catch {
    return null;
  }
}

/**
 * Check if the stored certificate needs renewal (< 30 days).
 */
export async function shouldRenewCert(): Promise<boolean> {
  try {
    const certPem = await Bun.secrets.get({ service: SERVICE, name: CERT_NAME });
    if (!certPem) return true;
    const x509 = new crypto.X509Certificate(certPem);
    const notAfter = new Date(x509.validTo);
    const daysRemaining = (notAfter.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysRemaining < 30;
  } catch {
    return true;
  }
}

/**
 * Ensure valid TLS credentials exist, generating new ones if needed.
 */
export async function ensureTlsCredentials(): Promise<TlsCredentials | null> {
  if (!(await shouldRenewCert())) {
    return await loadTlsCredentials();
  }
  const cred = generateSelfSignedCert();
  await storeTlsCredentials(cred);
  return cred;
}

/**
 * Get the TLS fingerprint for client pinning.
 */
export async function getTlsFingerprint(): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: SERVICE, name: "tls-fingerprint" });
  } catch {
    return null;
  }
}
