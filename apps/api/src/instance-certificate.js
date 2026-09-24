import { generateKeyPair, randomBytes, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import forge from "node-forge";

/** Forge supplies certificate encoding; key generation and live TLS use Node crypto. */
export async function generateInstanceCertificate() {
  const keys = await promisify(generateKeyPair)("rsa", {
    modulusLength: 3072,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = `01${randomBytes(16).toString("hex")}`;
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 60 * 60_000);
  const subject = [{ name: "commonName", value: "Ardur Bot Home" }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
  ]);
  certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate);
  const parsed = new X509Certificate(cert);
  if (!parsed.verify(parsed.publicKey)) throw new Error("Home certificate could not be verified.");
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, certificate: cert };
}
