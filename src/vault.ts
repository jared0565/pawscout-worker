function b64e(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64d(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function aesGcmEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return `${b64e(iv.buffer)}:${b64e(ct)}`;
}
async function aesGcmDecrypt(key: CryptoKey, blob: string): Promise<Uint8Array> {
  const [ivB64, ctB64] = blob.split(':');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(ivB64) }, key, b64d(ctB64));
  return new Uint8Array(pt);
}

export class Vault {
  private constructor(private readonly kek: CryptoKey) {}

  static async fromMasterKey(masterKeyB64: string): Promise<Vault> {
    const kek = await crypto.subtle.importKey('raw', b64d(masterKeyB64), 'AES-GCM', false, [
      'encrypt',
      'decrypt'
    ]);
    return new Vault(kek);
  }

  /** Generate a random per-tenant DEK, return it wrapped (encrypted) under the KEK. */
  async newTenantDek(): Promise<string> {
    const rawDek = crypto.getRandomValues(new Uint8Array(32));
    return aesGcmEncrypt(this.kek, rawDek);
  }

  private async unwrap(dekWrapped: string): Promise<CryptoKey> {
    const rawDek = await aesGcmDecrypt(this.kek, dekWrapped);
    return crypto.subtle.importKey('raw', rawDek, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  async seal(dekWrapped: string, plaintext: string): Promise<string> {
    const dek = await this.unwrap(dekWrapped);
    return aesGcmEncrypt(dek, new TextEncoder().encode(plaintext));
  }

  async open(dekWrapped: string, blob: string): Promise<string> {
    const dek = await this.unwrap(dekWrapped);
    return new TextDecoder().decode(await aesGcmDecrypt(dek, blob));
  }
}
