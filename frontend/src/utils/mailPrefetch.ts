export function parsePrefetchInput(value: string): number | null {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 100 ? parsed : null;
}
