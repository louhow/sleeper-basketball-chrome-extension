// Thin client for Sleeper's public endpoints that records every request it
// makes, so the panel can show exactly which calls back the data on screen.
(globalThis.SNP ||= {}).createApi = (onChange) => {
  const REST = 'https://api.sleeper.app';
  const GRAPHQL = 'https://sleeper.com/graphql';
  const log = [];
  let nextId = 1;
  // The session token Sleeper turned down (401/403), if any. It stays expired
  // until the page holds a different token, i.e. after logging back in.
  let rejectedToken = null;

  function record(entry) {
    log.unshift({ id: nextId++, at: Date.now(), ...entry });
    onChange();
    return log[0];
  }

  async function request(entry, init) {
    const started = performance.now();
    try {
      const res = await fetch(entry.url, init);
      const text = await res.text();
      Object.assign(entry, { status: res.status, ms: performance.now() - started, bytes: text.length });
      if (entry.auth && (res.status === 401 || res.status === 403)) rejectedToken = entry.token;
      if (!res.ok) throw new Error(`${res.status} from ${entry.path}`);
      entry.json = JSON.parse(text);
      return entry.json;
    } catch (err) {
      if (entry.status === 'pending') Object.assign(entry, { status: 'error', ms: performance.now() - started });
      entry.error = String(err.message || err);
      throw err;
    } finally {
      onChange();
    }
  }

  function get(path) {
    return request(record({ path, url: REST + path, status: 'pending' }));
  }

  // The page's own session token, which Sleeper's web app keeps in localStorage
  // and sends as the Authorization header. Null when logged out.
  function sessionToken() {
    try {
      return localStorage.getItem('token') || null;
    } catch {
      return null;
    }
  }

  // GraphQL call; `query` is the full document text. `auth` sends the session
  // token the same way Sleeper's web app does. The token is never logged.
  async function graphql(label, query, { variables = {}, auth = false } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (auth) {
      const token = sessionToken();
      if (!token) throw new Error('Not logged in to Sleeper');
      headers.Authorization = token;
    }
    const shown = Object.keys(variables).length ? `${query}\n\nvariables: ${JSON.stringify(variables)}` : query;
    const entry = record({ path: `graphql ${label}`, url: GRAPHQL, status: 'pending', request: shown, auth });
    // Kept off the log entry's visible fields; only compared, never shown.
    Object.defineProperty(entry, 'token', { value: headers.Authorization, enumerable: false });
    const json = await request(entry, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (json.errors?.length) {
      entry.error = json.errors.map((e) => e.message).join('; ');
      throw new Error(`${entry.error} from ${entry.path}`);
    }
    return json.data;
  }

  // Logs a response served from the extension's own cache instead of the network.
  function cached(path, json, bytes) {
    record({ path, url: REST + path, status: 'cache', ms: 0, bytes, json });
  }

  // Logged in, but Sleeper turned the session down: the page needs a fresh login.
  const sessionExpired = () => rejectedToken != null && sessionToken() === rejectedToken;

  return { get, graphql, cached, log, loggedIn: () => Boolean(sessionToken()), sessionExpired };
};
