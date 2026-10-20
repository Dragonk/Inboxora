import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scheduleInitialLayoutReady } from './messageBodyLayout.ts';

interface RafHarness {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
  runNext(): boolean;
  pending(): number;
  runCancelled(): void;
  cancelled: number[];
}

function rafHarness(): RafHarness {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const cancelledCallbacks = new Map<number, FrameRequestCallback>();
  const cancelled: number[] = [];
  return {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      cancelled.push(id);
      const callback = callbacks.get(id);
      if (callback !== undefined) cancelledCallbacks.set(id, callback);
      callbacks.delete(id);
    },
    runNext() {
      const next = callbacks.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback(0);
      return true;
    },
    pending: () => callbacks.size,
    runCancelled() {
      for (const callback of cancelledCallbacks.values()) callback(0);
      cancelledCallbacks.clear();
    },
    cancelled,
  };
}

describe('initial message body layout scheduling', () => {
  it('cancels the nested paint callback when the renderer unmounts after the outer paint', () => {
    const harness = rafHarness();
    const ready: unknown[] = [];
    const cancel = scheduleInitialLayoutReady(
      height => { ready.push(height); },
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );

    assert.equal(harness.pending(), 1);
    harness.runNext();
    assert.equal(harness.pending(), 1);

    cancel();
    assert.equal(harness.pending(), 0);
    harness.runCancelled();
    assert.equal(ready.length, 0);
    assert.equal(harness.cancelled.length, 1);
  });

  it('cancels a superseded nested paint callback before a replacement is scheduled', () => {
    const harness = rafHarness();
    const ready: unknown[] = [];
    const cancel = scheduleInitialLayoutReady(
      height => { ready.push(height); },
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );

    harness.runNext();
    cancel();
    assert.equal(harness.pending(), 0);
    harness.runCancelled();
    assert.equal(ready.length, 0);

    scheduleInitialLayoutReady(
      () => ready.push('replacement'),
      harness.requestAnimationFrame,
      harness.cancelAnimationFrame,
    );
    harness.runNext();
    harness.runNext();
    assert.deepEqual(ready, ['replacement']);
  });
});

describe('non-collapsing iframe measurement', () => {
  it('holds the outer height during shrink measurement and restores inline styles', async () => {
    const { measureMessageFrameHeight } = await import('./messageBodyLayout.ts');
    const props = new Map<string, [string, string]>([['min-height', ['20px', '']]]);
    const style = {
      getPropertyValue: (key: string) => props.get(key)?.[0] ?? '',
      getPropertyPriority: (key: string) => props.get(key)?.[1] ?? '',
      setProperty: (key: string, value: string, priority: string) => { props.set(key, [value, priority]); },
      removeProperty: (key: string) => { props.delete(key); },
    };
    const frame = {
      parentElement: { style, getBoundingClientRect: () => ({ height: 1500 }) },
      style: { height: '1474px' },
      contentDocument: { body: { get scrollHeight() {
        assert.equal(frame.style.height, '0px');
        assert.deepEqual(props.get('min-height'), ['1500px', 'important']);
        return 510;
      } } },
    };
    assert.equal(measureMessageFrameHeight(frame as unknown as HTMLIFrameElement), 510);
    assert.equal(frame.style.height, '510px');
    assert.deepEqual(props.get('min-height'), ['20px', '']);
    props.clear();
    assert.equal(measureMessageFrameHeight(frame as unknown as HTMLIFrameElement), 510);
    assert.equal(props.has('min-height'), false);
  });
});

