import { XMLValidator } from 'fast-xml-parser';

// A failed/truncated REPORT is not evidence that resources were deleted.
interface DavResponse {
  status?: unknown;
  propstat?: unknown;
  [key: string]: unknown;
}

interface DavMultistatus {
  multistatus?: string | { response?: DavResponse | DavResponse[] };
  [key: string]: unknown;
}

export function requireCompleteMultistatus(raw: string, parsed: DavMultistatus | null | undefined): void {
  if (XMLValidator.validate(raw) !== true || !parsed || !Object.hasOwn(parsed, 'multistatus') || (parsed.multistatus !== '' && typeof parsed.multistatus !== 'object')) {
    throw new Error('DAV server returned an invalid multistatus response');
  }
  if (Object.keys(parsed).some(key => key !== 'multistatus' && !key.startsWith('?')) || /<!DOCTYPE/i.test(raw)) throw new Error('DAV server returned an invalid multistatus response');
  const multistatus = parsed.multistatus;
  if (multistatus && typeof multistatus === 'object' && Object.keys(multistatus).some(key => !['response', 'responsedescription', 'sync-token'].includes(key) && !key.startsWith('@_') && !(key === '#text' && !String((multistatus as Record<string, unknown>)[key] ?? '').trim()))) {
    throw new Error('DAV server returned an incomplete multistatus response');
  }
  const responses = typeof multistatus === 'object' && multistatus !== null ? multistatus.response : undefined;
  for (const response of Array.isArray(responses) ? responses : responses ? [responses] : []) {
    const blocks = Array.isArray(response.propstat) ? response.propstat : response.propstat ? [response.propstat] : [];
    const codeOf = (value: unknown): number | null => {
      const text = typeof value === 'string' ? value : (value as { '#text'?: string } | null)?.['#text'] || '';
      const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(text);
      return match ? Number(match[1]) : null;
    };
    const topStatus = response.status === undefined ? undefined : codeOf(response.status);
    if ((topStatus !== undefined && (topStatus === null || topStatus < 200 || topStatus >= 300)) || !blocks.length) {
      throw new Error('DAV server returned an incomplete resource response');
    }
    for (const block of blocks) {
      if (!block || typeof block !== 'object') throw new Error('DAV server returned an incomplete resource response');
      const code = codeOf(block.status);
      if (code === null || (code !== 404 && (code < 200 || code >= 300))) {
        throw new Error('DAV server returned an incomplete resource response');
      }
    }
  }
}

export function decodeDavCharRefs(value: string): string {
  return value.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match: string, code: string) => {
    const number = /^[xX]/.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
  });
}
