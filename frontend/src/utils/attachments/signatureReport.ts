/** Bounded parsing for signature reports; never trust arbitrary HTML or green labels. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function textValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
export type Verdict = 'valid' | 'invalid' | 'unknown';
export interface SignatureRecord { status: Verdict; certificate: Record<string, string>; fields: Record<string, string>; chain: Record<string, string>[]; network: string[] }
const certificateKeys = ['commonName', 'givenName', 'surname', 'organization', 'country', 'email', 'subject', 'issuer', 'serial', 'validFrom', 'validTo', 'fingerprint'];
function certificateData(value: unknown): Record<string, string> {
  const input = record(value); const result: Record<string, string> = {};
  for (const key of certificateKeys) result[key] = textValue(input[key]).slice(0, 2048);
  return result;
}
function verdict(value: unknown): Verdict { return value === 'valid' || value === 'invalid' ? value : 'unknown'; }
export function signatureReport(value: unknown) {
  const report = record(value);
  if (!Array.isArray(report.signatures) || report.signatures.length > 50) throw new Error('CORRUPT');
  const signatures: SignatureRecord[] = report.signatures.map(value => {
    const item = record(value); const certificate = certificateData(item.certificate); const fields: Record<string, string> = {};
    for (const key of ['field', 'signer', 'claimedSigner', 'reason', 'location', 'contact', 'claimedTime', 'subFilter', 'integrity', 'trust', 'revocation', 'coverage', 'modification', 'diagnostic', 'digestAlgorithm', 'signatureAlgorithm', 'timestamp', 'trustSource']) fields[key] = textValue(item[key]).slice(0, 2048);
    fields.page = typeof item.page === 'number' ? String(item.page) : '';
    fields.signedRevision = typeof item.signedRevision === 'number' ? String(item.signedRevision) : '';
    let status = verdict(item.status);
    if (status === 'valid' && (fields.integrity !== 'valid' || fields.trust !== 'valid' || fields.revocation !== 'checked')) status = 'unknown';
    if (item.chain !== undefined && (!Array.isArray(item.chain) || item.chain.length > 12)) throw new Error('CORRUPT');
    const chain = Array.isArray(item.chain) ? item.chain.map(certificateData) : [];
    const network = Array.isArray(item.network) ? item.network.filter((item): item is string => typeof item === 'string').slice(0, 8) : [];
    return { status, certificate, fields, chain, network };
  });
  const statuses = signatures.map(item => item.status);
  const trustLists = record(report.trustLists);
  const lists = Array.isArray(trustLists.lists) ? trustLists.lists.slice(0, 40).map(value => {
    const list = record(value);
    return { country: textValue(list.territory).slice(0, 2), issuedAt: textValue(list.issuedAt).slice(0, 80), nextUpdate: textValue(list.nextUpdate).slice(0, 80) };
  }) : [];
  return { signatures, lists, listStatus: textValue(trustLists.status), checkedAt: textValue(report.checkedAt), trustSource: textValue(report.trustSource), diagnostic: textValue(report.diagnostic),
    status: (statuses.includes('invalid') ? 'invalid' : statuses.length && statuses.every(value => value === 'valid') && report.status === 'valid' ? 'valid' : 'unknown') as Verdict };
}
