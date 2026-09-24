import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';

import { App } from './App.tsx';
import { loadConfig } from './config.ts';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found in index.html');
}

/**
 * Configuration is loaded and validated before the app mounts.
 *
 * A missing value becomes a visible message rather than a blank page: the alternative is
 * a component throwing during render, which React reports to the console and shows the
 * user nothing. A production build pointing its API base URL at localhost fails
 * silently in exactly this way.
 */
try {
  const config = loadConfig();
  createRoot(container).render(
    <StrictMode>
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </StrictMode>,
  );
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Configuration failed to load.';
  container.textContent = message;
  throw error;
}
