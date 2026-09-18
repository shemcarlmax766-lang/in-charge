import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Field, Modal, TextInput } from './ui.jsx';
import { cx } from '../utils/format.js';

/**
 * QR / manual identification (Phase 3).
 *
 * Strategy, in order of what the device supports:
 *   1. `BarcodeDetector` — the native decoder on modern Android Chrome: fast, no bundle cost.
 *   2. jsQR on a canvas — works in Safari/Firefox and in the "take a photo instead" path.
 *   3. Typing the code — the label always prints the asset tag under the QR, so a cracked
 *      lens or a dark cupboard is never a blocker.
 *
 * The camera stream is only ever touched here; frames are decoded in-memory and discarded.
 */
export function QrScanner({ open, onClose, onFound, title = 'Scan the equipment label' }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const [mode, setMode] = useState('camera'); // camera | photo | manual
  const [error, setError] = useState(null);
  const [supported, setSupported] = useState(false);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const detectorRef = useRef(null);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!open) { stop(); return undefined; }
    setError(null);
    setManual('');
    const hasNative = typeof window !== 'undefined' && 'BarcodeDetector' in window;
    setSupported(hasNative);
    setMode(hasNative ? 'camera' : 'photo');
    if (hasNative) {
      try { detectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detectorRef.current = null; }
    }
    return stop;
  }, [open, stop]);

  const startCamera = useCallback(async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot open the camera. Take a photo of the label instead, or type the code.');
      setMode('photo');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }
      tick();
    } catch (err) {
      const name = err?.name ?? '';
      setError(
        name === 'NotAllowedError'
          ? 'Camera permission was declined. Allow it for this site, or use “Photo” / “Type code” below.'
          : name === 'NotFoundError'
            ? 'No camera was found on this device. Use “Photo” or “Type code”.'
            : 'The camera could not be started. Use “Photo” or “Type code”.',
      );
      setMode('photo');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // jsQR is loaded on demand: it is the heaviest thing on this screen and is only needed when
  // the browser has no native BarcodeDetector (iOS Safari, Firefox).
  const decoderRef = useRef(null);
  const loadDecoder = useCallback(async () => {
    if (!decoderRef.current) {
      const mod = await import('jsqr');
      decoderRef.current = mod.default ?? mod;
    }
    return decoderRef.current;
  }, []);


  const handleDetected = useCallback((text) => {
    stop();
    const tag = parseTag(text);
    if (!tag) {
      setError('That does not look like an equipment label from this department. Try again or type the code.');
      return;
    }
    onFound?.(tag, text);
  }, [onFound, stop]);

// The stream lifecycle follows the visible mode, so switching tabs never leaves the camera
  // running (the torch icon in the address bar is a privacy signal users watch).
  useEffect(() => {
    if (!open) return undefined;
    if (mode === 'camera') startCamera();
    else stop();
    return stop;
  }, [open, mode, startCamera, stop]);

  const tick = useCallback(async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) { rafRef.current = requestAnimationFrame(tick); return; }
    const jsQR = detectorRef.current ? null : await loadDecoder();
    const w = 480;
    const ratio = video.videoWidth ? w / video.videoWidth : 1;
    const h = Math.max(1, Math.round((video.videoHeight || w * 0.75) * ratio));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    try {
      if (detectorRef.current) {
        const found = await detectorRef.current.detect(video);
        if (found?.length) { handleDetected(found[0].rawValue ?? found[0].value); return; }
      } else {
        const img = ctx.getImageData(0, 0, w, h);
        const result = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (result?.data) { handleDetected(result.data); return; }
      }
    } catch { /* a single bad frame is not worth interrupting the scan loop for */ }
    rafRef.current = requestAnimationFrame(tick);
  }, [handleDetected, loadDecoder]);

  const decodeFile = useCallback(async (file) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 900 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const decoder = await loadDecoder();
      const result = decoder(img.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (!result?.data) throw new Error('no-code');
      handleDetected(result.data);
    } catch (err) {
      setError(err?.message === 'no-code'
        ? 'No QR code was found in that photo. Move closer to the label, avoid glare, and try again.'
        : 'That image could not be read. Try again, or type the code instead.');
    } finally {
      setBusy(false);
    }
  }, [handleDetected, loadDecoder]);

  return (
    <Modal
      open={open}
      onClose={() => { stop(); onClose?.(); }}
      title={title}
      description="Point the camera at the QR label on the equipment. The label also prints the asset tag if scanning is awkward."
      size="md"
      footer={(
        <>
          <div className="segbar" role="tablist" aria-label="Scanning method">
            {[['camera', 'Camera', supported], ['photo', 'Photo', true], ['manual', 'Type code', true]].map(([key, label, enabled]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={mode === key}
                disabled={!enabled}
                className={cx('segbar__btn', mode === key && 'segbar__btn--active')}
                onClick={() => setMode(key)}
              >
                {label}{!enabled ? ' (unavailable)' : ''}
              </button>
            ))}
          </div>
          <Button tone="ghost" onClick={() => { stop(); onClose?.(); }}>Close</Button>
        </>
      )}
    >
      {mode === 'camera' ? (
        <div className="scan-view">
          <video ref={videoRef} playsInline muted className="scan-view__video" aria-label="Camera preview of the equipment label" />
          <div className="scan-view__frame" aria-hidden="true" />
          <canvas ref={canvasRef} className="sr-only" />
          <p className="scan-view__hint">Hold steady · about 20 cm · fill the frame with the code</p>
        </div>
      ) : null}

      {mode === 'photo' ? (
        <div className="scan-alt">
          <p className="form-note">Take or choose a clear photo of the label; the code is decoded on this device, nothing is uploaded.</p>
          <label className="btn btn--primary scan-alt__btn">
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => decodeFile(e.target.files?.[0])} disabled={busy} />
            {busy ? 'Reading…' : 'Use camera / choose photo'}
          </label>
        </div>
      ) : null}

      {mode === 'manual' ? (
        <form
          className="scan-manual"
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) handleDetected(manual.trim());
          }}
        >
          <Field label="Asset tag or scan URL" hint="Printed under the QR code, for example BMU-ECG-0014." error={null}>
            <TextInput
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="BMU-ECG-0014"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              data-autofocus
            />
          </Field>
          <Button type="submit" tone="primary" disabled={!manual.trim()}>Find equipment</Button>
        </form>
      ) : null}

      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </Modal>
  );
}

/** Accepts a bare tag, a full URL from the label, or a `BMEQ:<tag>` payload. */
export function parseTag(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const fromUrl = /\/e\/([^/?#]+)/i.exec(text);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  const prefixed = /^BMEQ:\s*([A-Za-z0-9-]+)/i.exec(text);
  if (prefixed) return prefixed[1].toUpperCase();
  const taglike = /^[A-Z]{2,4}-[A-Z0-9]{2,8}-\d{1,6}$/i.exec(text);
  if (taglike) return text.toUpperCase();
  if (/^[A-Za-z0-9_-]{3,40}$/.test(text)) return text.toUpperCase();
  return null;
}

/** Floating scan button used by the mobile layout. */
export function ScanFab({ onClick, className }) {
  return (
    <button type="button" className={cx('scan-fab', className)} onClick={onClick} title="Scan an equipment QR label">
      <span aria-hidden="true">▣</span>
      <span>Scan</span>
    </button>
  );
}
