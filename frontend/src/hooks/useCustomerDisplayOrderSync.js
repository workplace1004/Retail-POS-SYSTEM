import { useCallback, useEffect, useRef, useState } from 'react';
import {
  openCustomerDisplayWindow,
  closeCustomerDisplayWindow,
  configureCustomerDisplay,
  customerDisplayBridge,
} from '../lib/customerDisplayWindow.js';
import {
  POS_PRICE_DISPLAY_STORAGE_KEY,
  POS_PRICE_DISPLAY_SETTINGS_CHANGED_EVENT,
  PRICE_DISPLAY_COLOR,
  readPriceDisplayType,
} from '../lib/posPriceDisplaySettings.js';

const CHANNEL_NAME = 'pos-customer-display-order-v1';
const LS_SNAPSHOT_KEY = 'pos_customer_display_order_v1';
const LS_CMD_KEY = 'pos_customer_display_cmd_v1';

const MSG_TICKET = 'ORDER_TICKET_SYNC';
const MSG_CLOSE = 'CMD_CLOSE';

const EMPTY_TICKET = { orderId: null, customerName: null, lines: [], total: 0, currency: 'EUR' };

function canUseBroadcastChannel() {
  return typeof BroadcastChannel !== 'undefined';
}

function writeLocalStorageSnapshot(payload) {
  try {
    const envelope = { v: 1, type: MSG_TICKET, ts: Date.now(), payload };
    localStorage.setItem(LS_SNAPSHOT_KEY, JSON.stringify(envelope));
  } catch {
    /* quota / private mode */
  }
}

function writeLocalStorageCloseCmd() {
  try {
    localStorage.setItem(LS_CMD_KEY, JSON.stringify({ v: 1, type: MSG_CLOSE, ts: Date.now() }));
  } catch {
    /* ignore */
  }
}

function readSnapshotFromStorage() {
  try {
    const raw = localStorage.getItem(LS_SNAPSHOT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && o.type === MSG_TICKET && o.payload) return o.payload;
  } catch {
    /* ignore */
  }
  return null;
}

