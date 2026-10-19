type Choice = { value: number; label: string };

/** The settings selector used by Mail sync frequency and Undo Send. */
export default function SegmentedChoices({ choices, value, onChange, disabled = false, label, wrap = false }: { choices: Choice[]; value: number; onChange: (value: number) => void; disabled?: boolean; label: string; wrap?: boolean }) {
  return <div role="group" aria-label={label} style={{ display: 'flex', gap: 6, flexWrap: wrap ? 'wrap' : 'nowrap' }}>
    {choices.map(choice => {
      const active = value === choice.value;
      return <button key={choice.value} type="button" aria-pressed={active} disabled={disabled}
        onClick={() => onChange(choice.value)}
        style={{ flex: wrap ? '0 1 auto' : 1, padding: wrap ? '7px 10px' : '7px 4px', fontSize: 13, fontWeight: 500,
          background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
          border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
          borderRadius: 7, cursor: disabled ? 'default' : 'pointer', transition: 'all 0.15s',
          color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
        {choice.label}
      </button>;
    })}
  </div>;
}
