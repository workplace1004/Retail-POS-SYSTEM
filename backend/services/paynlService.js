import axios from 'axios';
import crypto from 'crypto';

/**
 * Pay.nl Cloud Connect (in-person card payments started through Pay.nl's online API).
 *
 * The till creates an order for a terminal on connect.pay.nl (payment method 1927); Pay.nl pushes
 * it to the terminal, and the till polls the order's status link until it is paid or has failed.
 * This needs internet in the shop; the LAN-only variant is kept in paynlLocalConnectService.js.
 *
 * Docs: https://developer.pay.nl/docs/pos-integration-guide
 */

const sharedSessions = new Map();

const ORDERS_URL = 'https://connect.pay.nl/v1/orders';
const TERMINALS_URL = 'https://rest.pay.nl/v2/terminals';
/** Pay.nl's payment method id for a payment on a card terminal. */
const TERMINAL_PAYMENT_METHOD_ID = 1927;

const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 180000;
/** Pay.nl asks for the first status check 3 s after the start, then at most one a second. */
const FIRST_STATUS_DELAY_MS = 3000;
const MIN_STATUS_INTERVAL_MS = 1000;
/**
 * A cancel from the POS does not stop the terminal. Measured on a CCV A35 (Pay.nl terminal server
 * "ECR-CCV"): Order:Abort is accepted and the order becomes "aborted", but the terminal goes on
 * asking for the card until its own timeout, about 35 s after the start, aborted or not; and
 * Pay.nl's Payment:Cancel does not know these payments (Error 144). Until that time has passed, a
 * POS cancel is therefore reported as not delivered, with a warning for the cashier.
 */
