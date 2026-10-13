import crypto from 'crypto';
import http from 'http';
import https from 'https';

/**
 * Viva.com Local Terminal API (peer-to-peer): the till talks straight to the terminal on the shop
 * network, https://<terminal ip>:<port>/pos/v1/... — no login, self-signed certificate.
 * Spec: https://developer.viva.com/apis-for-point-of-sale/card-terminals-devices/peer-to-peer-communication/
 */

const sharedSessions = new Map();

/** The terminal answers a sale or abort request at once; a status poll even faster. */
const REQUEST_TIMEOUT_MS = 12000;
const STATUS_TIMEOUT_MS = 6000;
/** An abort is only a request: how long to wait for the terminal's verdict on the sale. */
const CANCEL_VERDICT_WAIT_MS = 8000;
/** Unusable status answers in a row before the payment is reported as failed. */
const MAX_BAD_STATUS_ANSWERS = 5;
const KEEP_FINISHED_SESSION_MS = 5 * 60 * 1000;

const APPROVED_BEFORE_CANCEL =
  'Too late to cancel: the payment was already approved on the terminal.';

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `viva-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EVENT_ID_MESSAGES = {
  1000: 'Transaction canceled by user.',
  1001: 'Terminal SDK is busy.',
  1003: 'Terminal timed out.',
  1004: 'Transaction declined by terminal.',
  1006: 'Transaction declined by server.',
  1007: 'Transaction declined by card.',
  1010: 'Invalid card.',
  1016: 'Transaction aborted.',
  1019: 'Try another card.',
  1020: 'Insufficient funds.',
  1099: 'Generic transaction error.',
  3000: 'Terminal is not connected.',
  3001: 'Terminal connection error.',
  3002: 'Terminal connection timeout.',
  3099: 'Generic terminal error.',
  4000: 'Network connection error.',
  6000: 'Wrong request parameters.',
};
/** Sale ended because someone stopped it (customer on the terminal, or an abort from the till). */
const CANCEL_EVENT_IDS = new Set([1000, 1016]);

function parseBool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value == null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
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

  const ip = String(config.ip || config.host || '').trim();
  if (!ip) throw new Error('Viva IP address not found in terminal configuration.');

  const parsedPort = Number.parseInt(String(config.port || '9564').trim(), 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 9564;
  const protocolRaw = String(config.protocol || '').trim().toLowerCase();
  const protocol = protocolRaw === 'http' ? 'http' : 'https';
  const rejectUnauthorized = parseBool(config.rejectUnauthorized, false);
  const currencyCodeRaw = String(config.currencyCode || '978').trim();
  const currencyCode = currencyCodeRaw || '978';
  const showTransactionResult = parseBool(config.showTransactionResult, true);
  const showReceipt = parseBool(config.showReceipt, true);
  const paymentMethod = String(config.paymentMethod || 'CardPresent').trim() || 'CardPresent';
  const merchantReferencePrefix = String(config.merchantReferencePrefix || 'POS').trim() || 'POS';
  const customerTrnsPrefix = String(config.customerTrnsPrefix || 'POS payment').trim() || 'POS payment';

  return {
    ip,
    port,
    protocol,
    rejectUnauthorized,
    currencyCode,
    showTransactionResult,
    showReceipt,
    paymentMethod,
    merchantReferencePrefix,
    customerTrnsPrefix,
  };
}

/** What to tell the cashier when the terminal cannot be reached at all. */
function unreachableMessage(config, err) {
  return (
    `Viva terminal not reachable at ${config.ip}:${config.port} (${err?.message || err}). ` +
    'Check that the terminal is on and on the same network as this PC, that the IP address and port ' +
    'are right, and that peer-to-peer is switched on in the Viva.com Terminal app.'
  );
}

/** Readable form of a non-2xx answer; the terminal sends plain text for a bad request. */
function answerText(response) {
  const fromBody = response?.body?.message || response?.body?.error;
  if (fromBody) return String(fromBody);
  const raw = String(response?.raw || '').trim();
  return raw ? raw.slice(0, 200) : `HTTP ${response?.status}`;
}

function mapSessionState(vivaState, saleResponse = null) {
  const state = String(vivaState || '').toUpperCase();
  if (state === 'PROCESSING' || state === 'PENDING') return 'IN_PROGRESS';
  if (state === 'SUCCESS') {
    if (saleResponse && (saleResponse.isSuccess === false || saleResponse.merchantApproved === false)) {
      return 'DECLINED';
    }
    return 'APPROVED';
  }
  if (state === 'CANCELLED' || state === 'ABORTED') return 'CANCELLED';
  if (state === 'FAILED' || state === 'FAILURE' || state === 'DECLINED') {
    const stopped = saleResponse?.isAbortRequested === true || CANCEL_EVENT_IDS.has(Number(saleResponse?.eventId));
    return stopped ? 'CANCELLED' : 'DECLINED';
  }
  // The terminal lost the payment (app restarted, or the sale never reached it): nothing will come.
  if (state === 'SESSION_NOT_FOUND_ERROR') return 'ERROR';
  if (state === 'ERROR') return 'ERROR';
  // SERVER_ERROR and anything unknown: the customer may still be paying, keep asking.
  return 'IN_PROGRESS';
}

function inferMessage(vivaState, saleResponse, mappedState) {
  if (String(vivaState || '').toUpperCase() === 'SESSION_NOT_FOUND_ERROR') {
    return 'The Viva terminal does not know this payment. Check the terminal before charging again.';
  }
  const eventId = Number(saleResponse?.eventId);
  const rawMessage = String(saleResponse?.message || '').trim();
  const fromEvent = Number.isFinite(eventId) ? EVENT_ID_MESSAGES[eventId] : '';
  if (mappedState === 'APPROVED') return rawMessage || 'Payment approved.';
  if (mappedState === 'DECLINED') return rawMessage || fromEvent || 'Payment declined.';
  if (mappedState === 'CANCELLED') return rawMessage || fromEvent || 'Payment cancelled.';
  if (mappedState === 'ERROR') return rawMessage || fromEvent || 'Error during payment.';
  return 'Payment in progress on terminal...';
}

function requestJson(config, method, path, body = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = config.protocol === 'https' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = mod.request(
      {
        host: config.ip,
        port: config.port,
        method,
        path,
        headers: payload
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          }
          : {},
        timeout: timeoutMs,
        rejectUnauthorized: config.rejectUnauthorized,
      },
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          chunks += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = chunks ? JSON.parse(chunks) : null;
          } catch {
            parsed = null;
          }
          resolve({
            status: Number(res.statusCode || 0),
            ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
            body: parsed,
            raw: chunks,
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

class VivaP2PService {
  constructor(config) {
    this.config = config;
    this.sessions = sharedSessions;
  }

  async testConnection() {
    const probeSessionId = createSessionId();
    try {
      const response = await requestJson(
        this.config,
        'GET',
        `/pos/v1/sessions/${encodeURIComponent(probeSessionId)}`,
        null,
        STATUS_TIMEOUT_MS,
      );
      if (response.status === 400 || response.status === 404 || response.ok) {
        return { success: true, message: 'Viva terminal is reachable.' };
      }
      return { success: false, message: `Viva terminal probe failed: ${answerText(response)}` };
    } catch (err) {
      return { success: false, message: unreachableMessage(this.config, err) };
    }
  }

  /** What the till's status poll gets back for a session this service knows. */
  report(session) {
    return {
      success: true,
      ok: true,
      provider: 'viva',
      sessionId: session.id,
      amountInCents: session.amountInCents,
      state: session.state,
      message: session.message,
      details: session.details,
    };
  }

  /** Final verdict: kept for a while, because the till still asks and the terminal forgets. */
  finish(session, state, message, details = session.details) {
    session.state = state;
    session.message = message;
    session.details = details;
    session.completed = true;
    this.sessions.set(session.id, session);
    const timer = setTimeout(() => this.sessions.delete(session.id), KEEP_FINISHED_SESSION_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Shows the amount on the terminal. Resolves once the terminal has accepted the sale, so a
   * terminal that is off, on another network or busy is reported to the cashier straight away.
   */
  async createSession(amountEuro) {
    const amount = Number(amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Invalid amount for Viva.' };
    }

    const amountInCents = Math.round(amount * 100);
    const sessionId = createSessionId();
    const payload = {
      sessionId,
      amount: amountInCents,
      merchantReference: `${this.config.merchantReferencePrefix}-${sessionId}`,
      customerTrns: `${this.config.customerTrnsPrefix}-${sessionId.slice(0, 8)}`,
      paymentMethod: this.config.paymentMethod,
      showTransactionResult: this.config.showTransactionResult,
      showReceipt: this.config.showReceipt,
      currencyCode: this.config.currencyCode,
    };

    let response;
    try {
      response = await requestJson(this.config, 'POST', '/pos/v1/sale', payload);
    } catch (err) {
      return { success: false, message: unreachableMessage(this.config, err) };
    }
    if (!response.ok) {
      return { success: false, message: `Viva terminal refused the payment: ${answerText(response)}` };
    }

    const saleResponse = response.body?.payloadData?.saleResponse || null;
    const state = mapSessionState(response.body?.state, saleResponse);
    const message = inferMessage(response.body?.state, saleResponse, state);
    if (state !== 'IN_PROGRESS' && state !== 'APPROVED') {
      return { success: false, message: `Viva terminal did not start the payment: ${message}` };
    }

    const session = {
      id: sessionId,
      amountInCents,
      state: 'IN_PROGRESS',
      message: 'Payment in progress on terminal...',
      details: response.body || null,
      completed: false,
      createdAt: Date.now(),
      badAnswers: 0,
      cancelling: null,
    };
    this.sessions.set(sessionId, session);
    if (state === 'APPROVED') this.finish(session, state, message);

    return {
      success: true,
      sessionId,
      data: { state: session.state, message: session.message, amountInCents },
    };
  }

  async getSessionStatus(sessionId) {
    if (!sessionId) {
      return { success: false, ok: false, message: 'Session ID is required.' };
    }
    const local = this.sessions.get(sessionId);
    if (local?.completed) return this.report(local);

    let response;
    try {
      response = await requestJson(
        this.config,
        'GET',
        `/pos/v1/sessions/${encodeURIComponent(sessionId)}`,
        null,
        STATUS_TIMEOUT_MS,
      );
    } catch (err) {
      if (!local) return { success: false, ok: false, message: unreachableMessage(this.config, err) };
      // The customer may be paying right now; a lost connection does not end the payment.
      local.message = `Viva terminal does not answer (${err.message}). Still trying...`;
      return this.report(local);
    }

    if (!response.ok) {
      if (!local) {
        return { success: false, ok: false, message: `Session not found (${answerText(response)}).` };
      }
      local.badAnswers += 1;
      if (local.badAnswers >= MAX_BAD_STATUS_ANSWERS) {
        this.finish(
          local,
          'ERROR',
          `Viva terminal keeps answering with an error (${answerText(response)}). Check the terminal before charging again.`,
          response.body || response.raw || null,
        );
      }
      return this.report(local);
    }

    const saleResponse = response.body?.payloadData?.saleResponse || null;
    const mappedState = mapSessionState(response.body?.state, saleResponse);
    const message = inferMessage(response.body?.state, saleResponse, mappedState);
    const session = local || {
      id: sessionId,
      amountInCents: Number(saleResponse?.amount) || 0,
      createdAt: Date.now(),
      badAnswers: 0,
      cancelling: null,
    };
    session.badAnswers = 0;
    if (mappedState === 'IN_PROGRESS') {
      session.state = 'IN_PROGRESS';
      session.message = message;
      session.details = response.body || null;
      session.completed = false;
      this.sessions.set(sessionId, session);
    } else {
      this.finish(session, mappedState, message, response.body || null);
    }
    return this.report(session);
  }

  /**
   * Stops the sale on the terminal and waits for the terminal's verdict. A card accepted in the
   * same moment wins: then the answer says `approved` and the till must book the payment.
   */
  async cancelSession(sessionId) {
    if (!sessionId) return { success: false, message: 'Session ID is required.' };
    const local = this.sessions.get(sessionId);
    // The till asks twice for one cancel; both get the one verdict.
    if (local?.cancelling) return local.cancelling;
    const verdict = this.abortAndWait(sessionId);
    if (local) {
      local.cancelling = verdict;
      verdict.finally(() => {
        local.cancelling = null;
      });
    }
    return verdict;
  }

  async abortAndWait(sessionId) {
    const known = this.sessions.get(sessionId);
    if (known?.completed) {
      return known.state === 'APPROVED'
        ? { success: false, approved: true, message: APPROVED_BEFORE_CANCEL }
        : { success: true, message: 'Payment cancelled.' };
    }

    let response;
    try {
      response = await requestJson(this.config, 'POST', '/pos/v1/abort', { sessionId });
    } catch (err) {
      return {
        success: false,
        message: `Could not reach the Viva terminal to cancel (${err.message}). Cancel on the terminal itself.`,
      };
    }
    if (!response.ok) {
      return {
        success: false,
        message: `Viva terminal refused the cancel (${answerText(response)}). Cancel on the terminal itself.`,
      };
    }

    const deadline = Date.now() + CANCEL_VERDICT_WAIT_MS;
    for (;;) {
      await this.getSessionStatus(sessionId);
      const session = this.sessions.get(sessionId);
      if (session?.completed) {
        if (session.state === 'APPROVED') {
          return { success: false, approved: true, message: APPROVED_BEFORE_CANCEL };
        }
        // Declined, aborted or unknown to the terminal: either way no money was taken.
        this.finish(session, 'CANCELLED', 'Payment cancelled.');
        return { success: true, message: 'Payment cancelled.' };
      }
      if (Date.now() >= deadline) break;
      await sleep(500);
    }
    return {
      success: true,
      message: 'Cancel sent to the terminal.',
      warning:
        'The Viva terminal has not confirmed the cancel yet. Look at the terminal: if it still asks for the card, press cancel on it.',
    };
  }
}

export function createVivaService(terminal) {
  if (!terminal || !terminal.connection_string) {
    throw new Error('Terminal connection_string is missing.');
  }
  const config = parseTerminalConnection(terminal.connection_string);
  return new VivaP2PService(config);
}
