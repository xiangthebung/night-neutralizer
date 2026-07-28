/**
 * Logging is off in production builds. `__DEV__` is replaced by esbuild, and
 * the `typeof` guard keeps the module usable in tests where it is undefined.
 */
declare const __DEV__: boolean | undefined;

const PREFIX = '[Night Neutralizer]';

function devBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export function debug(...args: unknown[]): void {
  if (!devBuild()) return;
  console.debug(PREFIX, ...args);
}

/**
 * Non-fatal problems. Kept at debug level even for warnings so the extension
 * never pollutes a site's console; production builds drop it entirely.
 */
export function warn(...args: unknown[]): void {
  if (!devBuild()) return;
  console.warn(PREFIX, ...args);
}
