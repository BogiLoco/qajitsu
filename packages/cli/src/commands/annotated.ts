/** Annotated screenshots first, then the rest in their order (REQ-EVD-08/AC5). */
export function annotatedFirst<T>(items: readonly T[], path: (item: T) => string): T[] {
  const rank = (p: string): number =>
    p.endsWith("-annotated.png") ? 0 : p.endsWith("-annotated-baseline.png") ? 1 : 2;
  return items
    .map((item, i) => ({ item, i, r: rank(path(item)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.item);
}
