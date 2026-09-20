import QRCode from 'qrcode';
import { config } from '../config/index.js';

/**
 * QR codes are rendered on demand, not stored: printing labels is the department's
 * business, the software just needs the current URL to be resolvable.
 *
 * Payload is `https://<base>/e/<assetTag>` — a plain https URL so a stock phone camera
 * opens it without a bespoke app, and the route is readable by unauthenticated devices
 * (see PUBLIC_EQUIPMENT_PROFILE in docs/SECURITY.md).
 */

export function publicBaseFrom(req) {
  if (config.server.baseUrl) return config.server.baseUrl.replace(/\/+$/, '');
  const host = req?.get?.('host') ?? 'localhost';
  const proto = req?.protocol ?? 'http';
  return `${proto}://${host}`;
}

export const equipmentUrl = (base, assetTag) => `${base}/e/${encodeURIComponent(assetTag)}`;

const STYLE = {
  errorCorrectionLevel: 'M', // survives a scuff or a bit of tape on a lab bench
  margin: 2,
  color: { dark: '#0F172A', light: '#FFFFFFFF' },
};

export async function qrPng(text, { width = 320 } = {}) {
  return QRCode.toBuffer(text, { ...STYLE, type: 'png', width });
}

export async function qrSvg(text, { width = 320 } = {}) {
  return QRCode.toString(text, { ...STYLE, type: 'svg', width });
}

export async function qrDataUrl(text, { width = 240 } = {}) {
  return QRCode.toDataURL(text, { ...STYLE, type: 'image/png', width });
}