const TERMINAL_CARD_WAIT_MS = 35000;

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `paynl-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function parseTerminalConnection(connectionString) {
  let config = {};
  if (typeof connectionString === 'string') {
    try {
      config = JSON.parse(connectionString);
    } catch {
      config = {};
    }
  } else if (connectionString && typeof connectionString === 'object') {
    config = connectionString;
  }

  const serviceId = String(config.serviceId || '').trim();
  const tokenCode = String(config.tokenCode || '').trim();
  const apiToken = String(config.apiToken || '').trim();
  const terminalCode = String(config.terminalCode || '').trim();
  if (!serviceId) throw new Error('Pay.nl service ID (SL-...) not found in terminal configuration.');
  if (!tokenCode || !apiToken) {
    throw new Error('Pay.nl token code (AT-...) and API token not found in terminal configuration.');
  }
  if (!terminalCode) throw new Error('Pay.nl terminal code (TH-...) not found in terminal configuration.');

  const timeoutRaw = Number.parseInt(String(config.timeoutMs || config.timeout || '').trim(), 10);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TRANSACTION_TIMEOUT_MS;
  const currency = String(config.currency || 'EUR').trim().toUpperCase() || 'EUR';
  const referencePrefix = String(config.referencePrefix || 'POS').trim() || 'POS';

  return { serviceId, tokenCode, apiToken, terminalCode, timeoutMs, currency, referencePrefix };
}

function basicAuth(tokenCode, apiToken) {
  return `Basic ${Buffer.from(`${tokenCode}:${apiToken}`).toString('base64')}`;
}

function paynlClient(auth) {
  return axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    headers: { accept: 'application/json', ...(auth ? { Authorization: auth } : {}) },
    validateStatus: () => true,
  });
}

/** Pay.nl errors carry `code` + `title` (+ `detail`, and `violations` for a rejected field). */
function describePaynlError(res, fallback) {
  const body = res?.data && typeof res.data === 'object' ? res.data : {};
  const violations = Array.isArray(body.violations)
    ? body.violations.map((v) => [v?.propertyPath, v?.message].filter(Boolean).join(': ')).filter(Boolean)
    : [];
  const text = [body.title, body.detail, ...violations].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
  if (res?.status === 401 || res?.status === 403) {
    return `Pay.nl rejected the token code or API token (${res.status}).${text ? ` ${text}` : ''}`;
  }
  const code = body.code ? ` [${body.code}]` : '';
  return text ? `${text}${code}` : `${fallback} (HTTP ${res?.status ?? '?'})`;
}

/** Why the terminal refused: Pay.nl reports it on the payment's supplier data. */
function incidentText(order) {
  const payments = Array.isArray(order?.payments) ? order.payments : [];
  for (const p of payments) {
    const text = String(p?.supplierData?.incident_text || '').trim();
    if (text) return text;
  }
  return '';
}

/** Order status → the states the POS payment screens already understand. Only PAID is approved. */
function mapOrderStatus(order) {
  const code = Number(order?.status?.code);
  const action = String(order?.status?.action || '').toUpperCase();
  const name = String(order?.status?.name || '').toLowerCase();
  const reason = incidentText(order);

  if (code === 100 || action === 'PAID') return { state: 'APPROVED', message: 'Payment approved.' };
  // Checked before CANCEL: Pay.nl reports an expiry as code -80, name "expired", action "CANCEL".
  if (code === -80 || name === 'expired' || action === 'EXPIRED') {
    return {
      state: 'CANCELLED',
      message: reason || 'Payment timed out: no card was presented, or the terminal did not respond.',
    };
  }
  if (action === 'CANCEL' || code === -90 || code === -61) {
    return { state: 'CANCELLED', message: reason || 'Payment cancelled.' };
  }
  if (action === 'DENIED' || code === -63 || code === -64) {
    return { state: 'DECLINED', message: reason || 'Payment declined.' };
  }
  if (action === 'FAILURE' || code === -60 || (Number.isFinite(code) && code < 0)) {
    return { state: 'ERROR', message: reason || 'Terminal error during payment.' };
  }
  return { state: 'IN_PROGRESS', message: 'Payment in progress on terminal...' };
}

/** The terminals of the account behind this token, so Control can offer their TH- codes. */
export async function listPaynlTerminals({ tokenCode, apiToken } = {}) {
  const code = String(tokenCode || '').trim();
  const token = String(apiToken || '').trim();
  if (!code || !token) {
    return { success: false, message: 'Enter the token code (AT-...) and API token first.' };
  }
  try {
    const res = await paynlClient(basicAuth(code, token)).get(TERMINALS_URL, { params: { limit: 100, page: 1 } });
    if (res.status < 200 || res.status >= 300) {
      return { success: false, message: describePaynlError(res, 'Could not load the Pay.nl terminals') };
    }
    const list = Array.isArray(res.data?.terminals) ? res.data.terminals : [];
    return {
      success: true,
      terminals: list.map((t) => ({
        code: String(t?.code || ''),
        name: String(t?.name || ''),
        status: String(t?.status || ''),
        serviceId: String(t?.service?.code || t?.service?.id || (typeof t?.service === 'string' ? t.service : '') || ''),
      })).filter((t) => t.code),
    };
  } catch (err) {
    return { success: false, message: `Could not reach Pay.nl: ${err.message}` };
  }
}

class PaynlCloudConnectService {
  constructor(config) {
    this.config = config;
    this.sessions = sharedSessions;
    this.auth = basicAuth(config.tokenCode, config.apiToken);
  }

  settle(session, state, message, details = null) {
    if (session.completed) return;
    session.state = state;
    session.message = message;
    if (details) session.details = details;
    session.completed = state !== 'IN_PROGRESS';
    if (session.completed) setTimeout(() => this.sessions.delete(session.id), 5 * 60 * 1000);
  }

  /** Creates the order; Pay.nl then shows the amount on the terminal. The till polls getSessionStatus. */
  async createSession(amountEuro) {
    const amount = Number(amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Invalid amount for Pay.nl.' };
    }

    const amountInCents = Math.round(amount * 100);
    const sessionId = createSessionId();
    const reference = `${this.config.referencePrefix}${sessionId.replace(/-/g, '').slice(0, 12)}`.toUpperCase();

    let res;
    try {
      res = await paynlClient(this.auth).post(ORDERS_URL, {
        serviceId: this.config.serviceId,
        amount: { value: amountInCents, currency: this.config.currency },
        description: 'POS payment',
        reference,
        paymentMethod: {
          id: TERMINAL_PAYMENT_METHOD_ID,
          input: { terminalCode: this.config.terminalCode },
        },
      });
    } catch (err) {
      return { success: false, message: `Could not reach Pay.nl: ${err.message}` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { success: false, message: describePaynlError(res, 'Pay.nl refused the payment') };
    }

    const order = res.data && typeof res.data === 'object' ? res.data : {};
    const orderId = String(order.id || '').trim();
    const statusUrl = String(order?.links?.status || '').trim() || (orderId ? `${ORDERS_URL}/${orderId}/status` : '');
    const abortUrl = String(order?.links?.abort || '').trim() || (orderId ? `${ORDERS_URL}/${orderId}/abort` : '');
    if (!statusUrl) {
      return { success: false, message: 'Pay.nl started the payment but returned no status link.' };
    }

    const session = {
      id: sessionId,
      orderId,
      statusUrl,
      abortUrl,
      amountInCents,
      reference,
      state: 'IN_PROGRESS',
      message: 'Payment in progress on terminal...',
      details: null,
      completed: false,
      createdAt: Date.now(),
      lastCheckedAt: 0,
      checking: null,
    };
    this.sessions.set(sessionId, session);

    // An order that is already final (e.g. refused at once) is settled without waiting for a poll.
    const first = mapOrderStatus(order);
    if (first.state !== 'IN_PROGRESS') this.settle(session, first.state, first.message, { status: order.status });

    return {
      success: true,
      sessionId,
      data: { state: session.state, message: session.message, amountInCents },
    };
  }

  /** One status request to Pay.nl, within its rate limit; a failed request leaves the session as it was. */
  async refresh(session) {
    const now = Date.now();
    if (now - session.createdAt > this.config.timeoutMs) {
      await this.abortOrder(session).catch(() => {});
      this.settle(session, 'ERROR', 'Terminal did not finish the payment in time.');
      return;
    }
    if (now - session.createdAt < FIRST_STATUS_DELAY_MS) return;
    if (now - session.lastCheckedAt < MIN_STATUS_INTERVAL_MS) return;
    session.lastCheckedAt = now;

    let res;
    try {
      // The status link needs no authentication (Pay.nl strips sensitive data from it).
      res = await paynlClient(null).get(session.statusUrl);
    } catch {
      return;
    }
    if (res.status === 404) {
      this.settle(session, 'ERROR', describePaynlError(res, 'Pay.nl no longer knows this payment'));
      return;
    }
    if (res.status < 200 || res.status >= 300 || !res.data || typeof res.data !== 'object') return;

    const mapped = mapOrderStatus(res.data);
    const details = { orderId: res.data.orderId || session.orderId, status: res.data.status };
    if (mapped.state === 'IN_PROGRESS') {
      session.message = mapped.message;
      session.details = details;
      return;
    }
    this.settle(session, mapped.state, mapped.message, details);
  }

  async getSessionStatus(sessionId) {
    if (!sessionId) return { success: false, ok: false, message: 'Session ID is required.' };
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, ok: false, message: 'Session not found.' };

    if (!session.completed) {
      // Concurrent polls share one request instead of each calling Pay.nl.
      if (!session.checking) {
        session.checking = this.refresh(session).finally(() => {
          session.checking = null;
        });
      }
      await session.checking;
    }

    return {
      success: true,
      ok: true,
      provider: 'paynl',
      sessionId,
      amountInCents: session.amountInCents,
      state: session.state,
      message: session.message,
      details: session.details,
    };
  }

  /** Order:Abort. Documented as PATCH; POST is tried only if the server says the method is wrong. */
  async abortOrder(session) {
    if (!session.abortUrl) return { ok: false, message: 'Pay.nl gave no abort link for this payment.' };
    const client = paynlClient(this.auth);
    let res = await client.patch(session.abortUrl);
    if (res.status === 405) res = await client.post(session.abortUrl);
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, message: describePaynlError(res, 'Pay.nl could not cancel the payment') };
  }

  /** What the cashier must know after a POS cancel while the terminal may still be waiting for a card. */
  cancelWarning(session) {
    const left = Math.ceil((TERMINAL_CARD_WAIT_MS - (Date.now() - session.createdAt)) / 1000);
    if (left <= 0) return null;
    return (
      'Pay.nl cancelled the payment, but the terminal cannot be stopped from the POS: it keeps asking '
      + `for the card for about ${left} more seconds. Press Stop/Cancel on the terminal itself.`
    );
  }

  async cancelSession(sessionId) {
    if (!sessionId) return { success: false, message: 'Session ID is required.' };
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, message: 'Session not found.' };
    if (session.completed) {
      // The pay screens ask again from their polling loop; the same warning must come back.
      const warning = session.cancelledByPos ? this.cancelWarning(session) : null;
      return { success: true, deliveredToTerminal: !warning, message: 'Payment already finished.', warning };
    }

    try {
      const aborted = await this.abortOrder(session);
      if (!aborted.ok) return { success: false, message: aborted.message };
      this.settle(session, 'CANCELLED', 'Payment cancelled.');
      session.cancelledByPos = true;
      const warning = this.cancelWarning(session);
      return {
        success: true,
        deliveredToTerminal: !warning,
        message: warning ? 'Payment cancelled in POS.' : 'Payment cancelled.',
        warning,
      };
    } catch (err) {
      return { success: false, message: err.message || 'Unable to cancel Pay.nl payment.' };
    }
  }
}

export function createPaynlService(terminal) {
  if (!terminal || !terminal.connection_string) {
    throw new Error('Terminal connection_string is missing.');
  }
  const config = parseTerminalConnection(terminal.connection_string);
  return new PaynlCloudConnectService(config);
}
