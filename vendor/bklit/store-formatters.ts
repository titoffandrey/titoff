/*
 * Замена `src/charts/chart-formatters.ts` при сборке — сам исходник Bklit не правится.
 *
 * В оригинале даты и числа зашиты в en-US («Sep 13», «1,234»). Панель русская,
 * а подписи точек ей уже прислал сервер: «24 сент.», «14», «8–14 сентября».
 * Поэтому у каждой даты, которую собирает `store-charts.tsx`, есть своя подпись
 * в `labels`; формат по умолчанию — только запасной путь для дат, которых сервер
 * не называл (например, крайние деления оси, дорисованные самой библиотекой).
 */
export type PointLabel = { short: string; long: string };

export const labels = new Map<number, PointLabel>();

const shortRu = new Intl.DateTimeFormat("ru-RU", { month: "short", day: "numeric" });
const weekdayRu = new Intl.DateTimeFormat("ru-RU", { weekday: "short", month: "short", day: "numeric" });

export const shortDateFmt = {
  format: (date: Date) => labels.get(+date)?.short ?? shortRu.format(date),
};

export const weekdayDateFmt = {
  format: (date: Date) => labels.get(+date)?.long ?? weekdayRu.format(date),
};

export const hmsTimeFmt = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export const intFmt = new Intl.NumberFormat("ru-RU").format;
