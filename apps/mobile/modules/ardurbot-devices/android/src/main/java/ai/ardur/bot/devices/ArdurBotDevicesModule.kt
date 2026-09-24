package ai.ardur.bot.devices

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.google.zxing.integration.android.IntentIntegrator
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.UUID
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

private fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
private fun base64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)
private fun decode(text: String) = Base64.decode(text, Base64.DEFAULT)
private const val PRESENCE_REQUEST = 4813

class ArdurBotDevicesModule : Module() {
  private var presence: Triple<Promise, String, String>? = null
  private var scanner: Promise? = null
  private val keys: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun alias(handle: String, presence: Boolean): String {
    require(handle.startsWith("ardur.dispatch.") && handle.length < 100) { "Pair this device again." }
    return handle + if (presence) ".presence" else ".request"
  }
  private fun createKey(handle: String, presence: Boolean): String {
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    val builder = KeyGenParameterSpec.Builder(alias(handle, presence), KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256)
    if (presence) {
      builder.setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= 30) builder.setUserAuthenticationParameters(15, KeyProperties.AUTH_DEVICE_CREDENTIAL or KeyProperties.AUTH_BIOMETRIC_STRONG)
      else builder.setUserAuthenticationValidityDurationSeconds(15)
    }
    generator.initialize(builder.build())
    return base64(generator.generateKeyPair().public.encoded)
  }
  private fun sign(handle: String, message: String, presence: Boolean): String {
    require(message.toByteArray().size <= 131072) { "This request is too large." }
    val key = keys.getKey(alias(handle, presence), null) as java.security.PrivateKey
    val signer = Signature.getInstance("SHA256withECDSA"); signer.initSign(key); signer.update(message.toByteArray(Charsets.UTF_8))
    return base64(signer.sign())
  }
  override fun definition() = ModuleDefinition {
    Name("ArdurBotDevices")
    Function("nonce") { UUID.randomUUID().toString() }
    AsyncFunction("createKeys") {
      val context = requireNotNull(appContext.reactContext)
      val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      check(keyguard.isDeviceSecure) { "Set a phone passcode before pairing." }
      val handle = "ardur.dispatch." + UUID.randomUUID().toString()
      val publicKey = createKey(handle, false); val presenceKey = createKey(handle, true)
      mapOf("handle" to handle, "publicKey" to publicKey, "presencePublicKey" to presenceKey, "publicKeyFingerprint" to digest(publicKey.toByteArray()))
    }
    AsyncFunction("sign") { handle: String, message: String, needsPresence: Boolean, promise: Promise ->
      if (!needsPresence) {
        try { promise.resolve(sign(handle, message, false)) } catch (_: Exception) { promise.reject("KEY", "Unlock your phone and try again.", null) }
      } else {
        val activity = appContext.activityProvider?.currentActivity
        if (activity == null || presence != null) { promise.reject("PRESENCE", "Confirm your presence and try again.", null) }
        else {
          val keyguard = activity.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
          val intent = keyguard.createConfirmDeviceCredentialIntent("Confirm on your phone", "Allow this home action.")
          if (intent == null) promise.reject("PRESENCE", "Set a phone passcode before continuing.", null)
          else { presence = Triple(promise, handle, message); activity.runOnUiThread { activity.startActivityForResult(intent, PRESENCE_REQUEST) } }
        }
      }
    }
    AsyncFunction("verifyHome") { certificate: String, fingerprint: String, message: String, signature: String ->
      try {
        val der = decode(certificate)
        if (digest(der) != fingerprint) false
        else {
          val cert = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate
          val verifier = Signature.getInstance("SHA256withRSA"); verifier.initVerify(cert.publicKey); verifier.update(message.toByteArray(Charsets.UTF_8)); verifier.verify(decode(signature))
        }
      } catch (_: Exception) { false }
    }
    AsyncFunction("request") { url: String, fingerprint: String, body: String ->
      val target = URL(url)
      require(target.protocol == "https" && target.userInfo == null && target.query == null && target.ref == null && target.path.startsWith("/device/") && body.toByteArray().size <= 131072) { "Choose an HTTPS home." }
      val managerFactory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(null as KeyStore?) }
      val systemTrust = managerFactory.trustManagers.filterIsInstance<X509TrustManager>().first()
      var pinned = false
      val trust = object : X509TrustManager {
        override fun getAcceptedIssuers() = systemTrust.acceptedIssuers
        override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = systemTrust.checkClientTrusted(chain, authType)
        override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
          pinned = chain.isNotEmpty() && digest(chain[0].encoded) == fingerprint
          if (pinned) { chain[0].checkValidity(); chain[0].verify(chain[0].publicKey) }
          else systemTrust.checkServerTrusted(chain, authType)
        }
      }
      val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
      val connection = target.openConnection() as HttpsURLConnection
      connection.sslSocketFactory = ssl.socketFactory
      connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { host, session -> pinned || HttpsURLConnection.getDefaultHostnameVerifier().verify(host, session) }
      connection.instanceFollowRedirects = false; connection.connectTimeout = 15000; connection.readTimeout = 15000
      connection.requestMethod = "POST"; connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Cookie", "")
      connection.setRequestProperty("Cookie2", "")
      connection.setRequestProperty("Authorization", "")
      // Never install this trust manager or a session cookie on the process-wide client.
      try {
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        val status = connection.responseCode
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val output = java.io.ByteArrayOutputStream()
        stream?.use { source ->
          val buffer = ByteArray(8192)
          while (true) { val length = source.read(buffer); if (length < 0) break; check(output.size() + length <= 16 * 1024 * 1024); output.write(buffer, 0, length) }
        }
        mapOf("status" to status, "body" to output.toString("UTF-8"))
      } catch (_: javax.net.ssl.SSLHandshakeException) {
        throw IllegalStateException("This home's identity changed; pair your phone again.")
      } finally { connection.disconnect() }
    }
    AsyncFunction("scanQr") { promise: Promise ->
      val activity = appContext.activityProvider?.currentActivity
      if (activity == null || scanner != null) promise.reject("CAMERA", "Open the camera and try again.", null)
      else {
        scanner = promise
        activity.runOnUiThread { IntentIntegrator(activity).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setBeepEnabled(false).setPrompt("Scan the pairing code.").initiateScan() }
      }
    }
    OnActivityResult { _, result ->
      if (result.requestCode == PRESENCE_REQUEST) {
        val pending = presence; presence = null
        if (pending != null) {
          try {
            if (result.resultCode != Activity.RESULT_OK) throw IllegalStateException()
            pending.first.resolve(sign(pending.second, pending.third, true))
          } catch (_: Exception) { pending.first.reject("PRESENCE", "Confirm your presence and try again.", null) }
        }
      } else if (result.requestCode == IntentIntegrator.REQUEST_CODE) {
        val pending = scanner; scanner = null
        val code = IntentIntegrator.parseActivityResult(result.requestCode, result.resultCode, result.data)?.contents
        if (code != null && code.length < 8192) pending?.resolve(code)
        else pending?.reject("CAMERA", "Scan the pairing code again.", null)
      }
    }
  }
}
