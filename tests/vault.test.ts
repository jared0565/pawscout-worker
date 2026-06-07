import { describe, it, expect } from 'vitest';
import { Vault } from '../src/vault';

const KEK_B64 = 'dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWxvbmchISE='; // 32 bytes (test-master-key-32-bytes-long!!!)

describe('Vault', () => {
  it('round-trips a secret under a fresh tenant DEK', async () => {
    const vault = await Vault.fromMasterKey(KEK_B64);
    const dekWrapped = await vault.newTenantDek();
    const blob = await vault.seal(dekWrapped, 'super-secret-cj-key');
    expect(blob).not.toContain('super-secret');
    expect(await vault.open(dekWrapped, blob)).toBe('super-secret-cj-key');
  });

  it('uses a fresh IV each seal (ciphertext differs for same input)', async () => {
    const vault = await Vault.fromMasterKey(KEK_B64);
    const dekWrapped = await vault.newTenantDek();
    const a = await vault.seal(dekWrapped, 'x');
    const b = await vault.seal(dekWrapped, 'x');
    expect(a).not.toBe(b);
  });

  it('cannot open a blob with a different tenant DEK', async () => {
    const vault = await Vault.fromMasterKey(KEK_B64);
    const dek1 = await vault.newTenantDek();
    const dek2 = await vault.newTenantDek();
    const blob = await vault.seal(dek1, 'secret');
    await expect(vault.open(dek2, blob)).rejects.toBeTruthy();
  });
});
