import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { SessionProvider } from './lib/session';
import { ToastProvider } from './components/ui';
import Home from './pages/Home';
import GestionLayout from './pages/GestionLayout';
import Personal from './pages/Personal';
import ClientMenu from './pages/ClientMenu';
import Reservar from './pages/Reservar';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/carta/:token" element={<ClientMenu />} />
          <Route path="/reservar/:slug" element={<Reservar />} />
          <Route path="/gestion/*" element={<SessionProvider><GestionLayout /></SessionProvider>} />
          <Route path="/personal" element={<SessionProvider><Personal /></SessionProvider>} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
