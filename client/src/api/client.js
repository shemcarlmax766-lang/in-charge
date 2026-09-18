/**
 * Single entry point for every server call.
 *
 * Responsibilities, and nothing more:
 *  - same-origin relative URLs only (the app is proxied; nothing here knows a port or host);
 *  - `credentials: 'include'` so the httpOnly session cookie rides along;
 *  - the CSRF token the server issued, on every mutating request;
 *  - one error shape: an `ApiError` carrying status, code, message and a per-field map, so
 *    forms can render server-side validation inline instead of guessing.
 */

const BASE = '/api/v1';
let csrfToken = null;
let onUnauthorized = () => {};

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? {};
    this.fieldErrors = details?.fields ?? {};
  }

  /** Message for one field, if the server complained about it. */
  errorFor(field) {
    const list = this.fieldErrors[field];
    return Array.isArray(list) && list.length ? list.join(' ') : null;
  }

  get isAuth() { return this.status === 401; }
  get isForbidden() { return this.status === 403; }
}

export const setCsrf = (token) => { csrfToken = token ?? null; };
export const getCsrf = () => csrfToken;
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn ?? (() => {}); };

/** Bearer override for the (rare) case a token is held explicitly rather than in a cookie. */
let bearer = null;
export const setBearer = (t) => { bearer = t ?? null; };

async function request(path, { method = 'GET', body, formData, headers = {}, signal, raw = false } = {}) {
  const isWrite = method !== 'GET' && method !== 'HEAD';
  const opts = {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(isWrite && csrfToken ? { 'x-bm-csrf': csrfToken } : {}),
      ...headers,
    },
    signal,
  };
  if (formData) opts.body = formData;
  else if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error',
      'The server could not be reached. Check the network connection, then try again.', {});
  }

  if (res.status === 204) return null;
  if (raw) return res;

  const text = await res.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = { error: { code: 'bad_response', message: text.slice(0, 200) } }; }
  }

  if (!res.ok) {
    const e = payload?.error ?? {};
    if (res.status === 401) onUnauthorized();
    throw new ApiError(res.status, e.code ?? 'error', e.message ?? `Request failed (${res.status})`, e.details);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  patch: (path, body, opts) => request(path, { ...opts, method: 'PATCH', body }),
  del: (path, body, opts) => request(path, { ...opts, method: 'DELETE', body }),
  upload: (path, formData, opts) => request(path, { ...opts, method: 'POST', formData }),
  raw: (path, opts) => request(path, { ...opts, method: 'GET', raw: true }),
};

/* --------------------------------------------- typed-ish endpoint groups --- */

