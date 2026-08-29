// @vitest-environment jsdom
/**
 * `AmbientLightSensor`, and the fact that almost nobody has one.
 *
 * Chrome does not expose the constructor unless
 * `chrome://flags/#enable-generic-sensor-extra-classes` has been switched on and
 * the browser relaunched, and even then the machine needs real hardware. So the
 * interesting case here is not a working sensor: it is the absent one, because
 * that is the path essentially every install takes, every time, and it has to
 * end in "no reading" rather than in an exception or a retry loop.
 *
 * The last block is the one that matters most. `LightSensor` and `evaluateGate`
 * live in different modules and neither one's own tests can see the join, which
 * is exactly where a contract quietly breaks: the sensor could report its
 * absence perfectly and the gate could still get it wrong. So the absent-sensor
 * case is followed all the way through to a gate decision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LightSensor } from '../src/content/light-sensor';
import { classifyLux, readingDarkness, type Darkness } from '../src/core/ambient';
import { evaluateGate } from '../src/core/gate';
import { sanitizeSettings } from '../src/core/settings';

type Listener = (event: Event) => void;

/** A stand-in for the real sensor, with the parts the wrapper touches. */
class FakeSensor {
  static instances: FakeSensor[] = [];
  static constructorError: Error | null = null;
  static startError: Error | null = null;

  illuminance: number | undefined = undefined;
  started = false;
  stopped = false;
  readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly options?: { frequency?: number }) {
    if (FakeSensor.constructorError) throw FakeSensor.constructorError;
    FakeSensor.instances.push(this);
  }

  start(): void {
    if (FakeSensor.startError) throw FakeSensor.startError;
    this.started = true;
  }

  stop(): void {
    this.stopped = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: Event = new Event(type)): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  /** Deliver one illuminance reading the way the real sensor does. */
  read(lux: number | undefined): void {
    this.illuminance = lux;
    this.emit('reading');
  }
}

/** Install (or remove) the constructor and the secure-context flag. */
function browser(options: { sensor?: boolean; secure?: boolean } = {}): void {
  const scope = window as unknown as Record<string, unknown>;
  if (options.sensor) scope.AmbientLightSensor = FakeSensor;
  else delete scope.AmbientLightSensor;
  Object.defineProperty(window, 'isSecureContext', {
    value: options.secure ?? true,
    configurable: true,
  });
}

let readings: number[];

beforeEach(() => {
  FakeSensor.instances = [];
  FakeSensor.constructorError = null;
  FakeSensor.startError = null;
  readings = [];
});

afterEach(() => {
  browser({});
  vi.restoreAllMocks();
});

describe('on a stock Chrome install', () => {
  it('settles as unavailable without throwing', () => {
    browser({});
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();

    expect(sensor.getState()).toBe('unavailable');
    expect(sensor.settled).toBe(true);
    expect(sensor.getNote()).toBeNull();
    expect(readings).toEqual([]);
  });

  it('stops asking, so the caller can call start() freely', () => {
    browser({});
    const sensor = new LightSensor((lux) => readings.push(lux));
    for (let i = 0; i < 100; i++) sensor.start();
    expect(FakeSensor.instances).toHaveLength(0);
  });

  it('stop() on something that never started is a no-op', () => {
    browser({});
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    expect(() => sensor.stop()).not.toThrow();
    expect(sensor.getState()).toBe('unavailable');
  });

  it('treats an insecure context the same way', () => {
    // The Generic Sensor API requires a secure context, so http:// pages get
    // nothing even with the flag on.
    browser({ sensor: true, secure: false });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    expect(sensor.getState()).toBe('unavailable');
    expect(FakeSensor.instances).toHaveLength(0);
  });
});

