/*
 * Переходник между серверной разметкой панели и исходными графиками Bklit UI.
 *
 * Сервер рисует «остров»: <div class="bk-island" data-bk="вид" data-bk-props='{…}'>
 * с обычной разметкой внутри (.bk-fallback) — она нужна там, где скрипт не
 * загрузился, и её же проверяют тесты. Этот файл находит острова, поднимает в
 * каждом React-корень с настоящим компонентом Bklit и прячет запасную разметку.
 *
 * Живое обновление панели (`admin-live.js`) внутрь острова не заходит: оно
 * переносит только атрибут `data-bk-props`, а перерисовку делает React — так
 * графики не пересобираются с нуля каждые пару секунд, а плавно переезжают к
 * новым числам, как и задумано у Bklit.
 */
import NumberFlow from "@number-flow/react";
import { curveMonotoneX } from "@visx/curve";
import { type ReactNode, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Area } from "./src/charts/area";
import { AreaChart } from "./src/charts/area-chart";
import {
  chartCenterContainerClassName,
  chartCenterLabelClassName,
  chartCenterValueClassName,
} from "./src/charts/chart-center-typography";
import { useChart } from "./src/charts/chart-context";
import { FunnelChart } from "./src/charts/funnel-chart";
import { Grid } from "./src/charts/grid";
import { Legend } from "./src/charts/legend/legend";
import { LegendItem as LegendItemComponent } from "./src/charts/legend/legend-item";
import { LegendLabel } from "./src/charts/legend/legend-label";
import { LegendMarker } from "./src/charts/legend/legend-marker";
import { LegendProgress } from "./src/charts/legend/legend-progress";
import { LegendValue } from "./src/charts/legend/legend-value";
import { Ring } from "./src/charts/ring";
import { RingChart } from "./src/charts/ring-chart";
import { useRingHover } from "./src/charts/ring-context";
import { ChartTooltip } from "./src/charts/tooltip/chart-tooltip";
import { XAxis } from "./src/charts/x-axis";
import { YAxis } from "./src/charts/y-axis";
import { cn } from "./src/lib/utils";
import { intFmt, labels } from "./store-formatters";

/* ------------------------------------------------------------------ данные */

// Точка ряда так, как её прислал сервер: московская дата, час (у отчёта за
// сегодня), значение и две подписи — короткая для оси и полная для подсказки.
type Point = { d: string; h?: number; v?: number; s: string; l: string };

// Дата собирается В ЧАСАХ БРАУЗЕРА из московских чисел: подпись у неё всё равно
// своя (`labels`), а ось должна просто стоять по порядку.
function dateOf(p: Point): Date {
  const [y, m, d] = p.d.split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1, p.h || 0);
  labels.set(+date, { short: p.s, long: p.l });
  return date;
}

function plural(value: number, forms: [string, string, string]): string {
  const a = Math.abs(value) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

// Длительность для NumberFlow: число и единица отдельно, иначе цифры не
// «прокручиваются». Та же мерка, что у серверной `durationShort()`.
function durationParts(seconds: number): { value: number; suffix: string } {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return { value: s, suffix: " сек" };
  return { value: Math.round(s / 60), suffix: " мин" };
}

const RU = "ru-RU";
const INT = { maximumFractionDigits: 0 } as const;

/* ------------------------------------------------------ график посещаемости */

type TrafficProps = {
  points: Point[];
  future?: Point[];
  partial?: boolean;
  series: string;
  ticks?: number;
  k?: string;
};

function Traffic({ points, future = [], partial, series, ticks = 6 }: TrafficProps) {
  const data = useMemo(() => points.map((p) => ({ date: dateOf(p), value: Number(p.v) || 0 })), [points]);
  const ahead = useMemo(() => future.map(dateOf), [future]);
  const xDomain = ahead.length && data.length ? ([data[0].date, ahead[ahead.length - 1]] as [Date, Date]) : undefined;
  // Незаконченный интервал — пунктиром, как у Bklit «dashed tail»: сплошная
  // линия доходит до последнего завершённого и дальше идёт пунктир.
  const dashFrom = partial && data.length > 1 ? data.length - 2 : undefined;
  return (
    <AreaChart
      aspectRatio="auto"
      className="bk-traffic"
      data={data}
      margin={{ top: 18, right: 14, bottom: 34, left: 44 }}
      xDomain={xDomain}
      xDomainSlotCount={xDomain ? data.length + ahead.length : undefined}
    >
      <Grid horizontal numTicksRows={5} />
      <Area
        curve={curveMonotoneX}
        dashFromIndex={dashFrom}
        dataKey="value"
        fadeEdges
        fill="var(--chart-line-primary)"
        fillOpacity={0.32}
        strokeWidth={2}
      />
      <YAxis formatValue={(v) => intFmt(v)} numTicks={5} />
      {/* С будущими часами — ровные деления по всему дню, иначе — по точкам ряда. */}
      <XAxis numTicks={ticks} tickMode={xDomain ? "domain" : "data"} />
      <ChartTooltip
        rows={(point) => [{ color: "var(--chart-line-primary)", label: series, value: Number(point.value) || 0 }]}
      />
    </AreaChart>
  );
}

/* --------------------------------------------------------- плитка сводки */

type StatProps = {
  title: string;
  value: number;
  format?: "int" | "duration";
  trend?: number | null;
  trendTitle?: string;
  note?: string;
  live?: boolean;
  spark?: Point[];
};

// Трендовая плашка — как `TrendBadge` у блока stat-card Bklit: зелёная
// обводка на росте, красная заливка на падении.
function TrendBadge({ value, title }: { value: number; title?: string }) {
  const positive = value >= 0;
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 font-medium text-xs tabular-nums",
        positive
          ? "border-emerald-600/25 bg-emerald-500/10 text-emerald-700"
          : "border-transparent bg-destructive text-white"
      )}
      title={title}
    >
      <svg aria-hidden="true" className="size-3" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 12 12">
        {positive ? <path d="M6 10V2M2.5 5.5 6 2l3.5 3.5" /> : <path d="M6 2v8M2.5 6.5 6 10l3.5-3.5" />}
      </svg>
      {positive ? "+" : "−"}
      {Math.abs(value).toLocaleString(RU, { maximumFractionDigits: 1 })}%
    </span>
  );
}

