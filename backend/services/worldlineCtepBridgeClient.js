/**
 * Mirrors `sample/developer-docs/POS_INTEGRATION_EXAMPLE_JS.js` against the
 * Java `WorldlineCtepBrowserBridge` HTTP API (same paths and polling).
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeHttpBaseUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

/** Node/undici often surfaces refused connections as `fetch failed` with little context. */
function isBridgeConnectionFailure(err) {
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
    return true;
  }
  const m = String(err?.message || err || '');
  if (m === 'fetch failed' || /failed to fetch/i.test(m)) return true;
  return false;
}

function bridgeUnreachableError(baseUrl, err) {
  const e = new Error(
    `Worldline bridge not reachable at ${baseUrl}. `
    + 'Start the Java bridge (HTTP on this URL, default port 3210). '
    + 'From the backend folder: `npm run dev` starts API + bridge, or run `npm run worldline-bridge` alone. '
    + 'The launcher needs portable Java under `backend/runtime/java` (copy a Java 17 x64 JRE there so `bin/java.exe` exists).',
  );
  e.cause = err;
  return e;
}

async function fetchJson(baseUrl, path, init) {
  const base = normalizeHttpBaseUrl(baseUrl);
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (isBridgeConnectionFailure(err)) throw bridgeUnreachableError(base, err);
    throw err;
  }
  return res;
}

export async function ctepStatus(baseUrl) {
  const res = await fetchJson(baseUrl, '/status');
  return res.json();
}

/**
 * Same flow as sample POS_INTEGRATION_EXAMPLE_JS.js startCtepSale().
 * @param {string} baseUrl e.g. http://localhost:3210
 * @param {number} amount decimal euros
 * @param {string} reference merchant reference
 * @param {number} timeoutSec passed to bridge /sale body (default 180)
 * @param {{ pollMs?: number }} opts poll interval (sample uses 1500)
 */
export async function startCtepSale(baseUrl, amount, reference, timeoutSec = 180, opts = {}) {
  const base = normalizeHttpBaseUrl(baseUrl);
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 1500;

  const status = await ctepStatus(base);
  if (!status.terminalConnected) {
    throw new Error('Worldline terminal niet verbonden');
  }
  if (status.transactionBusy) {
    throw new Error('Er loopt al een transactie');
  }

  const res = await fetchJson(base, '/sale', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, reference, timeoutSec }),
  });
  const accepted = await res.json();
  if (!res.ok || !accepted.accepted) {
    throw new Error(accepted.error || 'Betaling niet gestart');
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
    // eslint-disable-next-line no-await-in-loop
    const txRes = await fetchJson(base, '/transaction');
    // eslint-disable-next-line no-await-in-loop
    const tx = await txRes.json();
    if (tx.status && tx.status !== 'running') return tx;
  }
}

/**
 * `fetchJson` only throws when the socket fails, so a bridge error status used to look like a
 * successful cancel. Surface it instead — the caller has to know the terminal was not reset.
 */
export async function ctepCancel(baseUrl) {
  const res = await fetchJson(baseUrl, '/cancel', { method: 'POST' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || body?.message || `Worldline bridge /cancel failed (HTTP ${res.status})`);
  }
  return body;
}

/**
 * The bridge answers a cancel by overwriting lastTransaction with `cancel_requested` and clearing
 * transactionBusy immediately — before the terminal has confirmed anything. Its runSale() is still
 * parked on latch.await(), so if the device ignored the reset the customer can still complete the
 * payment and a real result lands afterwards. Watch for that, or an approved sale gets filed as
 * cancelled and the money is never accounted for.
 *
 * Returns the terminal's real transaction, or null if none arrived before the deadline.
 */
export async function awaitCtepOutcomeAfterCancel(baseUrl, { pollMs = 1500, timeoutMs = 180000 } = {}) {
  const base = normalizeHttpBaseUrl(baseUrl);
  const deadline = Date.now() + timeoutMs;
  const settled = new Set(['done', 'declined_or_error', 'timeout', 'error']);
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(pollMs);
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetchJson(base, '/transaction');
      // eslint-disable-next-line no-await-in-loop
      const tx = await res.json();
      if (settled.has(String(tx?.status || ''))) return tx;
    } catch {
      // Bridge blipped; keep watching until the deadline.
    }
  }
  return null;
}

export async function ctepPing(baseUrl) {
  const res = await fetchJson(baseUrl, '/ping');
  return res.json();
}
