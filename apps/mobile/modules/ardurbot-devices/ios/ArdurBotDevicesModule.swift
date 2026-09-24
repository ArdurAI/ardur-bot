import ExpoModulesCore
import Security
import CryptoKit
import AVFoundation
import UIKit

private func deviceError(_ message: String) -> NSError {
  NSError(domain: "ArdurDevices", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
private func hexDigest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func keyTag(_ handle: String, _ presence: Bool) throws -> Data {
  guard handle.hasPrefix("ardur.dispatch."), handle.count < 100 else { throw deviceError("Pair this device again.") }
  return Data((handle + (presence ? ".presence" : ".request")).utf8)
}
private func loadKey(_ handle: String, _ presence: Bool) throws -> SecKey {
  let query: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: try keyTag(handle, presence),
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecReturnRef as String: true,
    kSecUseOperationPrompt as String: "Confirm on your phone"]
  var result: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let result else { throw deviceError("Unlock your phone and try again.") }
  return result as! SecKey
}
private func newKey(_ handle: String, _ presence: Bool) throws -> String {
  var error: Unmanaged<CFError>?
  let flags: SecAccessControlCreateFlags = presence ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
  guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &error) else { throw deviceError("Set a phone passcode before pairing.") }
  let attributes: [String: Any] = [kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeySizeInBits as String: 256,
    kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: true, kSecAttrApplicationTag as String: try keyTag(handle, presence), kSecAttrAccessControl as String: access]]
  guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error), let publicKey = SecKeyCopyPublicKey(key),
    let raw = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else { throw deviceError("This phone could not create a device key.") }
  // RFC 5480 SubjectPublicKeyInfo for a P-256 uncompressed point; no private key crosses the bridge.
  let prefix: [UInt8] = [0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,0x03,0x42,0x00]
  return (Data(prefix) + raw).base64EncodedString()
}
public final class ArdurBotDevicesModule: Module {
  private var scanner: QRScanner?
  public func definition() -> ModuleDefinition {
    Name("ArdurBotDevices")
    Function("nonce") { UUID().uuidString }
    AsyncFunction("createKeys") { () throws -> [String: String] in
      let handle = "ardur.dispatch." + UUID().uuidString
      let publicKey = try newKey(handle, false)
      let presence = try newKey(handle, true)
      return ["handle": handle, "publicKey": publicKey, "presencePublicKey": presence, "publicKeyFingerprint": hexDigest(Data(publicKey.utf8))]
    }
    AsyncFunction("sign") { (handle: String, message: String, presence: Bool) throws -> String in
      var error: Unmanaged<CFError>?
      guard message.utf8.count < 131072,
        let signature = SecKeyCreateSignature(try loadKey(handle, presence), .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error) as Data? else { throw deviceError("Confirm your presence and try again.") }
      return signature.base64EncodedString()
    }
    AsyncFunction("verifyHome") { (certificate: String, fingerprint: String, message: String, signature: String) -> Bool in
      guard let der = Data(base64Encoded: certificate), hexDigest(der) == fingerprint,
        let cert = SecCertificateCreateWithData(nil, der as CFData), let key = SecCertificateCopyKey(cert),
        let sig = Data(base64Encoded: signature) else { return false }
      return SecKeyVerifySignature(key, .rsaSignatureMessagePKCS1v15SHA256, Data(message.utf8) as CFData, sig as CFData, nil)
    }
    AsyncFunction("request") { (url: String, fingerprint: String, body: String, promise: Promise) in
      guard let target = URL(string: url), target.scheme == "https", target.user == nil, target.password == nil,
        target.query == nil, target.fragment == nil, target.path.hasPrefix("/device/"), body.utf8.count <= 131072 else {
        promise.reject("INVALID_HOME", "Choose an HTTPS home."); return
      }
      PinnedRequest(url: target, fingerprint: fingerprint, body: body, promise: promise).start()
    }
    AsyncFunction("scanQr") { (promise: Promise) in
      DispatchQueue.main.async {
        guard self.scanner == nil, let host = self.appContext?.utilities?.currentViewController() else { promise.reject("CAMERA", "Open the camera and try again."); return }
        let scanner = QRScanner { value in
          self.scanner = nil
          if let value { promise.resolve(value) } else { promise.reject("CAMERA", "Scan the pairing code again.") }
        }
        self.scanner = scanner
        host.present(scanner, animated: true)
      }
    }
  }
}

