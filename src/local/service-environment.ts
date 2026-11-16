/** Parse systemd's effective environment without treating quoted values as keys. */
export function serviceEnvironmentTokens(value: string): string[] {
  const tokens: string[] = []; let token = '', quoted = false;
  for (let index = 0; index < value.length; index++) {
    const c = value[index]!;
    if (c === '\\') {
      const hex = value.slice(index + 1, index + 4);
      if (/^x[0-9a-fA-F]{2}$/.test(hex)) { token += String.fromCharCode(parseInt(hex.slice(1), 16)); index += 3; }
      else {
        const next = value[++index];
        if (next === undefined) throw new Error('The installed Grunt environment could not be parsed safely');
        token += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[next] ?? next;
      }
    } else if (c === '"') quoted = !quoted;
    else if (/\s/.test(c) && !quoted) { if (token) tokens.push(token); token = ''; }
    else token += c;
  }
  if (quoted) throw new Error('The installed Grunt environment could not be parsed safely');
  if (token) tokens.push(token);
  return tokens;
}
export function serviceEnvironment(value: string): NodeJS.ProcessEnv {
  return Object.fromEntries(serviceEnvironmentTokens(value).filter(value => value.includes('=')).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
}