export const auth = {
  login: (email, password, remember) => request('/auth/login', { method: 'POST', body: { email, password, remember } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  policy: () => request('/auth/policy'),
  changePassword: (currentPassword, newPassword) => request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  sessions: () => request('/auth/sessions'),
  revokeSession: (id) => request(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeAll: () => request('/auth/sessions/revoke-all', { method: 'POST' }),
};

export const equipment = {
  list: (params) => request(`/equipment?${new URLSearchParams(clean(params))}`),
  get: (id) => request(`/equipment/${id}`),
  create: (body) => request('/equipment', { method: 'POST', body }),
  update: (id, body) => request(`/equipment/${id}`, { method: 'PATCH', body }),
  remove: (id, body) => request(`/equipment/${id}`, { method: 'DELETE', body }),
  setStatus: (id, status, reason) => request(`/equipment/${id}/status`, { method: 'POST', body: { status, reason } }),
  activate: (id) => request(`/equipment/${id}/activate`, { method: 'POST', body: {} }),
  deactivate: (id, reason) => request(`/equipment/${id}/deactivate`, { method: 'POST', body: { reason } }),
  history: (id, params) => request(`/equipment/${id}/history?${new URLSearchParams(clean(params))}`),
  vocabulary: () => request('/equipment/vocabulary'),
  needsAttention: (limit = 10) => request(`/equipment/needs-attention?limit=${limit}`),
  uploadImage: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request(`/equipment/${id}/image`, { method: 'POST', formData: fd });
  },
  removeImage: (id) => request(`/equipment/${id}/image`, { method: 'DELETE' }),
  labels: (ids) => request('/equipment/labels', { method: 'POST', body: { ids } }),
  qrUrl: (id, kind = 'png') => `${BASE}/equipment/${id}/qr.${kind}`,
};

export const faults = {
  list: (params) => request(`/faults?${new URLSearchParams(clean(params))}`),
  get: (id) => request(`/faults/${id}`),
  vocabulary: () => request('/faults/vocabulary'),
  create: (formData) => request('/faults', { method: 'POST', formData }),
  update: (id, body) => request(`/faults/${id}`, { method: 'PATCH', body }),
  assign: (id, technicianId, note) => request(`/faults/${id}/assign`, { method: 'POST', body: { technicianId, note } }),
  transition: (id, targetStatus, comment) => request(`/faults/${id}/transition`, { method: 'POST', body: { targetStatus, comment } }),
  note: (id, comment) => request(`/faults/${id}/notes`, { method: 'POST', body: { comment } }),
  reopen: (id, comment, reason) => request(`/faults/${id}/reopen`, { method: 'POST', body: { comment, reason } }),
  repair: (id) => request(`/faults/${id}/repair`),
  saveRepair: (id, body) => request(`/faults/${id}/repair`, { method: 'PUT', body }),
  uploadRepairPhotos: (id, files, kind, caption) => {
    const fd = new FormData();
    fd.append('kind', kind);
    if (caption) fd.append('caption', caption);
    for (const f of files) fd.append('files', f);
    return request(`/faults/${id}/repair/photos`, { method: 'POST', formData: fd });
  },
  attach: (id, files, kind, caption) => {
    const fd = new FormData();
    fd.append('kind', kind);
    if (caption) fd.append('caption', caption);
    for (const f of files) fd.append('files', f);
    return request(`/faults/${id}/attachments`, { method: 'POST', formData: fd });
  },
};

export const maintenance = {
  schedules: (params) => request(`/maintenance/schedules?${new URLSearchParams(clean(params))}`),
  schedule: (id) => request(`/maintenance/schedules/${id}`),
  createSchedule: (body) => request('/maintenance/schedules', { method: 'POST', body }),
  updateSchedule: (id, body) => request(`/maintenance/schedules/${id}`, { method: 'PATCH', body }),
  deleteSchedule: (id, reason) => request(`/maintenance/schedules/${id}`, { method: 'DELETE', body: { reason } }),
  complete: (id, body) => request(`/maintenance/schedules/${id}/complete`, { method: 'POST', body }),
  records: (params) => request(`/maintenance/records?${new URLSearchParams(clean(params))}`),
  record: (id) => request(`/maintenance/records/${id}`),
  createRecord: (body) => request('/maintenance/records', { method: 'POST', body }),
  deleteRecord: (id, reason) => request(`/maintenance/records/${id}`, { method: 'DELETE', body: { reason } }),
  dueBoard: (params) => request(`/maintenance/due-board?${new URLSearchParams(clean(params))}`),
  compliance: (params) => request(`/maintenance/compliance?${new URLSearchParams(clean(params))}`),
  vocabulary: () => request('/maintenance/vocabulary'),
  reminders: () => request('/maintenance/reminders', { method: 'POST', body: {} }),
};

export const dashboard = {
  get: (params) => request(`/dashboard?${new URLSearchParams(clean(params))}`),
  risk: (params) => request(`/dashboard/risk?${new URLSearchParams(clean(params))}`),
  riskFor: (id) => request(`/dashboard/risk/${id}`),
  riskModel: () => request('/dashboard/risk/model'),
};

export const notifications = {
  list: (params) => request(`/notifications?${new URLSearchParams(clean(params))}`),
  unread: () => request('/notifications/unread-count'),
  markRead: (ids) => request('/notifications/read', { method: 'POST', body: ids?.length ? { ids } : {} }),
  remove: (id) => request(`/notifications/${id}`, { method: 'DELETE' }),
  deliveries: (id) => request(`/notifications/${id}/deliveries`),
};

export const reports = {
  list: () => request('/reports'),
  run: (key, params) => request(`/reports/${key}?${new URLSearchParams(clean(params))}`),
  csvUrl: (key, params) => `${BASE}/reports/export/${key}/csv?${new URLSearchParams(clean(params))}`,
  printUrl: (key, params) => `${BASE}/reports/export/${key}/print?${new URLSearchParams(clean(params))}`,
};

export const reference = {
  picklists: () => request('/reference/picklists'),
  categories: () => request('/reference/categories'),
  locations: () => request('/reference/locations'),
  faultCategories: () => request('/reference/fault-categories'),
  // kind is one of: categories | locations | fault-categories
  create: (kind, body) => request(`/reference/${kind}`, { method: 'POST', body }),
  update: (kind, id, body) => request(`/reference/${kind}/${id}`, { method: 'PATCH', body }),
  remove: (kind, id, body) => request(`/reference/${kind}/${id}`, { method: 'DELETE', body: body ?? {} }),
  settings: () => request('/reference/settings'),
  saveSettings: (body) => request('/reference/settings', { method: 'PATCH', body }),
};

export const users = {
  list: (params) => request(`/users?${new URLSearchParams(clean(params))}`),
  get: (id) => request(`/users/${id}`),
  create: (body) => request('/users', { method: 'POST', body }),
  update: (id, body) => request(`/users/${id}`, { method: 'PATCH', body }),
  resetPassword: (id, body) => request(`/users/${id}/reset-password`, { method: 'POST', body: body ?? {} }),
  signOut: (id) => request(`/users/${id}/sign-out`, { method: 'POST', body: {} }),
  remove: (id, body) => request(`/users/${id}`, { method: 'DELETE', body }),
  lookup: () => request('/users/lookup'),
  strength: (candidate, fullName, email) => request(`/users/password-strength?${new URLSearchParams({ candidate, fullName: fullName ?? '', email: email ?? '' })}`),
};

export const parts = {
  list: (params) => request(`/parts?${new URLSearchParams(clean(params))}`),
  upsert: (body) => request('/parts', { method: 'POST', body }),
};

export const audit = {
  list: (params) => request(`/audit?${new URLSearchParams(clean(params))}`),
};

export const publicApi = {
  config: () => request('/public/config'),
  equipment: (tag) => request(`/public/equipment/${encodeURIComponent(tag)}`),
};

export const attachments = {
  viewUrl: (id) => `${BASE}/attachments/${id}`,
  remove: (id) => request(`/attachments/${id}`, { method: 'DELETE' }),
};

/** Drops empty strings/nulls so a blank filter box does not become `?q=`. */
function clean(params = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof v === 'boolean' ? (v ? '1' : '0') : v;
  }
  return out;
}
