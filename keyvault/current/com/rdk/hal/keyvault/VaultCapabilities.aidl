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
package com.rdk.hal.keyvault;

import com.rdk.hal.cryptoengine.Algorithm;
import com.rdk.hal.cryptoengine.Digest;
import com.rdk.hal.cryptoengine.KeyType;
import com.rdk.hal.cryptoengine.SecurityLevel;

/**
 * @brief Capabilities of a vault instance.
 *
 * Returned by getCapabilities() to allow callers to introspect the vault's
 * storage limits, security level, persistence behaviour, and what it can
 * create/store. Not all SoC platforms support every algorithm, key type, or
 * size; a caller should consult these fields before key creation, and any
 * unsupported request is rejected with EX_UNSUPPORTED_OPERATION.
 *
 * These describe key creation and storage on the vault. The crypto operations
 * available for a key are advertised separately by the CryptoEngine via
 * EngineCapabilities.
 */
@VintfStability
parcelable VaultCapabilities {
    /** Human-readable vault name (e.g. "app-secure-storage", "app-session"). */
    @utf8InCpp String vaultName;
    /** HAL version string. */
    @utf8InCpp String halVersion;
    /** Security level of this vault's key storage. */
    SecurityLevel securityLevel = SecurityLevel.SOFTWARE;
    /** Maximum number of keys this vault can hold. */
    int maxKeys = 0;
    /** Algorithms this vault can generate/import/store (e.g. AES, EC, HMAC, RSA). */
    Algorithm[] algorithms = {};
    /** Key types this vault can store (SECRET, PUBLIC, PRIVATE). */
    KeyType[] keyTypes = {};
    /** Digests this vault can bind to a key (e.g. SHA_2_256), for HMAC/signature/KDF keys. */
    Digest[] digests = {};
    /** Supported key sizes in bits. */
    int[] keySizes = {};
    /** Whether keys in this vault survive deep sleep. */
    boolean persistsAcrossSleep = false;
    /** Whether this vault's policy permits creating/importing extractable keys.
     *  When false, generateKey/importKey with extractable=true are rejected and
     *  exportKey is never permitted. */
    boolean allowExtractableKeys = false;
    /** Total storage capacity in bytes for this vault's partition. */
    long storageCapacityBytes = 0;
    /** Current storage usage in bytes. */
    long storageUsedBytes = 0;
}
