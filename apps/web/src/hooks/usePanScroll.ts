import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Minimal pointer fields used by pan (avoids React PointerEvent currentTarget mismatch). */
export interface PanPointerEvent {
  button: number;
  pointerId: number;
  clientX: number;
  clientY: number;
  target: EventTarget | null;
  preventDefault(): void;
}

export const PAN_THRESHOLD_PX = 4;

const PAN_IGNORE_SELECTOR =
  '.device-node, [data-port-id], .connection-group, .fuse-marker, .ampacity-marker, .wire-label';

export interface PanSession {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  originScrollLeft: number;
  originScrollTop: number;
  didPan: boolean;
}

export interface PanUpdateResult {
  scrollLeft: number;
  scrollTop: number;
  didPan: boolean;
}

/** True when the event started on a device, port, wire, label, or marker. */
export function shouldIgnorePanTarget(target: EventTarget | null): boolean {
  if (target == null) return false;
  const el = target as { closest?: (selector: string) => unknown };
  if (typeof el.closest !== 'function') return false;
  return el.closest(PAN_IGNORE_SELECTOR) != null;
}

export function createPanSession(
  pointerId: number,
  clientX: number,
  clientY: number,
  scrollLeft: number,
  scrollTop: number,
): PanSession {
  return {
    pointerId,
    startClientX: clientX,
    startClientY: clientY,
    originScrollLeft: scrollLeft,
    originScrollTop: scrollTop,
    didPan: false,
  };
}

/** Apply pointer movement to scroll offsets. Drag right pans content right (scrollLeft decreases). */
export function updatePanSession(
  session: PanSession,
  clientX: number,
  clientY: number,
): PanUpdateResult {
  const dx = clientX - session.startClientX;
  const dy = clientY - session.startClientY;
  const distanceSq = dx * dx + dy * dy;
  const didPan = session.didPan || distanceSq > PAN_THRESHOLD_PX * PAN_THRESHOLD_PX;
  session.didPan = didPan;
  return {
    scrollLeft: session.originScrollLeft - dx,
    scrollTop: session.originScrollTop - dy,
    didPan,
  };
}

export function endPanSession(session: PanSession | null): { didPan: boolean; suppressClick: boolean } {
  if (!session) return { didPan: false, suppressClick: false };
  return { didPan: session.didPan, suppressClick: session.didPan };
}

/**
 * Whether a pointerdown should start a pan:
 * - empty background (primary button), or
 * - middle mouse, or
 * - Space held (primary button, including over devices).
 */
export function shouldStartPan(opts: {
  button: number;
  target: EventTarget | null;
  spaceHeld: boolean;
}): boolean {
  const { button, target, spaceHeld } = opts;
  if (button === 1) return true;
  if (button !== 0) return false;
  if (spaceHeld) return true;
  return !shouldIgnorePanTarget(target);
}

export interface UsePanScrollOptions {
  canvasRef: RefObject<HTMLElement | null>;
}

export function usePanScroll({ canvasRef }: UsePanScrollOptions) {
  const sessionRef = useRef<PanSession | null>(null);
  const spaceHeldRef = useRef(false);
  const suppressClickRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement | null)?.isContentEditable) return;
      e.preventDefault();
      spaceHeldRef.current = true;
      setSpaceHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    const onBlur = () => {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const onPointerDown = useCallback(
    (e: PanPointerEvent) => {
      if (
        !shouldStartPan({
          button: e.button,
          target: e.target,
          spaceHeld: spaceHeldRef.current === true,
        })
      ) {
        return false;
      }

      // Middle-button: prevent browser autoscroll.
      if (e.button === 1) e.preventDefault();

      const el = canvasRef.current;
      if (!el) return false;

      sessionRef.current = createPanSession(
        e.pointerId,
        e.clientX,
        e.clientY,
        el.scrollLeft,
        el.scrollTop,
      );
      el.setPointerCapture(e.pointerId);
      setIsPanning(true);
      return true;
    },
    [canvasRef],
  );

  const onPointerMove = useCallback(
    (e: PanPointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== e.pointerId) return false;

      const el = canvasRef.current;
      if (!el) return false;

      const next = updatePanSession(session, e.clientX, e.clientY);
      el.scrollLeft = Math.max(0, next.scrollLeft);
      el.scrollTop = Math.max(0, next.scrollTop);
      return true;
    },
    [canvasRef],
  );

  const onPointerUp = useCallback(
    (e: PanPointerEvent) => {
      const session = sessionRef.current;
      if (!session || session.pointerId !== e.pointerId) return false;

      const { suppressClick } = endPanSession(session);
      suppressClickRef.current = suppressClick;
      sessionRef.current = null;
      setIsPanning(false);

      const el = canvasRef.current;
      if (el?.hasPointerCapture?.(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      return true;
    },
    [canvasRef],
  );

  const consumeSuppressClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  const isActive = sessionRef.current != null || isPanning;
  const cursorClass = isPanning || spaceHeld ? 'canvas-panning' : '';

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    consumeSuppressClick,
    isPanning: isActive,
    spaceHeld,
    cursorClass,
    /** For leave-handler gating without stale closures. */
    hasActiveSession: () => sessionRef.current != null,
  };
}
