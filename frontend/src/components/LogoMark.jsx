export default function LogoMark({ size = 32 }) {
  return (
    <span className="inboxora-logo-mark" style={{ width: size, height: size }}>
      <img
        src="/inboxora-ui-logo-light.png?v=inboxora-2"
        width={size}
        height={size}
        alt="Inboxora"
        className="inboxora-logo-mark__light"
      />
      <img
        src="/inboxora-ui-logo-dark.png?v=inboxora-2"
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        className="inboxora-logo-mark__dark"
      />
    </span>
  );
}