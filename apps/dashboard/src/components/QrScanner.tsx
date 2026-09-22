import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The scanner, in three tiers.
 *
 *   1. NATIVE BarcodeDetector — zero download, hardware accelerated, and on
 *      Android Chrome it is simply the best option available.
 *   2. @zxing/browser — a WASM/JS fallback for Safari and Firefox, which have
 *      no BarcodeDetector. Loaded LAZILY, so the ~200KB is paid for only by
 *      the browsers that need it.
 *   3. MANUAL SHORT CODE — the tier that actually matters in the rain. It is
 *      not a fallback for broken browsers so much as for broken conditions: a
 *      cracked lens, a filthy phone screen, a driver whose battery is dead.
 *
 * FEATURE-DETECT, DO NOT CATCH. `navigator.mediaDevices` is `undefined` — not
 * throwing — in an insecure context, so `typeof navigator.mediaDevices` has to
 * be tested before use. Wrapping getUserMedia in a try/catch would produce a
 * confusing "permission denied" when the real cause is that the page is on
 * plain http. That distinction is worth reporting precisely, because the fix
 * is completely different: see README, "Camera access in development".
 */

export type ScannerTier = 'native' | 'zxing' | 'unavailable';

export interface QrScannerProps {
  onScan: (text: string) => void;
  onClose: () => void;
  /** Forced in tests and screenshots, where there is no camera. */
  forceTier?: ScannerTier;
}

interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

/** True only in a secure context that actually exposes a camera API. */
export function cameraAvailable(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Deliberately a typeof check, not a try/catch — see the note above.
  if (typeof navigator.mediaDevices === 'undefined') return false;
  return typeof navigator.mediaDevices.getUserMedia === 'function';
}

export function detectTier(): ScannerTier {
  if (!cameraAvailable()) return 'unavailable';
  if ('BarcodeDetector' in globalThis) return 'native';
  return 'zxing';
}

export function QrScanner({ onScan, onClose, forceTier }: QrScannerProps): React.JSX.Element {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [tier, setTier] = useState<ScannerTier>(forceTier ?? 'unavailable');
  const [problem, setProblem] = useState<'insecure' | 'denied' | 'none'>('none');

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => {
      track.stop();
    });
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (forceTier) {
      setTier(forceTier);
      // A forced tier is for screenshots and tests: no camera is opened.
      return;
    }

    if (!cameraAvailable()) {
      setTier('unavailable');
      // THE distinction: no mediaDevices at all means an insecure context,
      // which is a developer setup problem, not a user permission problem.
      setProblem(window.isSecureContext ? 'none' : 'insecure');
      return;
    }

    /*
     * A holder, not a plain `let`.
     *
     * The flag is set by the cleanup function while `run` is suspended at an
     * await, so every check after an await is meaningful. TypeScript narrows a
     * captured `let` and then reports those checks as dead code — which they
     * are not. A property read cannot be narrowed the same way, so the guards
     * survive and the camera is still released when the component unmounts
     * mid-initialisation.
     */
    const run_ = { cancelled: false };
    /** Read through a call so the checks after each await are not narrowed away. */
    const cancelled = (): boolean => run_.cancelled;
    let raf = 0;

    const run = async (): Promise<void> => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // The BACK camera. facingMode 'environment' is a hint, not a
          // guarantee, but on a mounted tablet the front camera is useless.
          video: { facingMode: { ideal: 'environment' } },
        });
      } catch {
        if (!cancelled()) {
          setTier('unavailable');
          setProblem('denied');
        }
        return;
      }

      if (cancelled()) {
        stream.getTracks().forEach((track) => {
          track.stop();
        });
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      const active = detectTier();
      setTier(active);

      if (active === 'native') {
        const Ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor })
          .BarcodeDetector;
        const detector = new Ctor({ formats: ['qr_code'] });

        const tick = async (): Promise<void> => {
          if (cancelled() || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const first = codes[0];
            if (first) {
              onScan(first.rawValue);
              return;
            }
          } catch {
            // A transient detect failure (the frame was not ready) is normal;
            // the next frame will do.
          }
          raf = requestAnimationFrame(() => void tick());
        };
        raf = requestAnimationFrame(() => void tick());
        return;
      }

      // Tier 2, loaded only now, only by browsers that got here.
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      if (cancelled()) return;
      const reader = new BrowserQRCodeReader();
      await reader.decodeFromVideoElement(video, (result) => {
        if (result && !cancelled()) onScan(result.getText());
      });
    };

    void run();

    return () => {
      run_.cancelled = true;
      cancelAnimationFrame(raf);
      stop();
    };
  }, [forceTier, onScan, stop]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" data-testid="qr-scanner">
      <div className="flex items-center justify-between gap-3 bg-surface-raised p-4">
        <h2 className="text-xl font-extrabold text-ink">{t('scanner.title')}</h2>
        <button
          type="button"
          data-testid="scanner-close"
          onClick={() => {
            stop();
            onClose();
          }}
          className="rounded-lg border-2 border-line px-4 py-2 font-bold text-ink"
        >
          {t('action.close')}
        </button>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          data-testid="scanner-video"
          className="size-full object-cover"
        />

        {/* The aiming frame, so the attendant knows where to hold the phone. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute size-56 rounded-2xl border-4 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)]"
        />

        {tier === 'unavailable' ? (
          <div
            data-testid="scanner-unavailable"
            className="absolute inset-x-6 rounded-xl bg-surface-raised p-4 text-center"
          >
            <p className="text-base font-bold text-ink">
              {problem === 'insecure'
                ? t('scanner.insecureContext')
                : problem === 'denied'
                  ? t('scanner.permissionDenied')
                  : t('scanner.unavailable')}
            </p>
            <p className="mt-2 text-sm font-semibold text-ink-muted">{t('scanner.useShortCode')}</p>
          </div>
        ) : null}
      </div>

      <p className="bg-surface-raised p-4 text-center text-sm font-semibold text-ink-muted">
        {t('scanner.hint')}
      </p>
    </div>
  );
}
