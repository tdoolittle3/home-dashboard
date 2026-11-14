import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TvApp } from './TvApp';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

// The server's SPA fallback serves this shell for any page path, so routing is
// one pathname check: /tv is the look-only Fire TV page, everything else is home.
const tv = window.location.pathname.replace(/\/+$/, '') === '/tv';

createRoot(container).render(
  <StrictMode>{tv ? <TvApp /> : <App />}</StrictMode>,
);
