import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { HOME_CHANGED } from "./dispatch-client";

// Static wiring guards, not native TLS execution. Keep the native-runtime
// coverage gap explicit until device handshake tests run on both platforms.
it("iOS cancels a missing or different leaf pin without default trust handling", () => {
  const source = readFileSync(
    new URL("../modules/ardurbot-devices/ios/ArdurBotDevicesModule.swift", import.meta.url),
    "utf8",
  );
  const challenge = source.slice(
    source.indexOf("didReceive challenge:"),
    source.indexOf("willPerformHTTPRedirection"),
  );
  expect(challenge).not.toContain("performDefaultHandling");
  expect(challenge).toContain(
    "hexDigest(SecCertificateCopyData(cert) as Data) == fingerprint else",
  );
  expect(challenge).toMatch(
    /changedIdentity = true\s+completionHandler\(\.cancelAuthenticationChallenge, nil\); return/,
  );
  expect(challenge.indexOf("cancelAuthenticationChallenge")).toBeLessThan(
    challenge.indexOf("useCredential"),
  );
  expect(challenge).toContain("SecTrustSetAnchorCertificatesOnly(trust, true)");
  expect(challenge).toContain("SecTrustEvaluateWithError(trust, nil)");
  expect(source).toContain(HOME_CHANGED);
  expect(source).toContain("if changedIdentity || error != nil");
});

it("Android refuses a missing or different leaf pin and never delegates to system trust", () => {
  const source = readFileSync(
    new URL(
      "../modules/ardurbot-devices/android/src/main/java/ai/ardur/bot/devices/ArdurBotDevicesModule.kt",
      import.meta.url,
    ),
    "utf8",
  );
  const request = source.slice(
    source.indexOf('AsyncFunction("request")'),
    source.indexOf('AsyncFunction("scanQr")'),
  );
  expect(request).not.toContain("systemTrust");
  expect(request).not.toContain("TrustManagerFactory");
  expect(request).not.toContain("getDefaultHostnameVerifier");
  expect(request).toContain("if (chain.isEmpty() || digest(chain[0].encoded) != fingerprint)");
  expect(request).toContain(`throw CertificateException("${HOME_CHANGED}")`);
  expect(request).toMatch(
    /chain\[0\]\.checkValidity\(\); chain\[0\]\.verify\(chain\[0\]\.publicKey\)\s+pinned = true/,
  );
  expect(request).toContain("HostnameVerifier { _, _ -> pinned }");
  expect(request).toContain("connection.instanceFollowRedirects = false");
});
