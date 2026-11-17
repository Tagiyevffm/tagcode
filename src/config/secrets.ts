import { promises as fs } from "node:fs";
import path from "node:path";
import { tagcodeHome, globalAuthPath } from "./paths.js";
import { readJson, writeJson, pathExists } from "../utils/fs.js";

export type SecretBackendName = "keychain" | "file";

type KeyringEntry = {
  getPassword(): Promise<string | undefined | null>;
  setPassword(value: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
};

type KeyringModule = {
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
};

const KEYCHAIN_SERVICE = "tagcode";

let keyringPromise: Promise<KeyringModule | null> | undefined;

async function loadKeyring(): Promise<KeyringModule | null> {
  if (keyringPromise) return keyringPromise;
  keyringPromise = (async () => {
    try {
      const mod = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
      if (typeof mod?.AsyncEntry !== "function") return null;
      return mod;
    } catch {
      return null;
    }
  })();
  return keyringPromise;
}

type AuthFile = {
  version: 1;
  providers: Record<string, string>;
};

const EMPTY_AUTH: AuthFile = { version: 1, providers: {} };

function envId(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

export type SecretStoreOptions = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Force a backend. "auto" prefers the OS keychain. */
  backend?: "auto" | "file";
};

/**
 * Secret storage with three layers, in order:
 *   1. environment variables (never stored on disk)
 *   2. OS credential store (Windows Credential Manager / macOS Keychain /
 *      Linux Secret Service) through the optional `@napi-rs/keyring` module
 *   3. `~/.tagcode/auth.json` with owner-only permissions, used only when the
 *      OS store is unavailable. This fallback is explicitly reported to the
 *      user because it is not encrypted at rest.
 */
export class SecretStore {
  readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly preferred: "auto" | "file";
  private readonly cache = new Map<string, string>();
  private backendCache?: SecretBackendName;

  constructor(options: SecretStoreOptions = {}) {
    this.home = options.home ?? tagcodeHome();
    this.env = options.env ?? process.env;
    this.preferred =
      options.backend ??
      (this.env.TAGCODE_SECRET_BACKEND === "file" ? "file" : "auto");
  }

  private authPath(): string {
    return this.home === tagcodeHome() ? globalAuthPath() : path.join(this.home, "auth.json");
  }

  /** Resolve a provider key: explicit env var, generic env var, then stores. */
  async get(providerId: string, apiKeyEnv?: string): Promise<string | undefined> {
    if (apiKeyEnv) {
      const value = this.env[apiKeyEnv];
      if (value && value.trim()) return value.trim();
    }
    const generic = this.env[`TAGCODE_${envId(providerId)}_API_KEY`];
    if (generic && generic.trim()) return generic.trim();

    const cached = this.cache.get(providerId);
    if (cached) return cached;

    if (this.preferred === "auto" && (await this.keychainAvailable())) {
      const keyring = await loadKeyring();
      if (keyring) {
        try {
          const entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, providerId);
          const value = await entry.getPassword();
          if (value) {
            this.cache.set(providerId, value);
            this.backendCache = "keychain";
            return value;
          }
        } catch {
          // No entry or backend unavailable; fall through to the file store.
        }
      }
    }

    const auth = await this.readAuth();
    const stored = auth.providers[providerId];
    if (stored) {
      this.cache.set(providerId, stored);
      this.backendCache = "file";
      return stored;
    }
    return undefined;
  }

  async set(providerId: string, secret: string): Promise<SecretBackendName> {
    const value = secret.trim();
    if (!value) throw new Error("API key cannot be empty");
    this.cache.set(providerId, value);

    if (this.preferred === "auto") {
      const keyring = await loadKeyring();
      if (keyring) {
        try {
          const entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, providerId);
          await entry.setPassword(value);
          await this.removeFromFile(providerId);
          this.backendCache = "keychain";
          return "keychain";
        } catch {
          // Fall back to the file store below.
        }
      }
    }

    const auth = await this.readAuth();
    auth.providers[providerId] = value;
    await writeJson(this.authPath(), auth, 0o600);
    this.backendCache = "file";
    return "file";
  }

  async remove(providerId: string): Promise<void> {
    this.cache.delete(providerId);
    const keyring = await loadKeyring();
    if (keyring) {
      try {
        const entry = new keyring.AsyncEntry(KEYCHAIN_SERVICE, providerId);
        await entry.deleteCredential();
      } catch {
        // Nothing stored or backend unavailable.
      }
    }
    await this.removeFromFile(providerId);
  }

  private async removeFromFile(providerId: string): Promise<void> {
    const auth = await this.readAuth();
    if (!(providerId in auth.providers)) return;
    delete auth.providers[providerId];
    await writeJson(this.authPath(), auth, 0o600);
  }

  async storedProviders(): Promise<string[]> {
    const auth = await this.readAuth();
    return Object.keys(auth.providers);
  }

  async keychainAvailable(): Promise<boolean> {
    if (this.preferred === "file") return false;
    return (await loadKeyring()) !== null;
  }

  async activeBackend(): Promise<SecretBackendName> {
    if (this.backendCache) return this.backendCache;
    if (await this.keychainAvailable()) return "keychain";
    return "file";
  }

  async describe(): Promise<{
    backend: SecretBackendName;
    keychainAvailable: boolean;
    filePath: string;
    fileExists: boolean;
  }> {
    const [keychainAvailable, fileExists] = await Promise.all([
      this.keychainAvailable(),
      pathExists(this.authPath()),
    ]);
    return {
      backend: await this.activeBackend(),
      keychainAvailable,
      filePath: this.authPath(),
      fileExists,
    };
  }

  private async readAuth(): Promise<AuthFile> {
    try {
      const parsed = await readJson<unknown>(this.authPath(), EMPTY_AUTH);
      if (!parsed || typeof parsed !== "object") return { ...EMPTY_AUTH, providers: {} };
      const record = parsed as Partial<AuthFile>;
      return {
        version: 1,
        providers: { ...(record.providers ?? {}) },
      };
    } catch {
      return { ...EMPTY_AUTH, providers: {} };
    }
  }
}

/** Best-effort removal of the legacy plaintext file (used by `tgc doctor --fix`). */
export async function removeLegacyAuthFile(home = tagcodeHome()): Promise<void> {
  await fs.rm(path.join(home, "auth.json"), { force: true }).catch(() => undefined);
}
