/**
 * Continuous barcode scanning from the camera. Uses the browser's built-in
 * BarcodeDetector where available and falls back to ZXing (loaded on demand).
 */
import { useEffect, useRef, useState } from 'react';
import { isNative } from '../lib/platform';

export type ScannerStatus = 'starting' | 'running' | 'denied' | 'unavailable' | 'error';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];

interface DetectedBarcode {
  rawValue: string;
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats: string[] }): BarcodeDetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

export function useBarcodeScanner(onDetect: (code: string) => void, enabled = true) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<ScannerStatus>('starting');
  const handler = useRef(onDetect);
  useEffect(() => {
    handler.current = onDetect;
  }, [onDetect]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let zxingStop: (() => void) | undefined;

    let nativeStop: (() => Promise<void>) | undefined;

    /** Android app: ML Kit scans from a native camera view behind the (transparent) web view. */
    const startNative = async () => {
      try {
        const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
        const perm = await BarcodeScanner.requestPermissions();
        if (perm.camera !== 'granted' && perm.camera !== 'limited') {
          setStatus('denied');
          return;
        }
        if (stopped) return;
        document.documentElement.classList.add('native-scanning');
        const listener = await BarcodeScanner.addListener('barcodesScanned', (e) => {
          const first = e.barcodes[0]?.rawValue;
          if (first) handler.current(first);
        });
        await BarcodeScanner.startScan({
          formats: [
            BarcodeFormat.Ean13,
            BarcodeFormat.Ean8,
            BarcodeFormat.UpcA,
            BarcodeFormat.UpcE,
            BarcodeFormat.Code128,
            BarcodeFormat.Code39,
            BarcodeFormat.Itf,
          ],
        });
        nativeStop = async () => {
          document.documentElement.classList.remove('native-scanning');
          await listener.remove();
          await BarcodeScanner.stopScan();
        };
        if (stopped) await nativeStop();
        else setStatus('running');
      } catch {
        document.documentElement.classList.remove('native-scanning');
        setStatus('error');
      }
    };

    const start = async () => {
      if (isNative()) return startNative();
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch (e) {
        const name = (e as DOMException).name;
        setStatus(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      await video.play().catch(() => {});
      setStatus('running');

      let detector: BarcodeDetectorLike | null = null;
      if (window.BarcodeDetector) {
        try {
          const supported = (await window.BarcodeDetector.getSupportedFormats?.()) ?? FORMATS;
          const formats = FORMATS.filter((f) => supported.includes(f));
          if (formats.length) detector = new window.BarcodeDetector({ formats });
        } catch {
          detector = null;
        }
      }

      if (detector) {
        const loop = async () => {
          if (stopped) return;
          try {
            if (video.readyState >= 2) {
              const codes = await detector.detect(video);
              const first = codes[0]?.rawValue;
              if (first) handler.current(first);
            }
          } catch {
            // Frame not ready; try again.
          }
          timer = setTimeout(() => void loop(), 120);
        };
        void loop();
        return;
      }

      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        if (stopped) return;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 120, delayBetweenScanSuccess: 300 });
        const controls = await reader.decodeFromVideoElement(video, (result) => {
          if (result) handler.current(result.getText());
        });
        zxingStop = () => controls.stop();
      } catch {
        setStatus('error');
      }
    };
    void start();

    return () => {
      stopped = true;
      clearTimeout(timer);
      zxingStop?.();
      void nativeStop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled]);

  return { videoRef, status };
}

let audio: AudioContext | null = null;

/** Supermarket-till beep (and a lower double beep for problems). */
export function beep(kind: 'ok' | 'warn' = 'ok') {
  try {
    audio ??= new AudioContext();
    const tones = kind === 'ok' ? [[1400, 0, 0.09]] : [[520, 0, 0.12], [420, 0.16, 0.14]];
    for (const [freq, at, dur] of tones as [number, number, number][]) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(audio.destination);
      const t0 = audio.currentTime + at;
      osc.start(t0);
      osc.stop(t0 + dur);
    }
    navigator.vibrate?.(kind === 'ok' ? 50 : [60, 60, 60]);
  } catch {
    // Sound is a nicety.
  }
}
