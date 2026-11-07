import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Me {
  actor: { kind: 'user' | 'waiter'; id: string; name: string; role?: 'superadmin' | 'admin' | 'staff'; establishmentId: string | null; code?: number };
  establishment: { id: string; slug: string; name: string; features: string[]; settings: Record<string, boolean> } | null;
  shift: { id: string; started_at: string } | null;
  modules: string[];
}
interface Ctx { me: Me | null; loading: boolean; refresh: () => Promise<void>; logout: () => Promise<void> }
const SessionCtx = createContext<Ctx>(null as never);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/api/auth/me')); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setMe(null); else throw e; }
    finally { setLoading(false); }
  }, []);
  const logout = useCallback(async () => { await api('/api/auth/logout', { body: {} }).catch(() => {}); setMe(null); }, []);
  useEffect(() => { refresh().catch(() => setLoading(false)); }, [refresh]);
  return <SessionCtx.Provider value={{ me, loading, refresh, logout }}>{children}</SessionCtx.Provider>;
}
export const useSession = () => useContext(SessionCtx);
