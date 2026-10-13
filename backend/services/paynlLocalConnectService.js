import crypto from 'crypto';
import dgram from 'dgram';
import net from 'net';

/**
 * Pay.nl Local Connect (in-person card payments over the shop LAN).
 *
 * The till opens a TCP socket to the terminal itself and exchanges JSON messages, so this works
 * with no internet, like the Payworld/CCV/Viva integrations beside it. The terminal can also be
 * found by UDP broadcast, which fills in its IP in Control.
 *
 * Docs: https://developer.pay.nl/docs/local-connect
 */

const sharedSessions = new Map();

const DEFAULT_PORT = 8888;
const DISCOVERY_PORT = 8889;
const DISCOVERY_PROBE = 'PAY.POS-WHO.IS';
const DISCOVERY_PREFIX = 'PAY.POS-I.AM:';

/** Connecting is quick; a payment is not (card insert, PIN, authorisation). */
const CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_TRANSACTION_TIMEOUT_MS = 180000;

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

  const ip = String(config.ip || config.host || '').trim();
  if (!ip) throw new Error('Pay.nl IP address not found in terminal configuration.');

  const parsedPort = Number.parseInt(String(config.port || DEFAULT_PORT).trim(), 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const timeoutRaw = Number.parseInt(String(config.timeoutMs || config.timeout || '').trim(), 10);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TRANSACTION_TIMEOUT_MS;
  const currency = String(config.currency || 'EUR').trim().toUpperCase() || 'EUR';
  const referencePrefix = String(config.referencePrefix || 'POS').trim() || 'POS';

  return { ip, port, timeoutMs, currency, referencePrefix };
}

/**
 * The protocol does not state how messages are framed, so accept both newline-delimited and
 * back-to-back JSON objects: track brace depth outside of strings and cut a value each time it
 * returns to zero. Anything that is not an object (stray whitespace, newlines) is skipped.
 */
function createMessageScanner(onMessage) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (ch === '}') {
        if (depth > 0) {
          depth -= 1;
          if (depth === 0 && start >= 0) {
            const slice = buffer.slice(start, i + 1);
            buffer = buffer.slice(i + 1);
            // The buffer was rewritten, so restart the scan over what is left.
            i = -1;
            start = -1;
            try {
              onMessage(JSON.parse(slice));
            } catch {
              /* a half-written or malformed object is dropped rather than killing the socket */
            }
          }
        }
      }
    }

    // Guard against a terminal that never closes an object.
    if (buffer.length > 512 * 1024) buffer = '';
  };
}

/** Terminal events → the states the POS payment screens already understand. */
function mapTransactionEvent(message) {
  const event = String(message?.event || '').toUpperCase();
  switch (event) {
    case 'STARTED':
      return { state: 'IN_PROGRESS', message: 'Payment started on terminal...' };
    case 'PROCESSING':
      return { state: 'IN_PROGRESS', message: 'Processing card...' };
    case 'QUEUED':
      return { state: 'IN_PROGRESS', message: 'Payment queued on terminal...' };
    case 'PIN_INPUT_PENDING':
      return { state: 'IN_PROGRESS', message: 'Waiting for PIN...' };
    case 'PIN_INPUT_ERROR':
      return { state: 'IN_PROGRESS', message: 'PIN entry failed, try again.' };
    case 'COMPLETED':
      if (message?.approved === true) {
        return { state: 'APPROVED', message: String(message?.message || '').trim() || 'Payment approved.' };
      }
      return { state: 'DECLINED', message: String(message?.message || '').trim() || 'Payment declined.' };
    case 'FAILED':
      return { state: 'ERROR', message: String(message?.message || '').trim() || 'Terminal error during payment.' };
    case 'CANCELLED':
      return { state: 'CANCELLED', message: 'Payment cancelled.' };
    default:
      return null;
  }
}

/** UDP broadcast so Control can list the terminals on this LAN with their IPs. */
export function discoverPaynlTerminals({ timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const found = new Map();
    let socket;
    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      resolve({ success: false, message: err.message || 'Unable to open a UDP socket.' });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    socket.on('error', (err) => finish({ success: false, message: err.message || 'Discovery failed.' }));

    socket.on('message', (buf, rinfo) => {
      const text = buf.toString('utf8').trim();
      if (!text.startsWith(DISCOVERY_PREFIX)) return;
      // PAY.POS-I.AM:TH-XXXX-XXXX:TERMINAL NAME — the name may itself contain colons.
      const rest = text.slice(DISCOVERY_PREFIX.length);
      const sep = rest.indexOf(':');
      const code = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
      const name = sep >= 0 ? rest.slice(sep + 1).trim() : '';
      if (!code) return;
      found.set(code, { code, name, ip: rinfo.address, port: DEFAULT_PORT });
    });

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* some stacks refuse broadcast; the probe below will simply find nothing */
      }
      const probe = Buffer.from(DISCOVERY_PROBE, 'utf8');
      socket.send(probe, 0, probe.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) finish({ success: false, message: err.message || 'Unable to send the discovery probe.' });
      });
      setTimeout(() => finish({ success: true, terminals: Array.from(found.values()) }), timeoutMs);
    });
  });
}

class PaynlLocalConnectService {
  constructor(config) {
    this.config = config;
    this.sessions = sharedSessions;
  }

