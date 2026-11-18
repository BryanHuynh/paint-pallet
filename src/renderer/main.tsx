import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { BROWSER_STL_LIMIT_MIB, createBrowserStlApi } from './browserStl';
import './index.css';

const browserApi = import.meta.env.DEV && !window.paintPallet ? createBrowserStlApi() : undefined;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App
      api={browserApi}
      stlLimitLabel={browserApi ? `${BROWSER_STL_LIMIT_MIB} MiB` : undefined}
    />
  </React.StrictMode>,
);