describe('with the flag on', () => {
  it('reads illuminance and reports it once', () => {
    browser({ sensor: true });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();

    expect(FakeSensor.instances).toHaveLength(1);
    const fake = FakeSensor.instances[0] as FakeSensor;
    expect(fake.started).toBe(true);
    expect(fake.options?.frequency).toBe(1);

    fake.read(12);
    expect(readings).toEqual([12]);
    expect(sensor.getState()).toBe('reading');
    expect(sensor.settled).toBe(false);
  });

  it('ignores a reading that is not a usable number', () => {
    browser({ sensor: true });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    const fake = FakeSensor.instances[0] as FakeSensor;

    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      fake.read(value as number | undefined);
    }
    expect(readings).toEqual([]);
    // A junk reading must not be mistaken for a working sensor either.
    expect(sensor.getState()).toBe('idle');
  });

  it('is blocked, with a note, when the permission policy refuses construction', () => {
    browser({ sensor: true });
    FakeSensor.constructorError = new Error('permissions policy');
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();

    expect(sensor.getState()).toBe('blocked');
    expect(sensor.settled).toBe(true);
    expect(sensor.getNote()).toMatch(/does not allow/i);
  });

  it('is blocked when start() itself throws', () => {
    browser({ sensor: true });
    FakeSensor.startError = new Error('nope');
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();

    expect(sensor.getState()).toBe('blocked');
    expect((FakeSensor.instances[0] as FakeSensor).stopped).toBe(true);
  });

  it('names the two error cases apart, because they mean different things', () => {
    for (const [name, expected] of [
      ['NotReadableError', /no ambient light sensor/i],
      ['NotAllowedError', /would not provide/i],
    ] as const) {
      browser({ sensor: true });
      FakeSensor.instances = [];
      const sensor = new LightSensor((lux) => readings.push(lux));
      sensor.start();
      const fake = FakeSensor.instances[0] as FakeSensor;
      const event = Object.assign(new Event('error'), { error: { name } });
      fake.emit('error', event);

      expect(sensor.getState()).toBe('blocked');
      expect(sensor.getNote()).toMatch(expected);
      // A blocked sensor is released rather than left running in the page.
      expect(fake.stopped).toBe(true);
      expect(fake.listeners.get('reading')?.size ?? 0).toBe(0);
    }
  });

  it('releases the sensor on stop and reports itself idle again', () => {
    browser({ sensor: true });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    const fake = FakeSensor.instances[0] as FakeSensor;
    fake.read(5);
    sensor.stop();

    expect(fake.stopped).toBe(true);
    expect(sensor.getState()).toBe('idle');
    // Detached: a late event from the sensor cannot reach the callback.
    fake.read(900);
    expect(readings).toEqual([5]);
  });

  it('survives a sensor that throws on stop', () => {
    browser({ sensor: true });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    const fake = FakeSensor.instances[0] as FakeSensor;
    vi.spyOn(fake, 'stop').mockImplementation(() => {
      throw new Error('already gone');
    });
    expect(() => sensor.stop()).not.toThrow();
  });
});

describe('the default path, end to end', () => {
  const settings = sanitizeSettings({});
  const at = (hours: number): number => hours * 60;

  it('an absent sensor leaves the clock in charge', () => {
    browser({});
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();

    // No sensor means no reading in session storage, which `readingDarkness`
    // turns into `unknown`, which is what makes the gate consult the clock.
    const darkness: Darkness = readingDarkness(null);
    expect(darkness).toBe('unknown');

    expect(evaluateGate({ settings, siteKeys: ['example.com'], darkness, nowMinutes: at(23) }))
      .toEqual({ active: true, reason: 'active', source: 'clock' });
    expect(evaluateGate({ settings, siteKeys: ['example.com'], darkness, nowMinutes: at(14) }))
      .toEqual({ active: false, reason: 'daytime', source: 'clock' });
  });

  it('a sensor that does report takes the clock out of the decision', () => {
    browser({ sensor: true });
    const sensor = new LightSensor((lux) => readings.push(lux));
    sensor.start();
    (FakeSensor.instances[0] as FakeSensor).read(4);

    const lux = readings.at(-1) as number;
    const darkness = classifyLux(lux);
    expect(darkness).toBe('dark');
    // 14:00, which the clock would refuse. The room wins, and the gate says so.
    expect(evaluateGate({ settings, siteKeys: ['example.com'], darkness, nowMinutes: at(14) }))
      .toEqual({ active: true, reason: 'active', source: 'sensor' });
  });

  it('a stale reading hands the decision back to the clock', () => {
    // A laptop closed overnight and reopened: yesterday's darkness must not
    // keep the extension switched on at nine in the morning.
    const old = { lux: 2, at: Date.now() - 7 * 60 * 60_000 };
    const darkness = readingDarkness(old);
    expect(darkness).toBe('unknown');
    expect(
      evaluateGate({ settings, siteKeys: ['example.com'], darkness, nowMinutes: at(9) }).source,
    ).toBe('clock');
  });
});
