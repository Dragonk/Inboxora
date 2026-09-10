import { XMLValidator } from 'fast-xml-parser';

// A failed/truncated REPORT is not evidence that resources were deleted.
export function requireCompleteMultistatus(raw, parsed) {
  if (XMLValidator.validate(raw) !== true || !parsed?.multistatus || typeof parsed.multistatus !== 'object') {
    throw new Error('DAV server returned an invalid multistatus response');
  }
  const responses = parsed.multistatus.response;
  for (const response of Array.isArray(responses) ? responses : responses ? [responses] : []) {
    const statuses = [response.status, ...(Array.isArray(response.propstat) ? response.propstat : response.propstat ? [response.propstat] : []).map(item => item.status)];
    if (statuses.some(status => /\b(?:403|5\d\d)\b/.test(typeof status === 'string' ? status : status?.['#text'] || ''))) {
      throw new Error('DAV server returned an incomplete resource response');
    }
  }
}

export function decodeDavCharRefs(value) {
  return value.replace(/&#([xX][0-9a-fA-F]+|\d+);/g, (match, code) => {
    const number = /^[xX]/.test(code) ? parseInt(code.slice(1), 16) : Number(code);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : match;
  });
}
