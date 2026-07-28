// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MediaRegistry } from '../src/content/media-registry';

type MediaHandler = Mock<(element: HTMLMediaElement) => void>;

/** Wait for the registry's microtask batching to settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MediaRegistry', () => {
  let onAttach: MediaHandler;
  let onDetach: MediaHandler;
  let registry: MediaRegistry;

  beforeEach(() => {
    document.body.innerHTML = '';
    onAttach = vi.fn<(element: HTMLMediaElement) => void>();
    onDetach = vi.fn<(element: HTMLMediaElement) => void>();
    registry = new MediaRegistry({ onAttach, onDetach, removalGraceMs: 1000 });
  });

  afterEach(() => {
    registry.stop();
    vi.useRealTimers();
  });

  it('discovers media present before it starts', () => {
    document.body.innerHTML = `
      <video id="a"></video>
      <div><audio id="b"></audio></div>
      <p>no media here</p>
    `;
    registry.start(document);

    expect(onAttach).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(2);
    const ids = onAttach.mock.calls.map(([element]) => (element as HTMLElement).id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('discovers media added later', async () => {
    registry.start(document);
    expect(onAttach).not.toHaveBeenCalled();

    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<span><video id="late"></video></span>';
    document.body.appendChild(wrapper);
    await flush();

    expect(onAttach).toHaveBeenCalledTimes(1);
    expect((onAttach.mock.calls[0]?.[0] as HTMLElement).id).toBe('late');
  });

  it('discovers a media element appended directly', async () => {
    registry.start(document);
    document.body.appendChild(document.createElement('video'));
    await flush();
    expect(registry.size).toBe(1);
  });

  it('never attaches the same element twice', async () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    registry.start(document);
    expect(onAttach).toHaveBeenCalledTimes(1);

    // Explicit re-attach, a second full scan, and a DOM move all have to be
    // no-ops: creating a second Web Audio source node for one element would
    // break its audio permanently.
    expect(registry.attach(video)).toBe(false);
    registry.scan(document);
    const other = document.createElement('div');
    document.body.appendChild(other);
    other.appendChild(video);
    await flush();

    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(1);
  });

  it('reports whether an element is tracked', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    registry.start(document);
    expect(registry.has(video)).toBe(true);
    expect(registry.has(document.createElement('video'))).toBe(false);
  });

  it('finds media inside open shadow roots and observes them', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<video id="shadowed"></video>';

    registry.start(document);
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect((onAttach.mock.calls[0]?.[0] as HTMLElement).id).toBe('shadowed');

    shadow.appendChild(document.createElement('audio'));
    await flush();
    expect(registry.size).toBe(2);
  });

  it('ignores closed shadow roots without throwing', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const closed = host.attachShadow({ mode: 'closed' });
    closed.innerHTML = '<video></video>';
    expect(() => registry.start(document)).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('detaches only after the grace period and only if still disconnected', async () => {
    vi.useFakeTimers();
    const video = document.createElement('video');
    document.body.appendChild(video);
    registry.start(document);

    video.remove();
    await flush();
    expect(onDetach).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('keeps an element that is re-parented during the grace period', async () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    const video = document.createElement('video');
    container.appendChild(video);
    document.body.appendChild(container);
    registry.start(document);

    // Typical SPA behaviour: the player is moved, not destroyed.
    video.remove();
    await flush();
    const newHome = document.createElement('section');
    document.body.appendChild(newHome);
    newHome.appendChild(video);
    await flush();

    vi.advanceTimersByTime(5000);
    expect(onDetach).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
    // ...and it is still deduplicated afterwards.
    expect(registry.attach(video)).toBe(false);
  });

  it('detaches media removed as part of a subtree', async () => {
    vi.useFakeTimers();
    const player = document.createElement('div');
    player.innerHTML = '<div><video></video><audio></audio></div>';
    document.body.appendChild(player);
    registry.start(document);
    expect(registry.size).toBe(2);

    player.remove();
    await flush();
    vi.advanceTimersByTime(1000);

    expect(onDetach).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);
  });

  it('handles an element being swapped for a new one', async () => {
    vi.useFakeTimers();
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    slot.innerHTML = '<video id="first"></video>';
    registry.start(document);
    expect(onAttach).toHaveBeenCalledTimes(1);

    slot.innerHTML = '<video id="second"></video>';
    await flush();
    vi.advanceTimersByTime(1000);

    expect(onAttach).toHaveBeenCalledTimes(2);
    expect((onAttach.mock.calls[1]?.[0] as HTMLElement).id).toBe('second');
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect((onDetach.mock.calls[0]?.[0] as HTMLElement).id).toBe('first');
    expect(registry.size).toBe(1);
  });

  it('falls back to a full rescan under a mutation storm', async () => {
    registry.start(document);
    const fragmentCount = 200;
    for (let i = 0; i < fragmentCount; i++) {
      document.body.appendChild(document.createElement('span'));
    }
    document.body.appendChild(document.createElement('video'));
    await flush();

    expect(registry.size).toBe(1);
    expect(onAttach).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing attach handler', () => {
    const boom = new MediaRegistry({
      onAttach: vi.fn<(element: HTMLMediaElement) => void>(() => {
        throw new Error('engine failed');
      }),
      onDetach,
    });
    document.body.innerHTML = '<video></video><video></video>';
    expect(() => boom.start(document)).not.toThrow();
    expect(boom.size).toBe(2);
    boom.stop();
  });

  it('release() tears down a single element immediately', () => {
    const video = document.createElement('video');
    document.body.appendChild(video);
    registry.start(document);
    registry.release(video);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(registry.size).toBe(0);
  });

  it('stop() detaches everything and stops observing', async () => {
    document.body.innerHTML = '<video></video><audio></audio>';
    registry.start(document);
    registry.stop();
    expect(onDetach).toHaveBeenCalledTimes(2);
    expect(registry.size).toBe(0);

    document.body.appendChild(document.createElement('video'));
    await flush();
    expect(onAttach).toHaveBeenCalledTimes(2); // no new attaches after stop
  });

  it('start() is idempotent so a second injection cannot double-observe', async () => {
    document.body.innerHTML = '<video></video>';
    registry.start(document);
    registry.start(document);
    document.body.appendChild(document.createElement('audio'));
    await flush();
    expect(onAttach).toHaveBeenCalledTimes(2);
  });
});
