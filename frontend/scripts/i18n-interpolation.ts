/** Return the variable contract and reject broken i18next double-brace syntax. */
export function interpolationVariables(value: string): string[] {
  const variables = new Set<string>();
  const remaining = value.replace(/\{\{\s*-?\s*([\w.]+)(?:\s*,\s*[^{}]+)?\s*\}\}/g, (_match, variable: string) => {
    variables.add(variable);
    return '';
  });
  if (remaining.includes('{{') || remaining.includes('}}')) throw new Error(`Malformed interpolation: ${value}`);
  return [...variables].sort();
}
