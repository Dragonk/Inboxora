import { onAuthEpochChange } from '../../utils/authEpoch.ts';
import { useEffect, useRef, useState } from 'react';
/** Every async result is bound to its own dependencies and is cancelled on replacement. */
export function usePreviewResource<T>(load: (signal: AbortSignal) => Promise<T>, dependencies: readonly unknown[]) {
  const loader = useRef(load); loader.current = load;
  const [state, setState] = useState<{ value?: T; error?: string; loading: boolean; revision: number }>({ loading: true, revision: 0 });
  // The caller supplies the exact source dependencies. Compare them without a variable-length effect dependency list.
  const previous = useRef(dependencies); const [revision, setRevision] = useState(0);
  if (previous.current.length !== dependencies.length || dependencies.some((value, index) => !Object.is(value, previous.current[index]))) {
    previous.current = dependencies; setRevision(value => value + 1);
  }
  useEffect(() => {
    const controller = new AbortController(); const unsubscribe = onAuthEpochChange(() => controller.abort()); setState({ loading: true, revision });
    void loader.current(controller.signal).then(value => {
      if (!controller.signal.aborted) setState({ value, loading: false, revision });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setState({ error: error instanceof Error ? error.message : 'CORRUPT', loading: false, revision });
    });
    return () => { unsubscribe(); controller.abort(); };
  }, [revision]);
  return state.revision === revision ? state : { loading: true, revision };
}
export function useBlobUrl(blob: Blob | undefined): string | undefined {
  const [state, setState] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) { setState(undefined); return; }
    const next = URL.createObjectURL(blob); setState({ blob, url: next });
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return state?.blob === blob ? state?.url : undefined;
}
