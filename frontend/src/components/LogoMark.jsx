export default function LogoMark({ size = 32 }) {
  return (
    <img
      src="/inboxora-mark.svg"
      width={size}
      height={size}
      alt="Inboxora"
      style={{ flexShrink: 0, display: 'block' }}
    />
  );
}