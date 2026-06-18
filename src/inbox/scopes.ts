/** True if the tenant's granted scope CSV (tenants.scopes) includes `scope`. */
export function hasScope(scopesCsv: string | null | undefined, scope: string): boolean {
  if (!scopesCsv) return false;
  return scopesCsv.split(',').map((s) => s.trim()).includes(scope);
}
