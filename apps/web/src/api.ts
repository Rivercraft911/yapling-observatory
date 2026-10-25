export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const value = body && typeof body === 'object' && 'detail' in body ? body.detail : null;
    const detail =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value
              .slice(0, 3)
              .map((issue) => {
                const path = Array.isArray(issue?.loc)
                  ? issue.loc.filter((part: unknown) => part !== 'body').join('.')
                  : '';
                const message =
                  typeof issue?.msg === 'string'
                    ? issue.msg.replace(/^Value error, /, '')
                    : 'Invalid input';
                return path ? `${path}: ${message}` : message;
              })
              .join('\n')
          : text.slice(0, 180);
    throw new Error(detail || response.statusText);
  }
  if (!body || typeof body !== 'object')
    throw new Error('The local service returned no JSON data.');
  return body as T;
}
export const cloneScenario = <T>(value: T): T => structuredClone(value);
