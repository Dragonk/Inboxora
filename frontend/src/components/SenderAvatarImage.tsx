import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/index.ts';
import { avatarImageCandidates } from '../utils/senderAvatar.ts';
import type { CSSProperties } from 'react';
import type { StoreState } from '../store/index.ts';

const imageStyle: CSSProperties = {
  position: 'absolute', inset: 0,
  width: '100%', height: '100%', objectFit: 'cover',
};

export default function SenderAvatarImage({ email, hasContactPhoto }) {
  const loaded = useStore((state: StoreState) => state.senderFaviconsLoaded);
  const enabled = useStore((state: StoreState) => state.senderFavicons);
  const gravatarAvatars = useStore((state: StoreState) => state.gravatarAvatars);
  const candidates = useMemo(() => avatarImageCandidates({
    email,
    hasContactPhoto,
    gravatarAvatars,
    senderFavicons: loaded && enabled,
  }), [email, hasContactPhoto, gravatarAvatars, loaded, enabled]);
  const [failed, setFailed] = useState(() => new Set());

  useEffect(() => { setFailed(new Set()); }, [email, hasContactPhoto, gravatarAvatars, loaded, enabled]);

  const active = candidates.find(candidate => !failed.has(candidate.src));
  if (!active) return null;
  // Favicons are commonly alpha-transparent PNGs; back them with an opaque
  // themed surface so the initial letter and sender colour don't bleed through.
  const style: CSSProperties = active.kind === 'favicon'
    ? { ...imageStyle, background: 'var(--bg-elevated)' }
    : imageStyle;
  return (
    <img
      key={active.src}
      src={active.src}
      alt=""
      loading="lazy"
      decoding="async"
      style={style}
      onError={() => setFailed(current => new Set(current).add(active.src))}
    />
  );
}
