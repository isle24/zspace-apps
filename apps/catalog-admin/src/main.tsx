import {createRoot} from 'react-dom/client';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
if (location.pathname === '/admin' || location.pathname.startsWith('/admin/')) {
  void import('./AdminApp').then(({AdminApp}) => root.render(<AdminApp />));
} else {
  void import('./PublicCatalog').then(({PublicCatalog}) => root.render(<PublicCatalog />));
}