// Мост от подсказки графика к плитке: наведённый день подменяет число и
// подпись — тот же приём, что `StatCardHoverBridge` в блоке Bklit.
function HoverBridge({ onHover }: { onHover: (index: number | null) => void }) {
  const { tooltipData } = useChart();
  const index = tooltipData ? tooltipData.index : null;
  useEffect(() => { onHover(index); }, [index, onHover]);
  return null;
}

function Stat({ title, value, format = "int", trend, trendTitle, note, live, spark }: StatProps) {
  const [hover, setHover] = useState<number | null>(null);
  const onHover = useCallback((i: number | null) => setHover(i), []);
  const series = useMemo(() => (spark || []).map((p) => ({ date: dateOf(p), value: Number(p.v) || 0, label: p.l })), [spark]);
  const point = hover != null ? series[hover] : undefined;
  const shown = point ? point.value : value;
  // Под числом — пояснение сервера, а при наведении на искорку — день точки.
  const caption = point ? point.label : note || "";
  const parts = format === "duration" ? durationParts(shown) : { value: shown, suffix: "" };
  return (
    <div className={cn("bk-stat flex h-full min-w-0 flex-col", live && "bk-stat-live")}>
      <div className="flex min-w-0 items-start justify-between gap-2">
        <span className="bk-stat-title min-w-0 font-medium text-muted-foreground text-xs leading-tight">
          {live ? <i aria-hidden="true" className="bk-stat-dot" /> : null}
          <span className="min-w-0">{title}</span>
        </span>
        {trend != null && Number.isFinite(trend) && trend !== 0 ? <TrendBadge title={trendTitle} value={trend} /> : null}
      </div>
      <span className="bk-stat-value mt-2.5 font-semibold text-foreground leading-none tracking-tight tabular-nums">
        <NumberFlow format={INT} locales={RU} suffix={parts.suffix} value={parts.value} willChange />
      </span>
      <span className="bk-stat-caption mt-1.5 text-muted-foreground text-xs leading-snug">{caption}</span>
      {series.length > 1 ? (
        <div className="bk-spark relative mt-auto overflow-hidden">
          <AreaChart aspectRatio="auto" data={series} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
            <HoverBridge onHover={onHover} />
            <Area
              curve={curveMonotoneX}
              dataKey="value"
              fill="var(--chart-line-primary)"
              fillOpacity={0.3}
              gradientToOpacity={0}
              showHighlight
              strokeWidth={1.75}
            />
          </AreaChart>
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- воронка */

type FunnelProps = { stages: { label: string; value: number; note?: string }[] };

// Ширина самого блока, а не окна: воронка стоит и во всю строку, и в половине
// сетки, и решает, как лечь, по месту, которое ей правда досталось.
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Funnel({ stages }: FunnelProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);
  // Лёжа подписи стоят под ступенями и делят ширину поровну: меньше ~130 px на
  // ступень — и «Дошли до оформления» наезжает на соседку. Тогда воронка встаёт.
  const wide = width >= stages.length * 130;
  const data = useMemo(() => stages.map((s) => ({ label: s.label, value: s.value })), [stages]);
  // Процент у Bklit — от первой ступени. Доля от ПРЕДЫДУЩЕЙ и потеря на шаге —
  // строкой под воронкой: так её и читают («где обрыв»), см. funnelPanel().
  return (
    <div className={cn("bk-funnel-wrap flex h-full flex-col gap-3", wide ? "is-wide" : "is-tall")} ref={ref}>
      <div className="bk-funnel-plot min-h-0 flex-1">
        {width ? (
          <FunnelChart
            className="size-full"
            // Стоя подписи ложатся поверх ступеней — заливка светлее, чтобы
            // тёмный текст на ней читался.
            color={wide ? "var(--chart-line-primary)" : "var(--chart-3)"}
            data={data}
            formatValue={(v) => intFmt(v)}
            hoveredIndex={hovered}
            labelLayout={wide ? "spread" : "grouped"}
            onHoverChange={setHovered}
            orientation={wide ? "horizontal" : "vertical"}
          />
        ) : null}
      </div>
      <ol className="bk-funnel-notes grid gap-1 text-xs leading-snug">
        {stages.map((s, i) =>
          s.note ? (
            <li
              className={cn("min-w-0 transition-opacity duration-150", hovered != null && hovered !== i && "opacity-45")}
              key={s.label}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
            >
              <b className="font-medium text-foreground">{s.label}</b>
              <span className="text-muted-foreground"> — {s.note}</span>
            </li>
          ) : null
        )}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------ скорость: кольца */

type SpeedRow = { label: string; good: number; total: number; avg: string };

function SpeedCenter({ rows, measured }: { rows: SpeedRow[]; measured: number }) {
  const { hoveredIndex } = useRingHover();
  const row = hoveredIndex == null ? null : rows[hoveredIndex];
  const value = row ? Math.round((row.good / Math.max(1, row.total)) * 100) : measured;
  const caption = row ? "хорошо · " + row.avg : plural(measured, ["замер", "замера", "замеров"]);
  return (
    <div className={cn(chartCenterContainerClassName, "flex flex-col items-center justify-center text-center")}>
      <span className={cn("text-foreground", chartCenterValueClassName)}>
        <NumberFlow format={INT} locales={RU} suffix={row ? "%" : ""} value={value} />
      </span>
      <span className={cn("mt-0.5 text-chart-label", chartCenterLabelClassName)}>{caption}</span>
    </div>
  );
}

// RingChart выносит из SVG в HTML-слой только ребёнка по имени «RingCenter»
// (обход WebKit #23113) — своё содержимое центра обязано так и называться.
SpeedCenter.displayName = "RingCenter";

function Speed({ rows, measured }: { rows: SpeedRow[]; measured: number }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const colors = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)"];
  const data = rows.map((r, i) => ({ label: r.label, value: r.good, maxValue: Math.max(1, r.total), color: colors[i % colors.length] }));
  return (
    <div className="bk-speed flex flex-col items-center gap-6 sm:flex-row sm:items-center sm:gap-10">
      <RingChart baseInnerRadius={52} data={data} hoveredIndex={hovered} onHoverChange={setHovered} ringGap={6} size={220} strokeWidth={11}>
        {data.map((item, index) => <Ring index={index} key={item.label} />)}
        <SpeedCenter measured={measured} rows={rows} />
      </RingChart>
      <Legend
        className="w-full min-w-0 flex-1"
        hoveredIndex={hovered}
        items={data.map((d, i) => ({ label: d.label + " · " + rows[i].avg, value: d.value, maxValue: d.maxValue, color: d.color }))}
        onHoverChange={setHovered}
        title="Хорошо у покупателей"
      >
        <LegendItemComponent className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1">
          <LegendMarker />
          <LegendLabel />
          <LegendValue formatValue={(v) => intFmt(v)} showPercentage />
          <div className="col-span-full">
            <LegendProgress />
          </div>
        </LegendItemComponent>
      </Legend>
    </div>
  );
}

/* ------------------------------------------------------------------ острова */

const VIEWS: Record<string, (props: never) => ReactNode> = {
  traffic: Traffic as never,
  stat: Stat as never,
  funnel: Funnel as never,
  speed: Speed as never,
};

type Island = { root: Root; mount: HTMLElement; json: string; kind: string };
const islands = new WeakMap<HTMLElement, Island>();

function render(el: HTMLElement) {
  const kind = el.getAttribute("data-bk") || "";
  const View = VIEWS[kind];
  if (!View) return;
  const json = el.getAttribute("data-bk-props") || "{}";
  let island = islands.get(el);
  // Корень пересоздаётся, если сменился вид острова: другой компонент на том же
  // месте — это другой график, а не новые числа старого.
  if (island && island.kind !== kind) {
    island.root.unmount();
    island.mount.remove();
    islands.delete(el);
    island = undefined;
  }
  if (island && island.json === json) return;
  let props: Record<string, unknown>;
  try {
    props = JSON.parse(json);
  } catch {
    return;
  }
  if (!island) {
    const mount = document.createElement("div");
    mount.className = "bk-root bk-mount";
    el.append(mount);
    island = { root: createRoot(mount), mount, json, kind };
    islands.set(el, island);
    el.setAttribute("data-bk-mounted", "");
  }
  island.json = json;
  // `k` — ключ ряда (период, страна): смена ряда переигрывает появление графика
  // с начала, а новые числа того же ряда плавно переезжают.
  island.root.render(<View key={String(props.k ?? "")} {...(props as never)} />);
}

function scan() {
  const list = document.querySelectorAll<HTMLElement>(".bk-island[data-bk]");
  for (const el of list) render(el);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", scan, { once: true });
else scan();
document.addEventListener("admin-live:updated", scan);

declare global {
  interface Window {
    StoreCharts?: { scan: () => void };
  }
}
window.StoreCharts = { scan };
