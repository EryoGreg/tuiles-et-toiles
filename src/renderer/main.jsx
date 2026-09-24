import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './fonts/polices.css';
import './styles.css';

// --- journal : tout geste et toute erreur de l'interface --------------------
// Domaine « ui » dans journal.log. Les clics sont en DEBUG (routine), les
// erreurs en ERREUR avec leur pile.
const evt = (quoi, donnees, niveau) => {
  try { window.api.evt('ui', quoi, donnees, niveau); } catch { /* preload absent (tests) */ }
};

window.addEventListener('error', (e) => {
  evt('erreur-js', {
    message: e.message, source: e.filename + ':' + e.lineno + ':' + e.colno,
    stack: e.error && e.error.stack ? String(e.error.stack).split('\n').slice(0, 8).join(' | ') : undefined
  }, 'ERREUR');
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  evt('promesse-rejetee', {
    message: String(r && r.message || r),
    stack: r && r.stack ? String(r.stack).split('\n').slice(0, 8).join(' | ') : undefined
  }, 'ERREUR');
});

// Clic sur un element actif : quoi (balise, libelle), ou (classes parentes).
document.addEventListener('click', (e) => {
  const el = e.target && e.target.closest && e.target.closest(
    'button, a, [role="button"], input, select, label, summary, .tuile, .vignette, [data-log]'
  );
  if (!el) return;
  const libelle = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.value || '')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  const zone = el.closest('section, .boite-dialogue, [class*="page"], main');
  evt('clic', {
    el: el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''),
    libelle,
    classe: String(el.className || '').slice(0, 60) || undefined,
    zone: zone ? String(zone.className || zone.tagName).slice(0, 60) : undefined,
    desactive: el.disabled || undefined
  }, 'DEBUG');
}, true);

createRoot(document.getElementById('racine')).render(<App />);
