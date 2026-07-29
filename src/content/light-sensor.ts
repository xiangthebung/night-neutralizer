/**
 * `AmbientLightSensor`, wrapped so its absence is a normal outcome.
 *
 * Reality check on availability, because it shapes the whole design: Chromium
 * implements the sensor but does not expose the constructor to pages unless
 * `chrome://flags/#enable-generic-sensor-extra-classes` has been switched on and
 * the browser relaunched, and even then the device needs an actual light sensor —
 * common on laptops and phones, rare on desktops. So on a stock Chrome install
 * `start()` finishes in the `unavailable` state and the caller uses the clock
 * instead. That is the expected path, not an error worth surfacing as one.
 *
 * The other constraints:
 *  - Sensors need a secure context, and the `ambient-light-sensor` permission
 *    policy defaults to `self`, so a cross-origin iframe cannot read one. Only
 *    the top-level frame runs this; the reading is shared from there.
 *  - Readings arrive about once a second and stop while the page is hidden.
 *    Throttling and sharing are the caller's job (`core/ambient.ts`).
 */
import { debug } from '../core/log';

/**
 * Minimal shape of the sensor. Declared here because it is absent from
 * TypeScript's DOM library, precisely because it is not a shipped API.
 */
interface AmbientLightSensorLike {
  readonly illuminance?: number;
  start(): void;
  stop(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

type AmbientLightSensorCtor = new (options?: {
  frequency?: number;
}) => AmbientLightSensorLike;

export type LightSensorState =
  /** Not started yet. */
  | 'idle'
  /** Running and delivering readings. */
  | 'reading'
  /** No such API in this browser, or no secure context. */
  | 'unavailable'
  /** The API exists but this page may not use it, or there is no hardware. */
  | 'blocked';

/** One reading per second is plenty for "has someone turned the light on?". */
const SENSOR_FREQUENCY_HZ = 1;

export class LightSensor {
  private sensor: AmbientLightSensorLike | null = null;
  private state: LightSensorState = 'idle';
  private note: string | null = null;

  constructor(private readonly onLux: (lux: number) => void) {}

  getState(): LightSensorState {
    return this.state;
  }

  getNote(): string | null {
    return this.note;
  }

  /** True once the sensor is known not to be usable, so callers can stop asking. */
  get settled(): boolean {
    return this.state === 'unavailable' || this.state === 'blocked';
  }

  start(): void {
    if (this.sensor || this.settled) return;

    const Ctor = (window as unknown as { AmbientLightSensor?: AmbientLightSensorCtor })
      .AmbientLightSensor;
    if (typeof Ctor !== 'function' || !window.isSecureContext) {
      this.state = 'unavailable';
      return;
    }

    let sensor: AmbientLightSensorLike;
    try {
      sensor = new Ctor({ frequency: SENSOR_FREQUENCY_HZ });
    } catch (error) {
      // Construction itself throws when the permission policy forbids it.
      debug('ambient light sensor unavailable', error);
      this.state = 'blocked';
      this.note = 'This page does not allow reading the ambient light sensor.';
      return;
    }

    sensor.addEventListener('reading', this.onReading);
    sensor.addEventListener('error', this.onError);
    this.sensor = sensor;

    try {
      sensor.start();
    } catch (error) {
      debug('ambient light sensor refused to start', error);
      this.fail('The ambient light sensor could not be started.');
    }
  }

  stop(): void {
    const sensor = this.sensor;
    this.sensor = null;
    if (!sensor) return;
    sensor.removeEventListener('reading', this.onReading);
    sensor.removeEventListener('error', this.onError);
    try {
      sensor.stop();
    } catch {
      /* already stopped, or the page is going away */
    }
    if (this.state === 'reading') this.state = 'idle';
  }

  private readonly onReading = (): void => {
    const lux = this.sensor?.illuminance;
    if (typeof lux !== 'number' || !Number.isFinite(lux) || lux < 0) return;
    this.state = 'reading';
    this.onLux(lux);
  };

  private readonly onError = (event: Event): void => {
    const name = (event as Event & { error?: { name?: string } }).error?.name ?? '';
    debug('ambient light sensor error', name);
    // NotAllowedError: permission policy or user refusal.
    // NotReadableError: no sensor on this machine.
    this.fail(
      name === 'NotReadableError'
        ? 'No ambient light sensor on this device.'
        : 'The browser would not provide ambient light readings.',
    );
  };

  private fail(note: string): void {
    this.stop();
    this.state = 'blocked';
    this.note = note;
  }
}
