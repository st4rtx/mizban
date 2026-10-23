export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
export const onUnauthorized = (fn: Listener) => (unauthListeners.add(fn), () => unauthListeners.delete(fn));

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'ارتباط با سرور برقرار نیست. اینترنت یا وای‌فای را بررسی کنید.');
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json.error ?? {};
    if (res.status === 401 && !url.includes('/auth/login')) unauthListeners.forEach((f) => f());
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? 'خطای ناشناخته', e.details);
  }
  return json as T;
}

export const api = {
  get: <T,>(u: string) => request<T>('GET', u),
  post: <T,>(u: string, b?: unknown) => request<T>('POST', u, b ?? {}),
  put: <T,>(u: string, b?: unknown) => request<T>('PUT', u, b),
  patch: <T,>(u: string, b?: unknown) => request<T>('PATCH', u, b),
};

export const uid = () => crypto.randomUUID();
