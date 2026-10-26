export interface APIValidationIssue {
  type: string;
  loc: (string | number)[];
  msg: string;
}

export class APIError extends Error {
  readonly status: number;
  readonly issues: APIValidationIssue[];

  constructor(message: string, status: number, issues: APIValidationIssue[] = []) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.issues = issues;
  }
}

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
    const issues: APIValidationIssue[] = Array.isArray(value)
      ? value.map((issue) => ({
          type: typeof issue?.type === 'string' ? issue.type : '',
          loc: Array.isArray(issue?.loc)
            ? issue.loc.filter(
                (part: unknown) => typeof part === 'string' || typeof part === 'number',
              )
            : [],
          msg: typeof issue?.msg === 'string' ? issue.msg : 'Invalid input',
        }))
      : [];
    const detail =
      typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? issues
              .slice(0, 3)
              .map((issue) => {
                const path = issue.loc.filter((part) => part !== 'body').join('.');
                const message = issue.msg.replace(/^Value error, /, '');
                return path ? `${path}: ${message}` : message;
              })
              .join('\n')
          : text.slice(0, 180);
    throw new APIError(detail || response.statusText, response.status, issues);
  }
  if (!body || typeof body !== 'object')
    throw new Error('The local service returned no JSON data.');
  return body as T;
}
export const cloneScenario = <T>(value: T): T => structuredClone(value);
