const api = {
  _key: '',
  setKey(k) { this._key = k; },
  _headers() {
    return { 'Content-Type': 'application/json', 'X-API-Key': this._key };
  },
  async auth(pin) {
    // Exchange SELLER_PIN for the API key. Never stored in window or HTML — only in sessionStorage.
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    if (!r.ok) return null;
    return r.json(); // {key: '...'}
  },
  async list() {
    const r = await fetch('/api/sketches', { headers: this._headers() });
    return r.json();
  },
  async get(id) {
    const r = await fetch(`/api/sketches/${id}`, { headers: this._headers() });
    return r.json();
  },
  async create(name, customer, data, thumbnail) {
    const r = await fetch('/api/sketches', {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({ name, customer, data, thumbnail })
    });
    return r.json();
  },
  async update(id, payload) {
    const r = await fetch(`/api/sketches/${id}`, {
      method: 'PUT',
      headers: this._headers(),
      body: JSON.stringify(payload)
    });
    return r.json();
  },
  async delete(id) {
    const r = await fetch(`/api/sketches/${id}`, { method: 'DELETE', headers: this._headers() });
    return r.json();
  },
  async share(id) {
    // Requires API key — seller only. Returns {code} or generates one if none exists.
    const r = await fetch(`/api/sketches/${id}/share`, { method: 'POST', headers: this._headers() });
    return r.json();
  },
  async getPublic(code) {
    // No API key needed — used by read-only share-code viewer.
    const r = await fetch(`/public/${code.toUpperCase()}`);
    return r.ok ? r.json() : null;
  }
};
