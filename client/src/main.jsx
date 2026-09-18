import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.jsx';
import './styles/app.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

/**
 * App-shell service worker — production builds only (dev must never be intercepted: HMR and
 * fresh-API-state matter during development, and a stale SW is the classic "why is my deploy
 * old?" trap).  The worker itself refuses to touch /api/**; see client/public/sw.js.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* a failed registration only costs the offline shell; the app itself is unaffected */
    });
  });
}
