import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useBackLayer } from '../../hooks/useBackNavigation.ts';
import { Back } from './AccountUi.tsx';

/** A settings subpage, not another modal. Confirmation dialogs remain separate. */
export default function InlineEditor({ title, onClose, children, footer, busy = false, testId }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode;
  busy?: boolean; testId?: string; closeLabel?: string;
}) {
  const { t } = useTranslation();
  const id = useId(); const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useBackLayer(true, () => { if (!busy) onClose(); }, 2020);
  return <section className="au-workspace au-inline-editor" aria-labelledby={id} data-testid={testId}>
    <Back onClick={() => { if (!busy) onClose(); }}>{t('common.back')}</Back>
    <h2 id={id} ref={heading} tabIndex={-1}>{title}</h2>
    <fieldset className="au-form-fieldset" disabled={busy}>{children}</fieldset>
    {footer && <footer className="au-save-row">{footer}</footer>}
  </section>;
}
