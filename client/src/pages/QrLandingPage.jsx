import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { equipment as equipmentApi, publicApi } from '../api/client.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Badge, Button, Field, Loading, Spinner, TextInput } from '../components/ui.jsx';
import { EquipmentStatusPill, MaintenanceLight, KeyValue } from '../components/display.jsx';
import { attachments } from '../api/client.js';
import { errorText } from '../components/Toast.jsx';
import { SAFETY_NOTICE } from '../utils/constants.js';
import { formatDateTime } from '../utils/format.js';

/**
 * `/e/:tag` — the destination of the QR label on the equipment.
 *
 * It resolves *without* signing in (a student holding a dead microscope should learn whether
 * the department already knows), then offers sign-in or sign-out paths to actually report.
 */
export function QrLandingPage() {
  const { tag } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, is } = useAuth();
  const [state, setState] = useState({ loading: true, error: null, data: null, config: null });
  const [manual, setManual] = useState('');

  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: null, data: null, config: state.config });
    (async () => {
      const [config, data] = await Promise.allSettled([
        publicApi.config(),
        isAuthenticated ? equipmentApi.get(tag) : publicApi.equipment(tag),
      ]);
      if (!alive) return;
      setState({
        loading: false,
        config: config.status === 'fulfilled' ? config.value : null,
        data: data.status === 'fulfilled' ? data.value : null,
        error: data.status === 'rejected' ? data.reason : null,
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag, isAuthenticated]);

  const view = state.data;
  const equipment = view?.equipment ?? view;
  const openFaults = view?.openFaults ?? (view?.openFaults ? [] : view?.openFaults);

  if (state.loading) {
    return (
      <div className="login" style={{ minHeight: '100vh' }}>
          <div className="login__card" style={{ textAlign: 'center' }}>
            <Spinner label="Looking up this asset tag" size="md" />
            <p style={{ marginTop: 12 }}>Looking up <code>{tag}</code>…</p>
          </div>
        </div>
    );
  }

  if (state.error || !equipment) {
    return (
      <div className="login">
        <div className="login__card">
          <div className="login__brand">
            <span className="login__mark" aria-hidden="true">?</span>
            <h1 className="login__title">Equipment not found</h1>
            <p className="login__sub">{errorText(state.error) }</p>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (manual.trim()) navigate(`/e/${encodeURIComponent(manual.trim().toUpperCase())}`); }}>
            <Field label="Check the asset tag" hint="It is printed under the QR code, for example BMU-ECG-0014.">
              <TextInput value={manual} onChange={(e) => setManual(e.target.value)} placeholder="BMU-…-0000" autoCapitalize="characters" />
            </Field>
            <div className="row" style={{ marginTop: 12 }}>
              <Button tone="primary" type="submit">Look it up</Button>
              <Button as={Link} to="/equipment" tone="ghost">Browse the inventory</Button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const canReport = isAuthenticated;
  return (
    <div className="login">
      <div className="login__card" style={{ maxWidth: 560 }}>
        <div className="login__brand" style={{ justifyItems: 'start', textAlign: 'left' }}>
          <p className="page-head__eyebrow" style={{ margin: 0 }}>{state.config?.department ?? 'Biomedical Engineering'}</p>
          <h1 className="login__title">{equipment.name}</h1>
          <p className="asset-tag">{equipment.assetTag}</p>
        </div>

        {equipment.imageAttachmentId ? (
          <img className="eq-photo" src={attachments.viewUrl(equipment.imageAttachmentId)} alt={`${equipment.name} as recorded by the department`} />
        ) : (
          <div className="eq-photo--empty" aria-hidden="true">No photograph on file</div>
        )}

        <div className="row" style={{ gap: 8 }}>
          <EquipmentStatusPill status={equipment.status} size="lg" />
          {equipment.maintenanceState ? <MaintenanceLight state={equipment.maintenanceState} daysUntil={equipment.daysUntilPm} /> : null}
          {equipment.openFaults > 0 ? <Badge tone="warn">⚑ {equipment.openFaults} open fault report{equipment.openFaults > 1 ? 's' : ''}</Badge> : null}
        </div>

        {equipment.openFaults > 0 ? (
          <div className="callout callout--warn">
            <span className="callout__icon" aria-hidden="true">⚠</span>
            <div className="callout__main">
              <p className="callout__title">The department already knows about a problem with this item</p>
              <p className="callout__body">
                Open report {equipment.openFaultReference ?? ''} is being handled. Adding a duplicate report slows the repair down —
                only report it again if the problem is different or worse than described.
              </p>
            </div>
          </div>
        ) : null}

        <KeyValue
          columns={1}
          items={[
            ['Category', equipment.categoryName ?? equipment.category?.name],
            ['Location', equipment.locationLabel ?? equipment.location?.name ?? 'Not recorded'],
            ['Manufacturer', equipment.manufacturer],
            ['Model', equipment.model],
            ...(isAuthenticated && !is('reporter') ? [['Serial number', equipment.serialNumber], ['Status recorded', formatDateTime(equipment.updatedAt ?? equipment.createdAt)]] : []),
            ['Last repair completed', equipment.lastRepairedAt ? formatDateTime(equipment.lastRepairedAt) : 'No repair recorded'],
          ]}
        />

        <div className="stack">
          {canReport ? (
            <>
              <Button as={Link} to={`/report/${encodeURIComponent(equipment.assetTag)}`} tone="primary" size="lg" className="btn--block">
                Report a fault with this equipment
              </Button>
              <Button as={Link} to={`/equipment/${equipment.id ?? equipment.assetTag}`} tone="secondary" className="btn--block">
                Open the full equipment record
              </Button>
            </>
          ) : (
            <>
              <p className="form-note">Sign in to report a fault — every report is attributed to a named person so nothing gets lost.</p>
              <Button as={Link} to="/login" tone="primary" size="lg" className="btn--block">Sign in to report a fault</Button>
            </>
          )}
        </div>

        <p className="login__foot">{SAFETY_NOTICE}</p>
      </div>
    </div>
  );
}
