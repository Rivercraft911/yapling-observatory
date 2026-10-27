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

const rateUnits = [
  { unit: 'b/s', factor: 1 },
  { unit: 'kb/s', factor: 1e3 },
  { unit: 'Mb/s', factor: 1e6 },
  { unit: 'Gb/s', factor: 1e9 },
];

export function selectRateUnit(unit: string, series: readonly (readonly (number | null)[])[]) {
  const input = rateUnits.find((entry) => entry.unit === unit);
  if (!input) return null;
  let maximum = 0;
  for (const values of series)
    for (const value of values)
      if (value != null && Number.isFinite(value)) maximum = Math.max(maximum, Math.abs(value));
  if (!maximum) return { unit, divisor: 1 };
  let output = rateUnits[0];
  for (let index = rateUnits.length - 1; index >= 0; index--)
    if (maximum >= rateUnits[index].factor / input.factor) {
      output = rateUnits[index];
      break;
    }
  return { unit: output.unit, divisor: output.factor / input.factor };
}

const decimalFormatters = new Map<number, Intl.NumberFormat>();
function formatRateNumber(value: number | null | undefined, significantDigits: number): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  let formatter = decimalFormatters.get(significantDigits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      maximumSignificantDigits: significantDigits,
      useGrouping: false,
    });
    decimalFormatters.set(significantDigits, formatter);
  }
  return formatter.format(value);
}

export function formatRateValue(value: number | null | undefined): string {
  return formatRateNumber(value, 3);
}

function axisLabels(
  values: readonly number[],
  format: (value: number, significantDigits: number) => string,
): string[] {
  const distinctValues = new Set(values.filter(Number.isFinite)).size;
  let labels: string[] = [];
  for (let precision = 2; precision <= 6; precision++) {
    labels = values.map((value) => format(value, precision));
    const distinctLabels = new Set(labels.filter((_, index) => Number.isFinite(values[index])));
    if (distinctLabels.size === distinctValues) break;
  }
  return labels;
}

export function formatAxisValues(values: readonly number[]): string[] {
  return axisLabels(values, formatNumber);
}

export function formatRateAxisValues(values: readonly number[]): string[] {
  return axisLabels(values, formatRateNumber);
}
