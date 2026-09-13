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
  if (XMLValidator.validate(raw) !== true || !Object.hasOwn(parsed || {}, 'multistatus') || (parsed.multistatus !== '' && typeof parsed.multistatus !== 'object')) {
    throw new Error('DAV server returned an invalid multistatus response');
  }
  const multistatus = parsed.multistatus;
  const responses = typeof multistatus === 'object' && multistatus !== null ? multistatus.response : undefined;
  for (const response of Array.isArray(responses) ? responses : responses ? [responses] : []) {
    const statuses: unknown[] = [response.status, ...(Array.isArray(response.propstat) ? response.propstat : response.propstat ? [response.propstat] : []).map(item => item.status)];
    if (statuses.some(status => /\b(?:403|5\d\d)\b/.test(typeof status === 'string' ? status : status?.['#text'] || ''))) {
      throw new Error('DAV server returned an incomplete resource response');
    }
  }
}

export function decodeDavCharRefs(value: string): string {
  return value.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match: string, code: string) => {
    const number = /^[xX]/.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
  });
}