function parseStorageEnvelope(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The ticket and the cash-payment overlay reach the display from two different components
 * (App publishes the order, OrderPanel the tendered/change pair), so both are held here and
 * every publish sends the merged snapshot. Otherwise each would clear the other.
 */
let currentTicket = null;
let currentPayment = null;
let publishingEnabled = false;
let lastSerialized = '';
/** @type {BroadcastChannel | null} */
let browserChannel = null;

function mergedSnapshot() {
  return { ...(currentTicket ?? EMPTY_TICKET), payment: currentPayment };
}

function publishSnapshot({ force = false } = {}) {
  if (!publishingEnabled) return;
  const body = mergedSnapshot();
  const serialized = JSON.stringify(body);
  if (!force && serialized === lastSerialized) return;
  lastSerialized = serialized;
  const stamped = { ...body, updatedAt: Date.now() };

  // Electron: the display is a separate BrowserWindow, reached over IPC. BroadcastChannel does
  // not cross windows under `file://`, so the bridge is the only transport there.
  const bridge = customerDisplayBridge();
  if (bridge) {
    bridge.update(stamped);
    return;
  }
  if (browserChannel) {
    try {
      browserChannel.postMessage({ v: 1, type: MSG_TICKET, ts: Date.now(), payload: stamped });
    } catch {
      /* ignore */
    }
  }
  writeLocalStorageSnapshot(stamped);
}

/**
 * Cash overpayment currently shown on the till (`{ received, change }`), or null.
 * Called from OrderPanel; mirrors the Received/Change panel onto the customer screen.
 */
export function setCustomerDisplayPayment(payment) {
  const next =
    payment && Number.isFinite(Number(payment.received))
      ? { received: Number(payment.received) || 0, change: Number(payment.change) || 0 }
      : null;
  const same = JSON.stringify(next) === JSON.stringify(currentPayment);
  if (same) return;
  currentPayment = next;
  publishSnapshot();
}

/**
 * Publishes order ticket snapshots to the customer display (Electron IPC, or BroadcastChannel +
 * localStorage in the browser).
 * @param {{ enabled: boolean, payload: object | null }} params
 */
export function useCustomerDisplayOrderPublisher({ enabled, payload }) {
  useEffect(() => {
    publishingEnabled = Boolean(enabled);
    if (!enabled) {
      lastSerialized = '';
      return undefined;
    }
    if (!customerDisplayBridge() && canUseBroadcastChannel()) {
      try {
        browserChannel = new BroadcastChannel(CHANNEL_NAME);
      } catch {
        browserChannel = null;
      }
    }
    return () => {
      publishingEnabled = false;
      try {
        browserChannel?.close();
      } catch {
        /* ignore */
      }
      browserChannel = null;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    currentTicket = payload ?? EMPTY_TICKET;
    publishSnapshot();
  }, [enabled, payload]);
}

/** Notify customer windows to close (browser transport only; Electron closes the window itself). */
export function broadcastCustomerDisplayClose() {
  currentTicket = null;
  currentPayment = null;
  lastSerialized = '';
  if (customerDisplayBridge()) return;
  if (canUseBroadcastChannel()) {
    try {
      const ch = new BroadcastChannel(CHANNEL_NAME);
      ch.postMessage({ v: 1, type: MSG_CLOSE, ts: Date.now() });
      ch.close();
    } catch {
      /* ignore */
    }
  }
  writeLocalStorageCloseCmd();
}

/**
 * Subscribes to ticket snapshots (customer display window).
 * @returns {{ ticket: object | null }}
 */
export function useCustomerDisplayOrderSubscriber() {
  const [ticket, setTicket] = useState(() =>
    customerDisplayBridge() ? null : readSnapshotFromStorage(),
  );

  const applyTicket = useCallback((body) => {
    if (body && typeof body === 'object') setTicket(body);
  }, []);

  // Electron: IPC, plus the snapshot the main process already holds so a window opened
  // mid-sale is not blank until the next keystroke.
  useEffect(() => {
    const bridge = customerDisplayBridge();
    if (!bridge) return undefined;
    const off = bridge.onUpdate(applyTicket);
    bridge
      .getState()
      .then((s) => {
        if (s) applyTicket(s);
      })
      .catch(() => {});
    return off;
  }, [applyTicket]);

  useEffect(() => {
    if (customerDisplayBridge()) return undefined;
    const onStorage = (e) => {
      if (e.key === LS_SNAPSHOT_KEY && e.newValue) {
        const o = parseStorageEnvelope(e.newValue);
        if (o?.type === MSG_TICKET && o.payload) applyTicket(o.payload);
      }
      if (e.key === LS_CMD_KEY && e.newValue) {
        const o = parseStorageEnvelope(e.newValue);
        if (o?.type === MSG_CLOSE) {
          try {
            window.close();
          } catch {
            /* ignore */
          }
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [applyTicket]);

  useEffect(() => {
    if (customerDisplayBridge()) return undefined;
    if (!canUseBroadcastChannel()) return undefined;
    let ch;
    try {
      ch = new BroadcastChannel(CHANNEL_NAME);
    } catch {
      return undefined;
    }
    const onMessage = (ev) => {
      const data = ev?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === MSG_TICKET && data.payload) applyTicket(data.payload);
      if (data.type === MSG_CLOSE) {
        try {
          window.close();
        } catch {
          /* ignore */
        }
      }
    };
    ch.onmessage = onMessage;
    return () => {
      try {
        ch.onmessage = null;
        ch.close();
      } catch {
        /* ignore */
      }
    };
  }, [applyTicket]);

  return { ticket };
}

/**
 * Reactive "Color display" flag from Control -> External devices -> Price display.
 * Only this mode drives a screen; "Two-line display" is a serial pole device.
 */
export function useColorDisplayEnabled() {
  const read = useCallback(() => readPriceDisplayType() === PRICE_DISPLAY_COLOR, []);

  const [on, setOn] = useState(() => read());

  useEffect(() => {
    const sync = () => setOn(read());
    const onStorage = (e) => {
      if (e.key === POS_PRICE_DISPLAY_STORAGE_KEY || e.key == null) sync();
    };
    window.addEventListener(POS_PRICE_DISPLAY_SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(POS_PRICE_DISPLAY_SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, [read]);

  return on;
}

/**
 * Opens the secondary display when Color display is saved (logged-in POS); closes it when the
 * setting is turned off or the cashier signs out.
 */
export function useCustomerDisplayWindowLifecycle({ userPresent, colorDisplayEnabled }) {
  const prevActiveRef = useRef(false);

  useEffect(() => {
    const active = Boolean(userPresent && colorDisplayEnabled);
    const prev = prevActiveRef.current;
    prevActiveRef.current = active;

    // Electron owns the window: tell the main process the current mode and let it open, move
    // or close the screen (it also reacts to monitors being plugged in or removed).
    if (customerDisplayBridge()) {
      configureCustomerDisplay(active ? PRICE_DISPLAY_COLOR : 'disabled');
      if (!active) broadcastCustomerDisplayClose();
      return;
    }

    if (!userPresent) {
      broadcastCustomerDisplayClose();
      closeCustomerDisplayWindow();
      return;
    }

    if (active) {
      openCustomerDisplayWindow();
      return;
    }

    if (prev && !active) {
      broadcastCustomerDisplayClose();
      closeCustomerDisplayWindow();
    }
  }, [userPresent, colorDisplayEnabled]);
}

export { useCustomerDisplayOrderPublisher as useBroadcastOrderChannel };
