import { describe, expect, it } from 'vitest';
import {
  createPanSession,
  endPanSession,
  PAN_THRESHOLD_PX,
  shouldIgnorePanTarget,
  shouldStartPan,
  updatePanSession,
} from './usePanScroll';

/** Minimal EventTarget stand-in so tests do not need jsdom. */
function fakeTarget(matchingSubstring: string | null): EventTarget {
  return {
    closest(selector: string) {
      if (matchingSubstring == null) return null;
      return selector.includes(matchingSubstring) ? this : null;
    },
  } as unknown as EventTarget;
}

describe('shouldIgnorePanTarget', () => {
  it('ignores events that start on a device', () => {
    expect(shouldIgnorePanTarget(fakeTarget('.device-node'))).toBe(true);
  });

  it('ignores events that start on a port', () => {
    expect(shouldIgnorePanTarget(fakeTarget('[data-port-id]'))).toBe(true);
  });

  it('allows empty background', () => {
    expect(shouldIgnorePanTarget(fakeTarget(null))).toBe(false);
  });
});

describe('shouldStartPan', () => {
  it('starts on empty background with primary button', () => {
    expect(
      shouldStartPan({ button: 0, target: fakeTarget(null), spaceHeld: false }),
    ).toBe(true);
  });

  it('does not start on a device with primary button unless Space is held', () => {
    const device = fakeTarget('.device-node');
    expect(shouldStartPan({ button: 0, target: device, spaceHeld: false })).toBe(false);
    expect(shouldStartPan({ button: 0, target: device, spaceHeld: true })).toBe(true);
  });

  it('starts on middle mouse even over a device', () => {
    expect(
      shouldStartPan({ button: 1, target: fakeTarget('.device-node'), spaceHeld: false }),
    ).toBe(true);
  });
});

describe('pan threshold and click suppression', () => {
  it('does not mark didPan or suppress click below the threshold', () => {
    const session = createPanSession(1, 100, 100, 40, 20);
    const mid = updatePanSession(session, 100 + PAN_THRESHOLD_PX - 1, 100);
    expect(mid.didPan).toBe(false);
    const end = endPanSession(session);
    expect(end.suppressClick).toBe(false);
  });

  it('marks didPan and suppressClick once the drag passes the threshold', () => {
    const session = createPanSession(1, 100, 100, 40, 20);
    const moved = updatePanSession(session, 100 + PAN_THRESHOLD_PX + 1, 100);
    expect(moved.didPan).toBe(true);
    expect(moved.scrollLeft).toBe(40 - (PAN_THRESHOLD_PX + 1));
    expect(moved.scrollTop).toBe(20);
    const end = endPanSession(session);
    expect(end.suppressClick).toBe(true);
  });

  it('updates scrollTop when dragging vertically', () => {
    const session = createPanSession(1, 50, 50, 0, 80);
    const moved = updatePanSession(session, 50, 50 + 30);
    expect(moved.scrollTop).toBe(50);
    expect(moved.scrollLeft).toBe(0);
  });
});
