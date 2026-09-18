/* Test entry: mounts the real <App/> inside a MemoryRouter and hands the harness a handle. */
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../src/App.jsx';

window.__unmount = null;

window.__mount = (route) => {
  const container = document.createElement('div');
  container.id = 'root';
  document.body.appendChild(container);
  const root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[route]}>
      <App />
    </MemoryRouter>,
  );
  window.__unmount = () => { root.unmount(); container.remove(); };
  return root;
};
