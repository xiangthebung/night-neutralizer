// @vitest-environment jsdom
/**
 * The two things the popup's live block asks of the video engine: a state
 * that says "installed, waiting" rather than "off" before the first frame,
 * and a Compare that takes the curve off — and only the curve — for exactly
 * as long as it is held, while the engine keeps measuring underneath it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoEngine } from '../src/content/video-engine';
import { mapVideoStrength } from '../src/core/strength';

const params = mapVideoStrength(45);
const STYLE_ID = 'nn-tone-style';

let luma: number;

function installCanvasStub(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        drawImage: () => undefined,
        getImageData: () => {
          const data = new Uint8ClampedArray(48 * 27 * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = luma;
            data[i + 1] = luma;
            data[i + 2] = luma;
            data[i + 3] = 255;
          }
          return { data };
        },
      }) as unknown as CanvasRenderingContext2D,
  );
}

interface FakeVideo {
  element: HTMLVideoElement;
  presentFrame(): void;
}

function fakeVideo(): FakeVideo {
  const element = document.createElement('video');
  Object.defineProperty(element, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(element, 'videoHeight', { value: 1080, configurable: true });
  Object.defineProperty(element, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(element, 'paused', { value: false, configurable: true });
  const state = { pending: null as (() => void) | null };
  Object.defineProperty(element, 'requestVideoFrameCallback', {
    configurable: true,
    value: (callback: (now: number) => void) => {
      state.pending = () => callback(0);
      return 1;
    },
  });
  Object.defineProperty(element, 'cancelVideoFrameCallback', {
    configurable: true,
    value: () => {
      state.pending = null;
    },
  });
  document.body.appendChild(element);
  return {
    element,
    presentFrame() {
      const run = state.pending;
      state.pending = null;
      run?.();
    },
  };
}

const rule = (): string => document.getElementById(STYLE_ID)?.textContent ?? '';
const table = (): string => document.querySelector('feFuncR')?.getAttribute('tableValues') ?? '';

let engine: VideoEngine;

beforeEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  for (const node of document.querySelectorAll(`svg, #${STYLE_ID}`)) node.remove();
  vi.spyOn(CSS, 'supports').mockReturnValue(true);
  vi.useFakeTimers();
  luma = 200;
  installCanvasStub();
  engine = new VideoEngine(document, () => {});
});

afterEach(() => {
  engine.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('before the first frame', () => {
  it('reports idle, not off, so a paused player reads as waiting', () => {
    engine.setParams(params, true);
    expect(engine.getStatus().mode).toBe('idle');
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
    // Nothing to meter yet either.
    expect(engine.getMeter()).toEqual({ mode: 'idle', lightRatio: null });
  });

  it('becomes adaptive once a frame has been measured', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    video.presentFrame();
    expect(engine.getStatus().mode).toBe('adaptive');
    const meter = engine.getMeter();
    expect(meter.mode).toBe('adaptive');
    // A bright flat frame is over the light budget, so the curve dims it.
    expect(meter.lightRatio).not.toBeNull();
    expect(meter.lightRatio as number).toBeLessThan(1);
  });

  it('meters a dark frame as a lift', () => {
    luma = 8;
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    for (let i = 0; i < 120; i++) video.presentFrame();
    expect(engine.getMeter().lightRatio as number).toBeGreaterThan(1.2);
  });
});

describe('Compare', () => {
  it('takes the curve off the rule while held and puts it back on release', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    video.presentFrame();
    expect(rule()).toContain('url(');

    engine.setHold(true);
    expect(rule()).not.toContain('url(');
    // The mark and the definition stay: nothing is torn down, only the rule.
    expect(video.element.getAttribute('data-nn-tone')).toBe('1');
    expect(document.getElementById('nn-tone-curve')).not.toBeNull();

    engine.setHold(false);
    expect(rule()).toContain('url(');
  });

  it('keeps measuring underneath, so release restores the current curve', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    video.presentFrame();
    const before = table();

    engine.setHold(true);
    luma = 8;
    for (let i = 0; i < 120; i++) video.presentFrame();
    const during = table();
    expect(during).not.toBe(before);
    engine.setHold(false);
    expect(table()).toBe(during);
  });

  it('survives a settings change while held, and writes no rule that would override the site', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    engine.setHold(true);
    engine.setParams(mapVideoStrength(70), true);
    // Still held: a strength change must not put the curve back early.
    expect(rule()).not.toContain('url(');
    // With nothing else to carry, the rule is empty rather than `filter:none
    // !important`, which would have overridden the site's own filters.
    expect(rule()).toBe('');
    engine.setHold(false);
    expect(rule()).toContain('url(');
  });

  it('keeps the page compensation on the rule while the curve is off', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    engine.setPageCompensation('invert(1) hue-rotate(180deg)');
    engine.setHold(true);
    expect(rule()).toContain('invert(1) hue-rotate(180deg)');
    expect(rule()).not.toContain('url(');
  });

  it('does not outlive being switched off', () => {
    const video = fakeVideo();
    engine.add(video.element);
    engine.setParams(params, true);
    engine.setHold(true);
    engine.setParams(params, false);
    engine.setHold(false);
    engine.setParams(params, true);
    expect(rule()).toContain('url(');
  });
});
