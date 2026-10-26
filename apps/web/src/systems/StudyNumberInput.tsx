export function NumberInput({
  label,
  value,
  onChange,
  unit = '',
  min,
  max,
  step = 0.1,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="field-row">
      <span>{label}</span>
      <span className="study-number">
        <input
          aria-label={label}
          type="number"
          value={Number(value.toFixed(6))}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber))
              onChange(e.target.valueAsNumber);
          }}
        />
        {unit && <small>{unit}</small>}
      </span>
    </label>
  );
}