private final class PinnedRequest: NSObject, URLSessionDataDelegate {
  private let url: URL; private let fingerprint: String; private let body: String; private let promise: Promise
  private var session: URLSession?; private var data = Data(); private var status = 0; private var changedIdentity = false
  init(url: URL, fingerprint: String, body: String, promise: Promise) { self.url = url; self.fingerprint = fingerprint; self.body = body; self.promise = promise }
  func start() {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil; config.httpShouldSetCookies = false
    config.timeoutIntervalForRequest = 15; config.timeoutIntervalForResource = 20
    session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = Data(body.utf8)
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    session?.dataTask(with: request).resume()
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust,
      let cert = SecTrustGetCertificateAtIndex(trust, 0) else { completionHandler(.performDefaultHandling, nil); return }
    if hexDigest(SecCertificateCopyData(cert) as Data) == fingerprint {
      SecTrustSetPolicies(trust, SecPolicyCreateBasicX509())
      SecTrustSetAnchorCertificates(trust, [cert] as CFArray); SecTrustSetAnchorCertificatesOnly(trust, true)
      if SecTrustEvaluateWithError(trust, nil) { completionHandler(.useCredential, URLCredential(trust: trust)); return }
      completionHandler(.cancelAuthenticationChallenge, nil); return
    }
    // Public homes may terminate TLS at their own proxy; the signed home challenge still pins identity.
    changedIdentity = !SecTrustEvaluateWithError(trust, nil)
    completionHandler(.performDefaultHandling, nil)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    status = (response as? HTTPURLResponse)?.statusCode ?? 0
    completionHandler(response.expectedContentLength > 16 * 1024 * 1024 ? .cancel : .allow)
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
    if data.count + chunk.count > 16 * 1024 * 1024 { dataTask.cancel() } else { data.append(chunk) }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if error != nil { promise.reject(changedIdentity ? "HOME_CHANGED" : "HOME_UNREACHABLE", changedIdentity ? "This home's identity changed; pair your phone again." : "Home unreachable — check that Ardur Bot is running") }
    else { promise.resolve(["status": status, "body": String(data: data, encoding: .utf8) ?? ""]) }
    session.invalidateAndCancel(); self.session = nil
  }
}

private final class QRScanner: UIViewController, AVCaptureMetadataOutputObjectsDelegate, UIAdaptivePresentationControllerDelegate {
  private let capture = AVCaptureSession(); private var completion: ((String?) -> Void)?
  init(completion: @escaping (String?) -> Void) { self.completion = completion; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
  override func viewDidLoad() {
    super.viewDidLoad(); presentationController?.delegate = self
    let close = UIButton(type: .system); close.setTitle("Cancel", for: .normal); close.addTarget(self, action: #selector(cancel), for: .touchUpInside)
    close.frame = CGRect(x: 20, y: 30, width: 100, height: 48); view.addSubview(close)
    AVCaptureDevice.requestAccess(for: .video) { allowed in
      DispatchQueue.main.async {
        guard allowed, let camera = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: camera), self.capture.canAddInput(input) else { self.finish(nil); return }
        self.capture.addInput(input); let output = AVCaptureMetadataOutput()
        guard self.capture.canAddOutput(output) else { self.finish(nil); return }
        self.capture.addOutput(output); output.setMetadataObjectsDelegate(self, queue: .main); output.metadataObjectTypes = [.qr]
        let preview = AVCaptureVideoPreviewLayer(session: self.capture); preview.frame = self.view.bounds; preview.videoGravity = .resizeAspectFill
        self.view.layer.insertSublayer(preview, at: 0)
        DispatchQueue.global(qos: .userInitiated).async { self.capture.startRunning() }
      }
    }
  }
  @objc private func cancel() { finish(nil) }
  private func finish(_ value: String?) { guard let callback = completion else { return }; completion = nil; capture.stopRunning(); dismiss(animated: true) { callback(value) } }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }
  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
    if let code = metadataObjects.first as? AVMetadataMachineReadableCodeObject, let value = code.stringValue, value.utf8.count < 8192 { finish(value) }
  }
}
