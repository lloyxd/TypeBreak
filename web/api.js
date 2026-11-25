/**
 * API client.
 *
 * A thin typed-ish wrapper over fetch. Every method maps to exactly one server
 * route, and every route maps to exactly one `AppService` method, so there is
 * no business logic in the browser beyond presentation.
 */

const BASE = '/api';

async function request(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text };
  }

  if (!response.ok) {
    const error = new Error(payload?.error ?? `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/** Stable per-tab id so two open tabs do not share a typing session. */
export const clientId = (() => {
  const key = 'typebreak-client-id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = `web-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(key, id);
  }
  return id;
})();

export const api = {
  bootstrap: () => request('/bootstrap'),
  health: () => request('/health'),

  dashboard: () => request('/dashboard'),
  stats: () => request('/stats'),

  lessons: (filters = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return request(`/lessons${qs ? `?${qs}` : ''}`);
  },
  lesson: (id) => request(`/lessons/${encodeURIComponent(id)}`),

  plan: () => request('/plan'),
  regeneratePlan: () => request('/plan/regenerate'),
  tasks: () => request('/tasks'),
  weaknesses: () => request('/weaknesses'),
  adaptive: () => request('/adaptive'),
  recommendations: (limit = 10) => request(`/recommendations?limit=${limit}`),

  fingers: () => request('/progress/fingers'),
  movements: () => request('/progress/movements'),
  lessonProgress: () => request('/progress/lessons'),
  history: (days = 30) => request(`/progress/history?days=${days}`),

  startSession: ({ lessonId, exerciseId, mode }) =>
    request('/session', { method: 'POST', body: { lessonId, exerciseId, mode, clientId } }),
  press: (key) => request('/session/press', { method: 'POST', body: { clientId, key } }),
  finish: () => request('/session/finish', { method: 'POST', body: { clientId } }),
  cancel: () => request('/session/cancel', { method: 'POST', body: { clientId } }),

  updateSettings: (patch) => request('/settings', { method: 'PATCH', body: patch }),
  reset: () => request('/reset', { method: 'POST' }),
};