describe('scale-to-width fit for wide email bodies', () => {
  const fitFrame = (viewportWidth: () => number, contentWidth: () => number) => {
    const props = new Map<string, [string, string]>();
    const attributes = new Map<string, string>();
    const body = {
      style: {
        getPropertyValue: (key: string) => props.get(key)?.[0] ?? '',
        getPropertyPriority: (key: string) => props.get(key)?.[1] ?? '',
        setProperty: (key: string, value: string, priority: string) => { props.set(key, [value, priority]); },
        removeProperty: (key: string) => { props.delete(key); },
      },
      get scrollWidth() { return contentWidth(); },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
    };
    return {
      frame: {
        clientWidth: 0,
        contentDocument: {
          body,
          documentElement: {
            get clientWidth() { return viewportWidth(); },
            get scrollWidth() { return contentWidth(); },
          },
        },
      },
      props,
      attributes,
    };
  };
  const marker = (attributes: Map<string, string>) => JSON.parse(attributes.get('data-mailflow-fit-scale') ?? 'null') as {
    scale: number;
    transform?: string;
    contentWidth?: number | null;
    fitViewportWidth?: number | null;
  };

  it('scales a body laid out wider than the frame down to the frame width', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    const { frame, props, attributes } = fitFrame(() => 350, () => 700);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    assert.deepEqual(props.get('transform'), ['scale(0.5)', 'important']);
    assert.deepEqual(props.get('transform-origin'), ['top left', 'important']);
    const saved = marker(attributes);
    assert.equal(saved.scale, 0.5);
    assert.equal(saved.contentWidth, 700);
    assert.equal(saved.fitViewportWidth, 350);
  });

  it('records a body that already fits at its natural size', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    const { frame, props, attributes } = fitFrame(() => 350, () => 350);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 1);
    assert.equal(props.has('transform'), false);
    const saved = marker(attributes);
    assert.equal(saved.scale, 1);
    assert.equal(saved.contentWidth, 350);
    assert.equal(saved.fitViewportWidth, 350);
  });

  it('keeps the fitted scale when the viewport shrinks over unchanged content (pinch zoom)', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    let viewportWidth = 350;
    const { frame, props, attributes } = fitFrame(() => viewportWidth, () => 700);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    viewportWidth = 175;
    // A pinch zoom reflows the WebView layout: the viewport halves while the
    // fixed-width content keeps its size. Recomputing the fit would scale the
    // body down to the shrunk viewport and cancel the zoom; the scale must
    // survive so the zoomed email pans inside the frame instead.
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    assert.deepEqual(props.get('transform'), ['scale(0.5)', 'important']);
    const saved = marker(attributes);
    assert.equal(saved.scale, 0.5);
    assert.equal(saved.contentWidth, 700);
    assert.equal(saved.fitViewportWidth, 175);
  });

  it('keeps a naturally sized body unscaled when the viewport shrinks over unchanged content', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    let viewportWidth = 350;
    const { frame, props, attributes } = fitFrame(() => viewportWidth, () => 350);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 1);
    viewportWidth = 175;
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 1);
    assert.equal(props.has('transform'), false);
    const saved = marker(attributes);
    assert.equal(saved.scale, 1);
    assert.equal(saved.fitViewportWidth, 175);
  });

  it('re-derives the fit when the viewport grows', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    let viewportWidth = 350;
    const { frame, props, attributes } = fitFrame(() => viewportWidth, () => 700);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    viewportWidth = 700;
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 1);
    assert.equal(props.has('transform'), false);
    const saved = marker(attributes);
    assert.equal(saved.scale, 1);
    assert.equal(saved.fitViewportWidth, 700);
  });

  it('re-derives the fit when the content width changes', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    let contentWidth = 700;
    const { frame, props } = fitFrame(() => 350, () => contentWidth);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    contentWidth = 1050;
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 350 / 1050);
    assert.deepEqual(props.get('transform'), [`scale(${Math.round((350 / 1050) * 10000) / 10000})`, 'important']);
  });

  it('treats a first-format marker without recorded widths as a reflow', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    const { frame, props, attributes } = fitFrame(() => 175, () => 700);
    attributes.set('data-mailflow-fit-scale', JSON.stringify({ scale: 0.5, transform: '', transformPriority: '', origin: '', originPriority: '' }));
    // Without the recorded widths the zoom guard cannot fire, so the fit is
    // recomputed from scratch instead of silently keeping a stale scale.
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.25);
    assert.deepEqual(props.get('transform'), ['scale(0.25)', 'important']);
    const saved = marker(attributes);
    assert.equal(saved.scale, 0.25);
    assert.equal(saved.fitViewportWidth, 175);
  });

  it('restores the email own inline transform once the body fits again', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    let contentWidth = 700;
    const { frame, props, attributes } = fitFrame(() => 350, () => contentWidth);
    props.set('transform', ['rotate(1deg)', '']);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 0.5);
    contentWidth = 350;
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement), 1);
    assert.deepEqual(props.get('transform'), ['rotate(1deg)', '']);
    const saved = marker(attributes);
    assert.equal(saved.scale, 1);
    assert.equal(saved.transform, 'rotate(1deg)');
  });

  it('does not touch the frame when the fit is disabled', async () => {
    const { fitMessageFrameToWidth } = await import('./messageBodyLayout.ts');
    const { frame, props, attributes } = fitFrame(() => 350, () => 700);
    assert.equal(fitMessageFrameToWidth(frame as unknown as HTMLIFrameElement, false), 1);
    assert.equal(props.has('transform'), false);
    assert.equal(attributes.size, 0);
  });

  it('measures the frame height in the scaled coordinate space', async () => {
    const { measureMessageFrameHeight } = await import('./messageBodyLayout.ts');
    const frame = {
      parentElement: { style: { getPropertyValue: () => '', getPropertyPriority: () => '', setProperty: () => {}, removeProperty: () => {} }, getBoundingClientRect: () => ({ height: 1500 }) },
      style: { height: '1474px' },
      contentDocument: { body: { get scrollHeight() { return 510; } } },
    };
    assert.equal(measureMessageFrameHeight(frame as unknown as HTMLIFrameElement, 0.5), 255);
    assert.equal(frame.style.height, '255px');
    assert.equal(measureMessageFrameHeight(frame as unknown as HTMLIFrameElement), 510);
    assert.equal(frame.style.height, '510px');
  });
});
