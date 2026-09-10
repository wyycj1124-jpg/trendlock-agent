function decimals(value: number) {
  const text = value.toString().toLowerCase();
  if (text.includes('e-')) return Number(text.split('e-')[1]);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function quantize(value: number, step: number, direction: 'FLOOR' | 'CEIL') {
  if (![value, step].every((item) => Number.isFinite(item) && item > 0)) {
    throw new Error('量化参数无效');
  }
  const precision = Math.min(15, Math.max(decimals(step), 0));
  const epsilon = 1e-12;
  const units =
    direction === 'FLOOR'
      ? Math.floor(value / step + epsilon)
      : Math.ceil(value / step - epsilon);
  return Number((units * step).toFixed(precision));
}

export const floorToStep = (value: number, step: number) =>
  quantize(value, step, 'FLOOR');

export const ceilToStep = (value: number, step: number) =>
  quantize(value, step, 'CEIL');

export function quantizeStop(
  value: number,
  tickSize: number,
  side: 'LONG' | 'SHORT',
) {
  // Round away from the current market so quantization never tightens the requested stop.
  return quantize(value, tickSize, side === 'LONG' ? 'FLOOR' : 'CEIL');
}

export function formatDecimal(value: number) {
  if (!Number.isFinite(value)) throw new Error('数值格式无效');
  return value.toFixed(15).replace(/\.?0+$/, '');
}
