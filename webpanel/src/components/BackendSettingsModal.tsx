import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, Server, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";
import { isApiBaseUrlPinnedByEnv } from "@/lib/api";
import {
  DEFAULT_BACKEND_HOST,
  DEFAULT_BACKEND_PORT,
  backendBaseUrl,
  parseBackendInput,
  pingBackend,
  readBackendSettings,
  saveBackendSettings,
  type BackendSettings,
} from "@/lib/backendSettings";
import { resetRealtimeSocket } from "@/lib/realtime";

/** Sensible first guess: the host serving the panel, or loopback under file:// */
function prefillFromEnvironment(): { host: string; port: string } {
  const saved = readBackendSettings();
  if (saved) return { host: saved.host, port: saved.port };
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    if ((protocol === "http:" || protocol === "https:") && hostname) {
      return { host: hostname, port: DEFAULT_BACKEND_PORT };
    }
  }
  return { host: DEFAULT_BACKEND_HOST, port: DEFAULT_BACKEND_PORT };
}

type ProbeState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; baseUrl: string }
  | { kind: "failed"; baseUrl: string }
  | { kind: "invalid" };

export function BackendSettingsModal({
  open,
  dismissible = false,
  initialUnreachable = false,
  onSaved,
  onDismiss,
}: {
  open: boolean;
  /** The startup gate cannot be dismissed; reopening it from Account can. */
  dismissible?: boolean;
  initialUnreachable?: boolean;
  onSaved: (settings: BackendSettings) => void;
  onDismiss?: () => void;
}) {
  const { t } = useLanguage();
  const [host, setHost] = useState(() => prefillFromEnvironment().host);
  const [port, setPort] = useState(() => prefillFromEnvironment().port);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  // A startup probe that already failed should be visible the moment the modal opens.
  useEffect(() => {
    if (!open || !initialUnreachable) return;
    const saved = readBackendSettings();
    if (saved) setProbe({ kind: "failed", baseUrl: backendBaseUrl(saved) });
  }, [open, initialUnreachable]);

  const commit = useCallback(
    (settings: BackendSettings) => {
      saveBackendSettings(settings);
      resetRealtimeSocket();
      onSaved(settings);
    },
    [onSaved],
  );

  const runProbe = useCallback(async (): Promise<BackendSettings | null> => {
    const settings = parseBackendInput(host, port);
    if (!settings) {
      setProbe({ kind: "invalid" });
      return null;
    }
    const baseUrl = backendBaseUrl(settings);
    setProbe({ kind: "testing" });
    const ok = await pingBackend(baseUrl);
    setProbe(ok ? { kind: "ok", baseUrl } : { kind: "failed", baseUrl });
    return ok ? settings : null;
  }, [host, port]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const settings = await runProbe();
      if (settings) commit(settings);
    } finally {
      setSaving(false);
    }
  }, [commit, runProbe]);

  /** Escape hatch: /api/health can be blocked by a proxy while the rest of the API still works. */
  const handleSaveAnyway = useCallback(() => {
    const settings = parseBackendInput(host, port);
    if (!settings) {
      setProbe({ kind: "invalid" });
      return;
    }
    commit(settings);
  }, [commit, host, port]);

  const busy = saving || probe.kind === "testing";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onDismiss?.();
      }}
    >
      <DialogContent
        hideClose={!dismissible}
        className="max-w-md"
        onEscapeKeyDown={(e) => {
          if (!dismissible) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (!dismissible) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!dismissible) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            {t("backendSettingsTitle")}
          </DialogTitle>
          <DialogDescription>{t("backendSettingsDescription")}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="backend-host">{t("backendHostLabel")}</Label>
            <Input
              id="backend-host"
              value={host}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              placeholder={t("backendHostPlaceholder")}
              onChange={(e) => {
                setHost(e.target.value);
                setProbe({ kind: "idle" });
              }}
            />
            <p className="text-xs text-muted-foreground">{t("backendHostHint")}</p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="backend-port">{t("backendPortLabel")}</Label>
            <Input
              id="backend-port"
              value={port}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              placeholder={DEFAULT_BACKEND_PORT}
              onChange={(e) => {
                setPort(e.target.value);
                setProbe({ kind: "idle" });
              }}
            />
          </div>

          {probe.kind === "invalid" ? (
            <p className="flex items-center gap-1.5 text-sm text-destructive">
              <XCircle className="h-4 w-4 shrink-0" />
              {t("backendInvalidAddress")}
            </p>
          ) : null}

          {probe.kind === "ok" ? (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>
                {t("backendReachable")} &mdash; {probe.baseUrl}
              </span>
            </p>
          ) : null}

          {probe.kind === "failed" ? (
            <p className="flex items-start gap-1.5 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {t("backendUnreachable")} &mdash; {probe.baseUrl}
              </span>
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          {dismissible ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDismiss?.()}>
              {t("cancel")}
            </Button>
          ) : null}
          {probe.kind === "failed" ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={handleSaveAnyway}>
              {t("backendSaveAnyway")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                void runProbe();
              }}
            >
              {probe.kind === "testing" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {probe.kind === "testing" ? t("backendTesting") : t("backendTestConnection")}
            </Button>
          )}
          <Button
            size="sm"
            disabled={busy}
            className="bg-gradient-primary text-primary-foreground hover:opacity-90"
            onClick={() => {
              void handleSave();
            }}
          >
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {t("backendSaveConnect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type GateStatus = "checking" | "configure" | "ready";

/**
 * Nothing that talks to the API may mount until the backend address is known: the panel and the
 * backend live on different PCs, so the AuthProvider /auth/me call on mount would otherwise fire
 * at the wrong host. Keep this ABOVE AuthProvider in the tree.
 */
export function BackendSettingsGate({ children }: { children: ReactNode }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState<GateStatus>(() =>
    isApiBaseUrlPinnedByEnv() ? "ready" : "checking",
  );
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (isApiBaseUrlPinnedByEnv()) return undefined;
    const saved = readBackendSettings();
    if (!saved) {
      setStatus("configure");
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const ok = await pingBackend(backendBaseUrl(saved));
      if (cancelled) return;
      setUnreachable(!ok);
      setStatus(ok ? "ready" : "configure");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "ready") return <>{children}</>;

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background">
      {status === "checking" ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("backendCheckingConnection")}
        </div>
      ) : (
        <BackendSettingsModal
          open
          initialUnreachable={unreachable}
          onSaved={() => setStatus("ready")}
        />
      )}
    </div>
  );
}
