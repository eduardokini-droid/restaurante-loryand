import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from '../lib/session';
import { getSelectedEstablishment, setSelectedEstablishment } from '../lib/api';
import Login from './Login';
import Sala from './Sala';
import Carta from './Carta';
import Mesas from './Mesas';
import Camareros from './Camareros';
import Usuarios from './Usuarios';
import Negocio from './Negocio';
import Caja from './Caja';
import Kds from './Kds';
import Plataforma from './Plataforma';
import Reservas from './Reservas';
import MenuDia from './MenuDia';
import Plano from './Plano';
import Almacen from './Almacen';
import Fidelizacion from './Fidelizacion';
import Copias from './Copias';
import Integraciones from './Integraciones';
import { Waitlist } from '../components/Waitlist';
import { ServiceScreen } from '../components/ServiceScreen';

const NAV: { to: string; label: string; module: string }[] = [
  { to: 'sala', label: 'Sala', module: 'tpv' },
  { to: 'tpv', label: 'TPV', module: 'tpv' },
  { to: 'espera', label: 'Lista de espera', module: 'tpv' },
  { to: 'reservas', label: 'Reservas', module: 'reservations' },
  { to: 'cocina', label: 'Cocina', module: 'kitchen' },
  { to: 'barra', label: 'Barra', module: 'bar' },
  { to: 'caja', label: 'Ventas y caja', module: 'cash' },
  { to: 'almacen', label: 'Almacén y rentabilidad', module: 'stock' },
  { to: 'fidelizacion', label: 'Fidelización', module: 'loyalty' },
  { to: 'carta', label: 'Configuración y carta', module: 'config' },
  { to: 'menu', label: 'Menú del día', module: 'config' },
  { to: 'plano', label: 'Plano del local', module: 'tables' },
  { to: 'mesas', label: 'Mesas y QR', module: 'tables' },
  { to: 'camareros', label: 'Camareros', module: 'waiters' },
  { to: 'usuarios', label: 'Usuarios y permisos', module: 'users' },
  { to: 'negocio', label: 'Datos del negocio', module: 'config' },
  { to: 'integraciones', label: 'Pagos y WhatsApp', module: 'admin' },
  { to: 'copias', label: 'Copias de seguridad', module: 'admin' },
];

export default function GestionLayout() {
  const { me, loading, logout } = useSession();
  if (loading) return <p className="muted" style={{ padding: '2rem' }}>Cargando…</p>;
  if (!me || me.actor.kind !== 'user') return <Login />;
  const isSuper = me.actor.role === 'superadmin';
  const selected = getSelectedEstablishment();
  if (isSuper && !selected) return <Plataforma />;
  const isAdmin = isSuper || me.actor.role === 'admin';
  const nav = NAV.filter((n) => isSuper || (n.module === 'admin' ? isAdmin : me.modules.includes(n.module)));
  const first = `/gestion/${nav[0]?.to ?? 'sala'}`;
  return (
    <div className="shell">
      <nav className="side">
        <div className="brand">LORYAND<small>{me.establishment?.name ?? 'Gestor general'}</small></div>
        {nav.map((n) => <NavLink key={n.to} to={`/gestion/${n.to}`}>{n.label}</NavLink>)}
        <div className="foot">
          {me.actor.name}<br />
          {isSuper && <button className="btn small ghost" style={{ color: '#fff', padding: 0 }} onClick={() => { setSelectedEstablishment(null); location.assign('/gestion'); }}>Cambiar establecimiento</button>}
          <button className="btn small ghost" style={{ color: '#fff', padding: 0 }} onClick={logout}>Salir / cambiar usuario</button>
        </div>
      </nav>
      <main className="main">
        <Routes>
          <Route index element={<Navigate to={first} replace />} />
          <Route path="sala" element={<Sala />} />
          <Route path="tpv" element={<ServiceScreen mode="tpv" />} />
          <Route path="espera" element={<Waitlist />} />
          <Route path="reservas" element={<Reservas />} />
          <Route path="menu" element={<MenuDia />} />
          <Route path="plano" element={<Plano />} />
          <Route path="almacen" element={<Almacen />} />
          <Route path="fidelizacion" element={<Fidelizacion />} />
          <Route path="copias" element={<Copias />} />
          <Route path="integraciones" element={<Integraciones />} />
          <Route path="cocina" element={<Kds destination="kitchen" />} />
          <Route path="barra" element={<Kds destination="bar" />} />
          <Route path="caja" element={<Caja />} />
          <Route path="carta" element={<Carta />} />
          <Route path="mesas" element={<Mesas />} />
          <Route path="camareros" element={<Camareros />} />
          <Route path="usuarios" element={<Usuarios />} />
          <Route path="negocio" element={<Negocio />} />
          <Route path="*" element={<Navigate to={first} replace />} />
        </Routes>
      </main>
    </div>
  );
}
