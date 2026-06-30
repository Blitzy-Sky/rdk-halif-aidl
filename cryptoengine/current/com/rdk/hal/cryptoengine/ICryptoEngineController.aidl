/*
 * If not stated otherwise in this file or this component's LICENSE file the
 * following copyright and licenses apply:
 *
 * Copyright 2026 RDK Management
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.rdk.hal.cryptoengine;

import com.rdk.hal.cryptoengine.ICryptoOperation;
import com.rdk.hal.cryptoengine.CryptoConfig;
import com.rdk.hal.cryptoengine.Digest;
import com.rdk.hal.cryptoengine.KeyPurpose;

/**
 * @brief Per-session controller for a crypto engine instance.
 * @author Gerald Weatherup
 *
 * Obtained via ICryptoEngine.open(). Provides raw cryptographic operations
 * independent of key storage. The engine operates on either:
 * - Caller-provided key material (via CryptoConfig.keyData) — the methods on
 *   this interface.
 * - A vault-managed key — fetch the key's opaque blob from the KeyVault
 *   (IKeyVaultController.getKeyBlob) and pass it as the keyBlob argument to
 *   begin()/encrypt()/decrypt()/computeHmac(). The TA unwraps the blob and
 *   operates inside the TEE; raw key material never leaves it.
 *
 * This separation ensures the crypto engine is composable — it can be
 * used standalone or attached to a vault as needed.
 *
 * <h3>Exception Handling</h3>
 * Unless otherwise specified, this interface follows standard Android Binder semantics:
 * - <b>Success</b>: The method returns `binder::Status::Exception::EX_NONE` and all output parameters/return values are valid.
 * - <b>Failure (Exception)</b>: The method returns a service-specific exception.
 *   In this case, output parameters and return values contain undefined memory and must not be used.
 */
@VintfStability
interface ICryptoEngineController {

    // -------------------------------------------------------------------------
    // Streaming crypto operations (begin / update / finish)
    // -------------------------------------------------------------------------

    /**
     * @brief Begin a crypto operation on a vault key blob or caller-provided key material.
     *
     * Supports all algorithm/mode combinations advertised by the engine's
     * EngineCapabilities. The key is the vault keyBlob when provided, otherwise
     * the raw material in CryptoConfig.keyData. Returns an operation handle for
     * streaming.
     *
     * Supported operation types:
     * - ENCRYPT / DECRYPT: AES-CBC, AES-CTR, AES-GCM, AES-ECB, ChaCha20-Poly1305, RSA-OAEP
     * - SIGN / VERIFY: HMAC, ECDSA, Ed25519, RSA-PSS, RSA-PKCS1-v1_5
     * - AGREE_KEY: ECDH (P-256, P-384, X25519)
     * - WRAP_KEY / UNWRAP_KEY: AES-KW, RSA-OAEP
     * - DERIVE_KEY / DERIVE_BITS: HKDF, PBKDF2, DH, AUTHENTICATED_DH
     *
     * <h4>IV handling</h4>
     * If config.iv is null, the engine auto-generates a random IV and prepends
     * it to the ciphertext output from finish(). On decrypt with iv=null, the
     * engine reads the IV from the first bytes of the input.
     * If config.iv is provided, it is used as-is and NOT prepended to the output.
     *
     * @param purpose The operation type.
     * @param config Crypto configuration including algorithm, mode, IV, AAD, and (for the standalone path) key data.
     * @param keyBlob Opaque vault key blob from IKeyVaultController.getKeyBlob(). When non-null, config.keyData is ignored. When null, config.keyData supplies the key.
     * @returns ICryptoOperation handle for update/finish/abort.
     * @exception binder::Status EX_ILLEGAL_ARGUMENT if config is invalid, keyBlob is malformed, or algorithm not supported.
     * @exception binder::Status EX_ILLEGAL_STATE if max concurrent operations reached.
     * @exception binder::Status EX_UNSUPPORTED_OPERATION if the algorithm/mode combination is not supported by this engine.
     */
    ICryptoOperation begin(in KeyPurpose purpose, in CryptoConfig config, in @nullable byte[] keyBlob);

