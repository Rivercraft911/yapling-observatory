function formatNumber(value: number | null | undefined, significantDigits: number): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude < 0.01 || magnitude >= 10_000) {
    const [mantissa, exponent] = value.toExponential(significantDigits - 1).split('e');
    return `${Number(mantissa)}e${Number(exponent)}`;
  }
  const rounded = Number(value.toPrecision(significantDigits));
  return Math.abs(rounded) >= 10_000 ? formatNumber(rounded, significantDigits) : `${rounded}`;
}

export function formatValue(value: number | null | undefined, digits?: number): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (digits !== undefined && Number.isFinite(digits)) {
    const decimals = Math.max(0, Math.min(6, Math.trunc(digits)));
    return value.toFixed(decimals);
  }
  return formatNumber(value, 3);
}

export function formatElapsedSeconds(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(1);
}

export function formatAxisValues(values: readonly number[]): string[] {
  const distinctValues = new Set(values.filter(Number.isFinite)).size;
  let labels: string[] = [];
  for (let precision = 2; precision <= 6; precision++) {
    labels = values.map((value) => formatNumber(value, precision));
    const distinctLabels = new Set(labels.filter((_, index) => Number.isFinite(values[index])));
    if (distinctLabels.size === distinctValues) break;
  }
  return labels;
}
