type Choice = { value: number; label: string };

/** The settings selector used by Mail sync frequency and Undo Send. */
export default function SegmentedChoices({ choices, value, onChange, disabled = false, label }: {
  choices: Choice[]; value: number; onChange: (value: number) => void; disabled?: boolean; label: string;
}) {
  return <div role="group" aria-label={label} style={{ display: 'flex', gap: 6 }}>
    {choices.map(choice => {
      const active = value === choice.value;
      return <button key={choice.value} type="button" aria-pressed={active} disabled={disabled}
        onClick={() => onChange(choice.value)}
        style={{ flex: 1, padding: '7px 4px', fontSize: 13, fontWeight: 500,
          background: active ? 'var(--bg-hover)' : 'var(--bg-tertiary)',
          border: `2px solid ${active ? 'var(--accent)' : 'var(--border-subtle)'}`,
          borderRadius: 7, cursor: disabled ? 'default' : 'pointer', transition: 'all 0.15s',
          color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
        {choice.label}
      </button>;
    })}
  </div>;
}