  /** PING/PONG proves both the route to the terminal and that it is listening. */
  testConnection() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };

      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.on('timeout', () => finish({ success: false, message: 'Pay.nl terminal did not answer in time.' }));
      socket.on('error', (err) => finish({ success: false, message: `Pay.nl connection failed: ${err.message}` }));

      const scan = createMessageScanner((msg) => {
        if (String(msg?.type || '').toUpperCase() === 'PONG') {
          const status = String(msg?.status || '').trim();
          finish({ success: true, message: status ? `Terminal reachable (${status}).` : 'Terminal reachable.' });
        }
      });
      socket.on('data', (buf) => scan(buf.toString('utf8')));

      socket.connect(this.config.port, this.config.ip, () => {
        socket.write(JSON.stringify({ type: 'PING' }));
      });
    });
  }

  /**
   * Opens a socket for this payment and keeps it until the terminal reaches a final event, the
   * same fire-and-forget shape the other providers use: the till polls getSessionStatus.
   */
  createSession(amountEuro) {
    const amount = Number(amountEuro);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Invalid amount for Pay.nl.' };
    }

    const amountInCents = Math.round(amount * 100);
    const sessionId = createSessionId();
    const reference = `${this.config.referencePrefix}-${sessionId.slice(0, 8)}`;
    const session = {
      id: sessionId,
      amountInCents,
      reference,
      state: 'IN_PROGRESS',
      message: 'Connecting to terminal...',
      details: null,
      completed: false,
      createdAt: Date.now(),
      socket: null,
      timer: null,
    };
    this.sessions.set(sessionId, session);

    const settle = (state, message, details = null) => {
      const current = this.sessions.get(sessionId);
      if (!current || current.completed) return;
      current.state = state;
      current.message = message;
      if (details) current.details = details;
      current.completed = state !== 'IN_PROGRESS';
      if (current.completed) {
        if (current.timer) clearTimeout(current.timer);
        current.timer = null;
        try {
          current.socket?.destroy();
        } catch {
          /* ignore */
        }
        current.socket = null;
        setTimeout(() => this.sessions.delete(sessionId), 5 * 60 * 1000);
      }
      this.sessions.set(sessionId, current);
    };

    const socket = new net.Socket();
    session.socket = socket;
    this.sessions.set(sessionId, session);

    session.timer = setTimeout(() => {
      settle('ERROR', 'Terminal did not finish the payment in time.');
    }, this.config.timeoutMs);

    const scan = createMessageScanner((msg) => {
      const type = String(msg?.type || '').toUpperCase();
      if (type === 'ERROR') {
        settle('ERROR', String(msg?.reason || '').trim() || 'Terminal reported an error.', msg);
        return;
      }
      if (type !== 'TRANSACTION_EVENT') return;
      const mapped = mapTransactionEvent(msg);
      if (!mapped) return;
      if (mapped.state === 'IN_PROGRESS') {
        const current = this.sessions.get(sessionId);
        if (current && !current.completed) {
          current.message = mapped.message;
          current.details = msg;
          this.sessions.set(sessionId, current);
        }
        return;
      }
      settle(mapped.state, mapped.message, msg);
    });

    socket.on('data', (buf) => scan(buf.toString('utf8')));
    socket.on('error', (err) => settle('ERROR', `Terminal connection error: ${err.message}`));
    socket.on('close', () => {
      // A socket closing before a final event means the payment outcome is unknown.
      settle('ERROR', 'Terminal closed the connection before finishing.');
    });

    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.on('timeout', () => {
      // Only the connect phase is bounded; clear it once the terminal starts talking.
      const current = this.sessions.get(sessionId);
      if (current && current.state === 'IN_PROGRESS' && !current.details) {
        settle('ERROR', 'Terminal did not answer in time.');
      }
    });

    socket.connect(this.config.port, this.config.ip, () => {
      socket.setTimeout(0);
      const current = this.sessions.get(sessionId);
      if (current && !current.completed) {
        current.message = 'Payment in progress on terminal...';
        this.sessions.set(sessionId, current);
      }
      socket.write(
        JSON.stringify({
          type: 'TRANSACTION_START',
          transaction: {
            type: 'PAYMENT',
            amount: { value: amountInCents, currency: this.config.currency },
            reference,
          },
        }),
      );
    });

    return {
      success: true,
      sessionId,
      data: { state: session.state, message: session.message, amountInCents },
    };
  }

  /** The socket pushes events, so status is read straight from the local session. */
  async getSessionStatus(sessionId) {
    if (!sessionId) return { success: false, ok: false, message: 'Session ID is required.' };
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, ok: false, message: 'Session not found.' };

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

  async cancelSession(sessionId) {
    if (!sessionId) return { success: false, message: 'Session ID is required.' };
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, message: 'Session not found.' };
    if (session.completed) return { success: true, message: 'Payment already finished.' };

    const socket = session.socket;
    if (!socket || socket.destroyed) {
      session.state = 'CANCELLED';
      session.message = 'Payment cancelled.';
      session.completed = true;
      this.sessions.set(sessionId, session);
      return { success: true, message: 'Payment cancelled.' };
    }

    try {
      // The terminal answers with a CANCELLED event, which closes the session via the scanner.
      socket.write(JSON.stringify({ type: 'TRANSACTION_STOP' }));
      return { success: true, message: 'Cancelling payment on terminal...' };
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
  return new PaynlLocalConnectService(config);
}
