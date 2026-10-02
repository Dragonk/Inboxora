import { useEffect, useRef, type RefObject } from 'react';

interface Props {
  html: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  htmlRef?: RefObject<HTMLDivElement | null>;
}

/** The signature surface shared by the normal composer and human-approved MCP mail. */
export default function ComposeSignatureField({ html, value, onChange, disabled = false, htmlRef }: Props) {
  const internal = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!html || htmlRef || !internal.current || internal.current === document.activeElement) return;
    if (internal.current.innerHTML !== value) internal.current.innerHTML = value;
  }, [html, htmlRef, value]);
  if (!html) return <textarea value={value} disabled={disabled} onChange={e => onChange(e.target.value)} style={{
    width: '100%', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6,
    background: 'transparent', border: 'none', outline: 'none', resize: 'none',
    fontFamily: 'var(--font-sans, DM Sans, sans-serif)', boxSizing: 'border-box',
  }} />;
  return <div ref={node => {
    internal.current = node;
    if (htmlRef) (htmlRef as { current: HTMLDivElement | null }).current = node;
    if (node && !htmlRef && node.innerHTML !== value) node.innerHTML = value;
  }} contentEditable={!disabled} spellCheck={false} suppressContentEditableWarning onInput={() => onChange(internal.current?.innerHTML || '')}
    style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, outline: 'none' }} />;
}
