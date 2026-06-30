# KeyVault HAL

The KeyVault HAL provides secure key storage and lifecycle management. It abstracts platform-specific secure storage (TEE, HSM) behind a uniform AIDL interface, offering named vault instances with independent key material, access rules, and persistence policies.

A KeyVault is purely a key store — it holds key material and manages key metadata. To perform cryptographic operations on vault-managed keys, callers attach an `ICryptoEngineController` to the vault. The engine then uses the vault's keys for its operations.

Together with the CryptoEngine HAL, the KeyVault forms a **Cryptographic Key Management System (CKMS)** in the sense of NIST SP 800-130: the KeyVault is the key-management plane (storage, lifecycle, policy) and the CryptoEngine is the key-use plane (the operations). Key management is the system; the cryptographic operations are one part of it.

Excluded: cryptographic operations themselves — these are the responsibility of the CryptoEngine HAL.

## References

!!! info "References"
    |||
    |-|-|
    |**Interface Definition**|[keyvault/current](https://github.com/rdkcentral/rdk-halif-aidl/tree/main/keyvault/current)|
    |**Interface Version**|`current`|
    |**HAL Interface Type**|[AIDL and Binder](../../introduction/aidl_and_binder.md)|
    |**HAL Feature Profile**|[hfp-keyvault.yaml](../hfp-keyvault.yaml)|

## Related Pages

!!! tip "Related Pages"
    - [Per-App Vaults — Secure Vault Usage](./per_app_vault_secure_usage.md) — the end-to-end per-app security model: identity gating, key derivation, and the app developer workflow
    - [CryptoEngine HAL](../../cryptoengine/current/docs/cryptoengine.md) — crypto operations; attached to a vault via `attachCryptoEngine()`
    - [HAL Interface Overview](../../key_concepts/hal/hal_interfaces.md)
    - [HAL Feature Profile](../../key_concepts/hal/hal_feature_profiles.md)

---

## Architectural Model

Key material is created, stored, and operated on **inside the TEE** — it never crosses into the REE in plaintext. Callers interact with keys only through opaque aliases and descriptors.

### System Layers

The HAL services run in the REE as normal Linux processes. The KeyVault manages key metadata and persistence. The CryptoEngine is the only component that talks to the Trusted Application (TA) inside the TEE. The KeyVault uses the CryptoEngine for all operations that touch key material.

```mermaid
flowchart TD
    subgraph APP_LAYER [Application Layer - REE]
        App[Application]
    end

    subgraph SVC_LAYER [Service Layer - REE]
        Svc[RDK Crypto Service]
        AA[AppArmor + UID<br/>vault access policy]
        Svc --> AA
    end

    subgraph HAL_LAYER [HAL Layer - REE]
        HAL_KV[KeyVault HAL<br/>metadata + storage I/O]
        HAL_CE[CryptoEngine HAL<br/>all crypto operations]
        KS[(Encrypted Keystore)]
        HAL_KV -->|"attachCryptoEngine"| HAL_CE
        HAL_KV <-->|"read/write encrypted blobs"| KS
    end

    subgraph TEE_LAYER [Trusted Execution Environment]
        TA[Trusted Application<br/>key material + crypto ops]
        OTP[(OTP Root Keys)]
        TA -->|"derive per-vault keys"| OTP
    end

    App -->|"aliases, config, data"| Svc
    AA -->|"allowed"| HAL_KV
    HAL_CE -->|"TEE client API"| TA

    style APP_LAYER fill:#f0f0f0,stroke:#999
    style SVC_LAYER fill:#fff3e0,stroke:#e67e22
    style HAL_LAYER fill:#e3f2fd,stroke:#1976d2
    style TEE_LAYER fill:#e8f5e9,stroke:#388e3c
    style TA fill:#2ecc71,color:#fff
    style OTP fill:#e67e22,color:#fff
    style KS fill:#666,color:#fff
```

### How operations flow through the layers

The CryptoEngine is the only REE component that communicates with the TA. The KeyVault delegates all crypto to the CryptoEngine, which forwards to the TA. The TA runs inside the TEE (ARM TrustZone) where the REE — including the Linux kernel — cannot read or modify its memory.

| Operation | KeyVault | CryptoEngine | TA (inside TEE) | Result |
|-----------|----------|-------------|-----------------|--------|
| **Generate key** | Requests key gen via CryptoEngine | Forwards to TA | Generates key with hardware RNG. Encrypts blob with OTP-derived vault key. | Encrypted blob returned. KeyVault writes to persistent storage. |
| **Import key** | Passes raw material to CryptoEngine | Forwards to TA | Encrypts material with OTP-derived vault key. | Encrypted blob returned. KeyVault writes to persistent storage. |
| **Encrypt** | Reads encrypted blob from persistent storage. Passes blob + plaintext to CryptoEngine. | Forwards to TA | Decrypts blob. Encrypts plaintext with the key. Key stays in TEE memory. | Ciphertext returned. |
| **Decrypt** | Reads encrypted blob from persistent storage. Passes blob + ciphertext to CryptoEngine. | Forwards to TA | Decrypts blob. Decrypts ciphertext. | Plaintext returned. |
| **Sign / HMAC** | Reads encrypted blob. Passes blob + data to CryptoEngine. | Forwards to TA | Decrypts blob. Computes signature. | Signature returned. |
| **Derive into vault** | Reads source blob. Passes blob + peer key + specs to CryptoEngine. | Forwards to TA | Decrypts source key. Derives new keys. Encrypts each. | Encrypted blobs returned. KeyVault writes all to persistent storage. |
| **Export key** | Reads encrypted blob. Passes to CryptoEngine. | Forwards to TA | Decrypts blob. Checks extractable flag. | Raw material (if extractable) or error. |

The KeyVault handles metadata and storage I/O. The CryptoEngine handles TEE communication. Plaintext key material only ever exists inside the TA.

### How keys are protected at rest

```mermaid
flowchart LR
    subgraph TEE [Trusted Execution Environment]
        OTP[OTP Root Key] -->|KDF| VK[Per-Vault Key]
        VK -->|AES-GCM encrypt| EB[Encrypted Key Blob]
        VK -->|HMAC-SHA256| MAC[Keystore HMAC]
    end

    subgraph REE [REE]
        EB -->|via CryptoEngine| CE[CryptoEngine HAL]
        MAC -->|via CryptoEngine| CE
        CE --> KV[KeyVault HAL]
        KV -->|write| STORE[(Encrypted Keystore)]
    end

    style TEE fill:#e8f5e9,stroke:#388e3c
    style REE fill:#e3f2fd,stroke:#1976d2
    style OTP fill:#e67e22,color:#fff
    style VK fill:#2ecc71,color:#fff
    style STORE fill:#666,color:#fff
```

1. The TA derives a **per-vault encryption key** from the hardware OTP root using a KDF. Each vault has its own derived key — compromise of one vault's data does not expose another.
2. The TA **encrypts each key blob with AES-GCM** using the per-vault key. The GCM authentication tag ensures integrity.
3. The encrypted blob is returned to the **CryptoEngine**, which passes it to the **KeyVault**. The KeyVault writes it to persistent storage. Neither the CryptoEngine nor the KeyVault can decrypt the blob.
4. The TA computes an **HMAC over the keystore** so that tampering with any blob or metadata is detected on the next load.
5. On boot, the KeyVault reads blobs from persistent storage, passes them through the CryptoEngine to the TA, and the TA validates the HMAC and re-derives vault keys from OTP before making keys available.

### Cold boot vault initialisation

On power-on, the TA derives per-vault encryption keys from the hardware OTP root. No vault key is ever stored — it is re-derived deterministically on every boot and lives only in TEE RAM.

```text
Vault Key = KDF(OTP_ROOT_KEY, vault_name)
```

```mermaid
sequenceDiagram
    participant SoC as SoC Power-On
    participant TEE as TEE / TA
    participant CE as CryptoEngine HAL (REE)
    participant KV as KeyVault HAL (REE)
    participant KS as Encrypted Keystore

    SoC->>TEE: TEE initialises, TA loaded

    KV->>KV: Read HFP — discover vault names

    loop For each vault
        KV->>CE: Initialise vault (vault_name)
        CE->>TEE: Initialise vault (vault_name)
        TEE->>TEE: Read OTP root key from SoC fuses
        TEE->>TEE: Derive vault_key = KDF(OTP, vault_name)
        TEE->>TEE: Hold vault_key in TEE RAM

        KV->>KS: Read encrypted blobs for this vault
        KS-->>KV: Encrypted blobs
        KV->>CE: Validate keystore (encrypted blobs)
        CE->>TEE: Decrypt blobs + validate HMAC
        TEE->>TEE: Decrypt with vault_key, verify HMAC

        alt HMAC valid
            TEE-->>CE: OK
            CE-->>KV: Vault state = READY
        else HMAC invalid or corruption
            TEE-->>CE: Error
            CE-->>KV: Vault state = ERROR
        end
    end

    KV->>KV: Register with Binder Service Manager
    Note over KV: Clients can now open() vaults

    Note over TEE: Vault keys exist only in TEE RAM
    Note over TEE: On deep sleep / power loss — TEE RAM is wiped
    Note over TEE: On resume — full sequence repeats
```

The vault key is **ephemeral** — it is derived on every boot, lives only in TEE RAM, and is lost on power loss or deep sleep. Because the derivation is deterministic (same OTP + same vault name = same key), the TA can always re-derive it and decrypt the stored blobs.

This means:

- **No vault key on disk.** Nothing to steal from persistent storage.
- **No vault key in REE RAM.** The CryptoEngine and KeyVault never see the vault key.
- **Device-bound.** A different device has a different OTP, so it derives a different vault key and cannot decrypt the blobs.

### Key principles

- **KeyVault manages metadata and persistence.** It holds aliases, descriptors, and encrypted blobs. It reads and writes the encrypted keystore. It never performs crypto directly — it delegates to the attached CryptoEngine.
- **Key lifecycle binds policy at creation.** `generateKey`, `importKey`, `importWrappedKey`, and `deriveIntoVault` live on the KeyVault, not the engine, so a key's `usages` and `extractable` policy are fixed where the key is stored. (Contrast WebCrypto, which places these verbs on the engine — `crypto.subtle` — because it has no vault.)
- **Storage and operation are separate, like Android KeyMint.** The KeyVault is **at-rest storage** — it holds keys as opaque, OTP-wrapped blobs and never performs crypto itself. To use a key, fetch its **`keyBlob`** with `getKeyBlob(alias)` and pass it to a CryptoEngine operation (`begin`/`encrypt`/`decrypt`/`computeHmac`); the engine's TA unwraps the blob and operates. This mirrors Android's `KeyMint.begin(keyBlob, …)`, where Keystore stores the blob and KeyMint (the TEE) runs the op. The blob is device-bound ciphertext — safe to hold even for a non-extractable key.
- **Two operation paths, both supported.** A *vault-managed* (non-extractable) key is used via its `keyBlob` as above. A *caller-held / extractable* key (the WebCrypto `crypto.subtle` model) is used directly on the CryptoEngine via `CryptoConfig.keyData`, with no vault involved. The `extractable` flag is the hinge: it governs whether `exportKey()` can ever yield plaintext to cross into the caller-held path.
- **Two distinct HMACs.** The keystore-integrity HMAC the TA computes over a vault is an internal at-rest tamper check, keyed by the OTP root; it never surfaces to callers. An application HMAC is a separate key-usage operation performed by the CryptoEngine (`computeHmac`) under a vault key. Same primitive, different layers.
- **CryptoEngine is the TEE gateway.** It is the only REE component that communicates with the TA. All key generation, encryption, decryption, signing, and derivation flow through the CryptoEngine to the TA.
- **The TA is the security boundary.** Plaintext key material exists only in TEE-protected memory. The TA generates keys, encrypts blobs with OTP-derived vault keys, and performs all crypto operations.
- **Encrypted blobs transit the REE but are opaque.** The KeyVault and CryptoEngine handle encrypted blobs as byte arrays. Only the TA can decrypt them using OTP-derived keys that never leave the TEE.
- **Named vaults provide natural isolation.** Each vault has its own OTP-derived encryption key. Compromise of one vault's blobs does not expose another vault's keys.
- **SOFTWARE fallback.** For vaults with `securityLevel: SOFTWARE`, the CryptoEngine uses a software backend (e.g. OpenSSL) instead of the TA. Key material is still encrypted at rest but is present in REE process memory during operations.

---

## Access control (caller identity)

The HAL is **caller-agnostic** — it does not enforce per-app access control. Which application may open which vault is decided **above** the HAL by the RDK Crypto Service, on the caller's verified identity (AppArmor label + Binder UID), before the request reaches the HAL.

The access-control model, the `vault-access.yaml` policy, per-app isolation, and end-to-end usage recipes are covered in the usage guide: [Per-App Vaults — Secure Vault Usage](./per_app_vault_secure_usage.md).

---

## Functional Overview

The KeyVault HAL has three layers:

| Interface | Role |
|-----------|------|
| `IKeyVault` | Top-level manager. Enumerates vaults, opens sessions, creates/destroys runtime vaults. |
| `IKeyVaultController` | Per-session controller. Key lifecycle (generate, import, export, delete, rotate), crypto engine attachment (for derive/wrap), `getKeyBlob()` to drive a CryptoEngine on a stored key, and vault introspection. |
| `IKeyVaultEventListener` | Asynchronous callback interface for vault state changes, key expiry, and key invalidation. |

---

## Implementation Requirements

| # | Requirement | Comments |
|---|-------------|---------|
| HAL.KV.1 | The service shall register with Binder Service Manager using the service name `KeyVault`. | Defined as `IKeyVault.serviceName`. |
| HAL.KV.2 | Platform-provisioned vaults shall be available immediately after service startup. | Defined in HFP `vaults` section. |
| HAL.KV.3 | Key material for TEE-backed vaults shall never leave the secure environment in plaintext. | Export returns `EX_SECURITY` for non-extractable keys. |
| HAL.KV.4 | Key material at rest shall be encrypted using OTP-derived root keys. | Per-vault encryption with HMAC-authenticated keystores. |
| HAL.KV.5 | On deep sleep, the HAL is closed. On resume, the HAL is reopened and vaults re-initialise. | Callers check `getVaultState()` after `open()`. |
| HAL.KV.6 | `flush()` shall persist all pending changes and re-sign the keystore HMAC. | Write failure returns `EX_SERVICE_SPECIFIC`. |
| HAL.KV.7 | Application-created vaults shall be subject to HFP limits (`allowApplicationVaults`, `maxApplicationVaults`). | `createVault()` returns `EX_UNSUPPORTED_OPERATION` if not permitted. |
| HAL.KV.8 | Platform-provisioned vaults shall not be destroyable. | `destroyVault()` returns `EX_ILLEGAL_ARGUMENT`. |

---

## Interface Definitions

| AIDL File | Description |
|-----------|-------------|
| `IKeyVault.aidl` | Top-level manager: vault enumeration, session open/close, runtime vault create/destroy |
| `IKeyVaultController.aidl` | Per-session controller: key lifecycle, crypto engine attachment, vault introspection |
| `IKeyVaultEventListener.aidl` | Oneway callback interface: state changes, key expiry, key invalidation, key rotation |
| `VaultCapabilities.aidl` | Parcelable: vault name, security level, key limits, persistence, storage capacity |
| `DerivedKeySpec.aidl` | Parcelable: output key spec for deriveIntoVault (alias, algorithm, type, size, usages) |
| `KeyDescriptor.aidl` | Parcelable: key alias, algorithm, type, size, usages, extractability, digest, version, timestamps |
| `VaultState.aidl` | Enum: READY, ERROR |

---

## Initialization

1. The platform starts the KeyVault HAL service process.
2. The service reads the HAL Feature Profile to discover platform-provisioned vaults.
3. For each provisioned vault, the service initialises the keystore partition and validates the HMAC.
4. The service registers `IKeyVault` with Binder Service Manager under the name `KeyVault`.
5. Clients obtain the `IKeyVault` proxy via Service Manager lookup.
6. Clients call `getVaultNames()` to discover available vaults.
7. Clients call `open(vaultName, listener)` to obtain an `IKeyVaultController` session.

---

## Product Customization

Platform vendors customize vaults via the HAL Feature Profile ([hfp-keyvault.yaml](./hfp-keyvault.yaml)):

- **Application vault policy** — whether apps can create runtime vaults, and how many
- **Platform-provisioned vaults** — each with:
    - Name and description
    - Security level (`SOFTWARE` or `TEE`)
    - Maximum key count
    - Supported key sizes
    - Deep sleep persistence behaviour
    - Storage capacity
    - Key extractability policy

Example provisioned vaults:

| Vault | Security | Persists Sleep | Extractable | Use Case |
|-------|----------|---------------|-------------|----------|
| `platform-identity` | TEE | Yes | No | Device certificates and signing keys |
| `app-secure-storage` | TEE | Yes | No | Per-application encrypted key-value storage |
| `drm-provisioning` | TEE | Yes | No | DRM key provisioning and device credentials |
| `app-session` | TEE | No | No | App secure-messaging session keys (re-derived after sleep) |
| `general-purpose` | SOFTWARE | Yes | Yes | Shared vault for platform services |

---

## Resource Management

| Operation | Behaviour |
|-----------|-----------|
| `IKeyVault.open(name, listener)` | Opens a session to a named vault. Returns `IKeyVaultController`. |
| `IKeyVault.close(controller)` | Aborts active operations, releases the session. Key material remains persisted. |
| `IKeyVaultController.attachCryptoEngine(engine)` | Binds a crypto engine to this vault session. Only one engine per session. |
| `IKeyVaultController.detachCryptoEngine()` | Unbinds the engine. Aborts in-flight operations using vault keys. |
| `IKeyVault.createVault(name, level, maxKeys)` | Creates a runtime vault (subject to HFP limits). |
| `IKeyVault.destroyVault(name)` | Destroys a runtime vault and securely erases all its keys. |

- Multiple sessions can be open to the same vault concurrently.
- If a client process dies, Binder death notification triggers cleanup of its sessions.

---

## Operation and Data Flow

### Key generation and use

```mermaid
sequenceDiagram
    participant C as Client
    participant KV as IKeyVault
    participant Ctrl as IKeyVaultController
    participant CE as ICryptoEngineController
    participant Op as ICryptoOperation

    C->>KV: open("app-secure-storage", listener)
    KV-->>C: IKeyVaultController

    C->>Ctrl: generateKey("session-key", AES, 256, ENCRYPT|DECRYPT, UNSET, false)
    Ctrl-->>C: KeyDescriptor
    C->>Ctrl: getKeyBlob("session-key")
    Ctrl-->>C: opaque keyBlob

    C->>CE: begin(ENCRYPT, config, keyBlob)
    CE-->>C: ICryptoOperation
    C->>Op: update(data)
    Op-->>C: ciphertext
    C->>Op: finish(null)
    Op-->>C: final ciphertext + tag

    C->>KV: close(controller)
```

### Key import and export

- `importKey(alias, algorithm, keyType, keyData, usages, digest, extractable)` — encrypts raw key material at rest using vault root-derived key
- `importWrappedKey(alias, algorithm, keyType, wrappedKeyData, wrappingKeyAlias, unwrapParams, usages, extractable)` — imports a key that is unwrapped only inside the secure environment, so plaintext never enters the REE. The secure path for provisioning an externally-generated key.
- `exportKey(alias)` — returns raw key material only if `extractable == true`
- `exportWrappedKey(alias, wrappingKeyAlias, wrapParams)` — wraps the key inside the TA under a vault wrapping key for secure migration, including non-extractable keys
- `deleteKey(alias)` — securely erases key material and re-persists the keystore

---

## Event Handling

Events are delivered via `IKeyVaultEventListener` (oneway/async):

| Event | Trigger |
|-------|---------|
| `onVaultStateChanged(state)` | Vault seal/unseal transitions (deep sleep/resume), error conditions, initial readiness. |
| `onKeyExpired(alias)` | Key TTL reached. Key material has been purged. |
| `onKeyInvalidated(alias)` | Key deleted or otherwise invalidated. |
| `onKeyRotated(alias, newVersion)` | Key rotated to a new version. |

Listeners are registered either at `open()` time or via `registerEventListener()` / `unregisterEventListener()`.

---

## State Machine / Lifecycle

### Vault state

```mermaid
stateDiagram-v2
    [*] --> READY : Boot / keystore valid
    [*] --> ERROR : Keystore corruption / HMAC failure
    READY --> ERROR : Runtime error
    ERROR --> [*] : Service restart
```

- `READY` — keys are accessible. Normal operating state.
- `ERROR` — keystore corruption detected (e.g. HMAC validation failure).

On deep sleep the HAL is closed; on resume it is reopened and vaults re-initialise. Callers should check `getVaultState()` after `open()` before attempting key operations.

---

## Platform Capabilities

Queried at runtime via `IKeyVaultController.getCapabilities()`:

| Field | Description |
|-------|-------------|
| `vaultName` | Human-readable vault name |
| `halVersion` | HAL version string |
| `securityLevel` | `SOFTWARE` or `TEE` |
| `maxKeys` | Maximum key count for this vault |
| `keySizes` | Supported key sizes in bits |
| `persistsAcrossSleep` | Whether keys survive deep sleep |
| `storageCapacityBytes` | Total keystore partition size |
| `storageUsedBytes` | Current usage |

---

## Error Handling

| Exception | Meaning |
|-----------|---------|
| `EX_ILLEGAL_ARGUMENT` | Unknown vault name, duplicate alias, empty key data, attempt to destroy platform vault. |
| `EX_ILLEGAL_STATE` | Max sessions reached, engine already/not attached. |
| `EX_UNSUPPORTED_OPERATION` | Application vault creation not permitted by HFP. |
| `EX_SECURITY` | Attempt to export a non-extractable key. |
| `EX_SERVICE_SPECIFIC` | Key limit reached, keystore write failure, internal error. |

On any exception, output parameters contain undefined memory and must not be used.
