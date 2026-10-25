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
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? JSON.stringify(body.detail)
        : text.slice(0, 180);
    throw new Error(`${response.status} ${detail || response.statusText}`);
  }
  if (!body || typeof body !== 'object')
    throw new Error('The local service returned no JSON data.');
  return body as T;
}
export const cloneScenario = <T>(value: T): T => structuredClone(value);
