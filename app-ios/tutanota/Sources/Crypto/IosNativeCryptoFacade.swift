import TutanotaSharedFramework
import tutasdk

/// High-level cryptographic operations API
/// Is an actor because we want to have serial execution for all the cryptogaphic operations, doing them in parallel is usually too
/// much for the device.
public actor IosNativeCryptoFacade: NativeCryptoFacade {
	private let crypto: TUTCrypto = TUTCrypto()
	public init() {}

	public func aesEncryptFile(_ key: DataWrapper, _ fileUri: String, _ iv: DataWrapper) async throws -> EncryptedFileInfo {

		if !FileUtils.fileExists(atPath: fileUri) { throw CryptoError(message: "File to encrypt does not exist \(fileUri)") }
		let encryptedFolder = try FileUtils.getEncryptedFolder()
		let fileName = (fileUri as NSString).lastPathComponent
		let encryptedFilePath = (encryptedFolder as NSString).appendingPathComponent(fileName)
		let plainTextData = try Data(contentsOf: URL(fileURLWithPath: fileUri))
		let outputData = try aesEncryptData(plainTextData, withKey: key.data, withIV: iv.data)
		let result = EncryptedFileInfo(uri: encryptedFilePath, unencryptedSize: plainTextData.count)

		try outputData.write(to: URL(fileURLWithPath: encryptedFilePath))

		return result
	}

	public func aesDecryptFile(_ key: DataWrapper, _ fileUri: String) async throws -> String {
		if !FileUtils.fileExists(atPath: fileUri) { throw CryptoError(message: "File to decrypt does not exist") }

		let encryptedData = try Data(contentsOf: URL(fileURLWithPath: fileUri))
		let plaintextData = try aesDecryptData(encryptedData, withKey: key.data)

		let decryptedFolder = try FileUtils.getDecryptedFolder()
		let fileName = (fileUri as NSString).lastPathComponent
		let plaintextPath = (decryptedFolder as NSString).appendingPathComponent(fileName)
		try plaintextData.write(to: URL(fileURLWithPath: plaintextPath), options: .atomic)

		return plaintextPath
	}

	public func rsaEncrypt(_ publicKey: RsaPublicKey, _ data: DataWrapper, _ seed: DataWrapper) async throws -> DataWrapper {
		try self.crypto.rsaEncrypt(with: publicKey.toObjcKey(), data: data.data, seed: seed.data).wrap()
	}

	public func rsaDecrypt(_ privateKey: RsaPrivateKey, _ data: DataWrapper) async throws -> DataWrapper {
		try self.crypto.rsaDecrypt(with: privateKey.toObjcKey(), data: data.data).wrap()
	}

	public func argon2idHashRaw(_ password: DataWrapper, _ salt: DataWrapper, _ timeCost: Int, _ memoryCost: Int, _ parallelism: Int, _ hashLength: Int)
		async throws -> DataWrapper
	{
		try generateArgon2idHash(
			ofPassword: password,
			ofHashLength: hashLength,
			withSalt: salt.data,
			withIterations: UInt(timeCost),
			withParallelism: UInt(parallelism),
			withMemoryCost: UInt(memoryCost)
		)
		.wrap()
	}

	public func generateKyberKeypair(_ seed: DataWrapper) async throws -> TutanotaSharedFramework.KyberKeyPair {
		let keypair = tutasdk.generateKyberKeypair()
		return KyberKeyPair(publicKey: KyberPublicKey(raw: keypair.publicKey.wrap()), privateKey: KyberPrivateKey(raw: keypair.privateKey.wrap()))
	}

	public func kyberEncapsulate(_ publicKey: KyberPublicKey, _ seed: DataWrapper) async throws -> TutanotaSharedFramework.KyberEncapsulation {
		do {
			let sdkEncapsulation = try tutasdk.kyberEncapsulateWithPubKey(publicKeyBytes: publicKey.raw.data)
			return KyberEncapsulation(ciphertext: sdkEncapsulation.ciphertext.wrap(), sharedSecret: sdkEncapsulation.sharedSecret.wrap())
		} catch { throw CryptoError(message: error.localizedDescription) }
	}

	public func kyberDecapsulate(_ privateKey: KyberPrivateKey, _ ciphertext: DataWrapper) async throws -> DataWrapper {
		do { return try tutasdk.kyberDecapsulateWithPrivKey(privateKeyBytes: privateKey.raw.data, ciphertext: ciphertext.data).wrap() } catch {
			throw CryptoError(message: error.localizedDescription)
		}

	}
}

private func CryptoError(message: String) -> Error { TUTErrorFactory.createError(withDomain: TUT_CRYPTO_ERROR, message: message) }
