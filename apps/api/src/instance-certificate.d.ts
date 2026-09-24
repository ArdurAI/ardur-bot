export function generateInstanceCertificate(): Promise<{
  publicKey: string;
  privateKey: string;
  certificate: string;
}>;
