export default function LogoMark({ size = 32 }) {
  return (
    <img
      src="/inboxora-icon-512.png"
      width={size}
      height={size}
      alt="Inboxora"
      style={{ flexShrink: 0, borderRadius: Math.round(size * 0.22) }}
    />
  );
}