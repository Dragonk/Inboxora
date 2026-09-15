import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.tsx';
import './index.css';
import './ui.css';
import './i18n.ts';
import './plugins/index.ts'; // register bundled plugins' UI slots before first paint

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('Unable to mount Inboxora: missing #root element.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
