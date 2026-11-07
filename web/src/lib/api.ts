export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const EST_KEY = 'loryand.establishment';
export const getSelectedEstablishment = () => { try { return localStorage.getItem(EST_KEY); } catch { return null; } };
export const setSelectedEstablishment = (id: string | null) => {
  try { if (id) localStorage.setItem(EST_KEY, id); else localStorage.removeItem(EST_KEY); } catch { /* sin almacenamiento */ }
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const est = getSelectedEstablishment();
  if (est) headers['x-establishment-id'] = est;
  let res: Response;
  try {
    res = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'network', 'Sin conexión con el servidor');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Error ${res.status}`);
  return data as T;
}

export const newRequestId = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
