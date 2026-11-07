import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getSelectedEstablishment } from './api';

/** Recarga los datos cuando el servidor avisa de cambios y también periódicamente,
 *  para no depender solo del aviso en tiempo real. */
export function useLive(reload: () => void, scopes: string[], opts: { tableToken?: string; intervalMs?: number } = {}) {
  const ref = useRef(reload);
  ref.current = reload;
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const socket: Socket = io({ path: '/socket.io', auth: { establishmentId: getSelectedEstablishment(), tableToken: opts.tableToken } });
    socket.on('connect', () => { setConnected(true); ref.current(); });
    socket.on('disconnect', () => setConnected(false));
    socket.on('changed', (e: { scopes: string[] }) => {
      if (!e.scopes.length || e.scopes.some((s) => scopes.includes(s))) ref.current();
    });
    const t = setInterval(() => ref.current(), opts.intervalMs ?? 20000);
    return () => { socket.close(); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.tableToken]);
  return connected;
}

export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  return online;
}
