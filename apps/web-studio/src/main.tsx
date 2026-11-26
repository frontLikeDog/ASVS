import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import './styles.css';
import { router } from './app';

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载节点');

// Loaded in its own chunk: the sync controller is optional and must not grow
// the initial bundle budget. It no-ops unless the user enabled server sync.
void import('./workspace-sync').then(({ startWorkspaceSync }) => startWorkspaceSync());

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
