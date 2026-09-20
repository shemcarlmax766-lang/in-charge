import { Link } from 'react-router-dom';
import { Button, Card } from '../components/ui.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

/** Not found — with the two routes a person in a lab actually needs from here. */
export function NotFoundPage() {
  const { can } = useAuth();
  return (
    <Card title="That page does not exist" className="notfound">
      <p className="form-note">The link may be old, or a record was removed. The department’s two most useful screens are below.</p>
      <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
        <Button as={Link} to="/" tone="primary">Dashboard</Button>
        <Button as={Link} to="/equipment" tone="secondary">Equipment list</Button>
        <Button as={Link} to="/faults/new" tone="ghost">Report a fault</Button>
      </div>
    </Card>
  );
}
