import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <div>
      <div className="hero">
        <div style={{ fontWeight: 800, letterSpacing: '.12em' }}>LORYAND</div>
        <h1 style={{ fontSize: '2.4rem', margin: '.4rem 0' }}>Restaurantes</h1>
        <p style={{ opacity: .9, margin: 0 }}>Carta digital, TPV, PDA, cocina y caja</p>
      </div>
      <div style={{ padding: '1.5rem', maxWidth: 720 }} className="grid cols-2">
        <Link to="/gestion" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2>Gestión</h2><p className="muted">Administración, TPV, cocina, barra y caja.</p>
        </Link>
        <Link to="/personal" className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <h2>Personal (PDA)</h2><p className="muted">Acceso del camarero desde su teléfono.</p>
        </Link>
      </div>
    </div>
  );
}