    // -------------------------------------------------------------------------
    // One-shot digest operations
    // -------------------------------------------------------------------------

    /**
     * @brief Compute a message digest.
     *
     * Stateless, one-shot operation. Does not require a key.
     *
     * @param digest The digest algorithm to use (e.g. SHA_2_256, SHA_3_256).
     * @param data The data to hash.
     * @returns Digest bytes (length depends on algorithm: SHA-256=32, SHA-384=48, SHA-512=64).
     * @exception binder::Status EX_UNSUPPORTED_OPERATION if the digest algorithm is not supported.
     */
    byte[] computeDigest(in Digest digest, in byte[] data);

    /**
     * @brief Compute HMAC over data using a vault key blob or a caller-provided key.
     *
     * @param digest The digest algorithm for the HMAC (e.g. SHA_2_256).
     * @param key The raw HMAC key for the standalone path. Ignored (pass empty) when keyBlob is set.
     * @param data The data to authenticate.
     * @param keyBlob Opaque vault key blob from IKeyVaultController.getKeyBlob(). When non-null, the key argument is ignored.
     * @returns HMAC value (length matches digest output size).
     * @exception binder::Status EX_UNSUPPORTED_OPERATION if the digest algorithm is not supported.
     */
    byte[] computeHmac(in Digest digest, in byte[] key, in byte[] data, in @nullable byte[] keyBlob);

    // -------------------------------------------------------------------------
    // One-shot encrypt / decrypt
    // -------------------------------------------------------------------------

    /**
     * @brief One-shot encrypt for small payloads.
     *
     * Convenience method equivalent to begin(ENCRYPT) + finish(data).
     *
     * <h4>IV handling</h4>
     * If config.iv is null, the engine auto-generates a random IV and
     * prepends it to the returned ciphertext:
     *   output = [IV] + [ciphertext] + [auth tag if GCM/Poly1305]
     * If config.iv is provided, the output is ciphertext only (no prepended IV).
     *
     * @param config Crypto configuration (algorithm, mode, IV, AAD, and key for the standalone path).
     * @param plaintext Data to encrypt.
     * @param keyBlob Opaque vault key blob from IKeyVaultController.getKeyBlob(). When non-null, config.keyData is ignored.
     * @returns Ciphertext. If IV was auto-generated, it is prepended.
     *          Auth tag is appended for GCM/Poly1305.
     * @exception binder::Status EX_ILLEGAL_ARGUMENT if config is invalid.
     */
    byte[] encrypt(in CryptoConfig config, in byte[] plaintext, in @nullable byte[] keyBlob);

    /**
     * @brief One-shot decrypt for small payloads.
     *
     * Convenience method equivalent to begin(DECRYPT) + finish(data).
     *
     * <h4>IV handling</h4>
     * If config.iv is null, the engine reads the IV from the first bytes
     * of the ciphertext input (as produced by encrypt with iv=null):
     *   input = [IV] + [ciphertext] + [auth tag if GCM/Poly1305]
     * If config.iv is provided, the input is treated as ciphertext only.
     *
     * @param config Crypto configuration (algorithm, mode, IV, AAD, and key for the standalone path).
     * @param ciphertext Data to decrypt. If IV was auto-generated on encrypt,
     *        it must be prepended to the ciphertext.
     * @param keyBlob Opaque vault key blob from IKeyVaultController.getKeyBlob(). When non-null, config.keyData is ignored.
     * @returns Plaintext.
     * @exception binder::Status EX_ILLEGAL_ARGUMENT if config is invalid.
     * @exception binder::Status EX_SERVICE_SPECIFIC if auth tag verification fails.
     */
    byte[] decrypt(in CryptoConfig config, in byte[] ciphertext, in @nullable byte[] keyBlob);

    // -------------------------------------------------------------------------
    // Random number generation
    // -------------------------------------------------------------------------

    /**
     * @brief Generate cryptographically secure random bytes.
     *
     * Uses the platform's hardware RNG when available.
     *
     * @param length Number of random bytes to generate.
     * @returns Random byte array of the requested length.
     * @exception binder::Status EX_ILLEGAL_ARGUMENT if length is zero or exceeds 4096.
     */
    byte[] generateRandom(in int length);
}
