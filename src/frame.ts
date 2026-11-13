import type { DisplayDrawParams } from "@busy-app/busy-lib";
import { currentPercent, formatRemaining, type Account, type UsageWindow } from "./usage.ts";

export type Element = DisplayDrawParams["elements"][number];

/** The front display is 72×16. */
const WIDTH = 72;

const GREY = "#9E9E9EFF";
const BAR_BORDER = "#616161FF";
const GREEN = "#66BB6AFF";
const AMBER = "#FFB300FF";
const RED = "#EF5350FF";
const PROVIDER_COLORS: Record<string, string> = {
  claude: "#D97757FF",
  codex: "#FFFFFFFF",
};

/** Pixel width of a string in a font; the device build provides the real one. */
export type MeasureText = (text: string, font: "tiny" | "small") => number;

/**
 * Numbers and names use the "small" font, whose digits are 5 pixels tall; "tiny" (4 pixels) makes
 * 4, 9 and d hard to tell apart. Drawn at y, small glyphs fill rows y+2 to y+6, so rows -1 and 8
 * fill 1-5 and 10-14. The account name keeps "tiny" because small descenders would not fit.
 */
const FONT = "small";
const ROW_Y = [-1, 8];
/** A lone window sits in the middle. */
const SINGLE_ROW_Y = 3;
/** Small glyphs start this many rows below their y. */
const GLYPH_TOP = 2;
/** Tiny glyphs fill rows y+1 to y+4; this leaves rows 14-15 for descenders such as g and y. */
const ACCOUNT_Y = 9;

/** Room for a window name such as "30d"; a wider name, such as "MON", moves the bar right. */
const MIN_NAME_WIDTH = 13;
/** The bar ends before this column, or sooner when a value as wide as "100%" needs the room. */
const BAR_END = 56;
const BAR_HEIGHT = 5;

/** Where each column starts, and how wide the label and the bar are. */
interface Columns {
  labelWidth: number;
  nameX: number;
  barX: number;
  barWidth: number;
}

/**
 * Capitals are wider: uppercase widens the label column to fit "CLAUDE", "COPILOT" and "CURSOR"
 * (up to 30 pixels) and narrows the bar. The bar starts after the widest window name on the page
 * and keeps a blank column before the widest value.
 */
function columns(style: TextStyle, windows: UsageWindow[], nowSeconds: number): Columns {
  const labelWidth = style.uppercase ? 30 : 25;
  const nameX = labelWidth + 2;
  const names = windows.map((window) => style.measure(windowName(window, style), FONT));
  const values = windows.flatMap((window) => {
    const percent = currentPercent(window, nowSeconds);
    return percent === null ? [] : [style.measure(barValue(window, percent, nowSeconds, style), FONT)];
  });
  const barX = nameX + Math.max(MIN_NAME_WIDTH, ...names);
  const barEnd = Math.min(BAR_END, WIDTH - 1 - Math.max(0, ...values));
  return { labelWidth, nameX, barX, barWidth: barEnd - barX };
}

/** Cuts text to fit a width, dropping characters from the end. */
function fit(text: string, width: number, measure: MeasureText, font: "tiny" | "small"): string {
  let fitted = text;
  while (fitted.length > 1 && measure(fitted, font) > width) fitted = fitted.slice(0, -1);
  return fitted;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How text is drawn, from the app's settings. */
export interface TextStyle {
  measure: MeasureText;
  /** Draw every label in capitals; digits and symbols are unchanged. */
  uppercase: boolean;
}

const cased = (text: string, style: TextStyle) => (style.uppercase ? text.toUpperCase() : text);

function barColor(percent: number): string {
  if (percent >= 90) return RED;
  if (percent >= 70) return AMBER;
  return GREEN;
}

/** Window names are cut to three characters. */
const windowName = (window: UsageWindow, style: TextStyle) => cased(window.name.slice(0, 3), style);

/** The value after a window's bar: the percentage, or for a full window the time until it resets. */
function barValue(window: UsageWindow, percent: number, nowSeconds: number, style: TextStyle): string {
  const full = percent >= 100 && window.resetsAt !== null;
  return cased(full ? formatRemaining(window.resetsAt ?? 0, nowSeconds) : `${Math.round(percent)}%`, style);
}

function windowElements(
  window: UsageWindow,
  row: number,
  y: number,
  nowSeconds: number,
  style: TextStyle,
  { nameX, barX, barWidth }: Columns,
): Element[] {
  const name = windowName(window, style);
  const percent = currentPercent(window, nowSeconds);
  if (percent === null) {
    // No limit to draw against: the value takes the bar's place, and the name gives way to it.
    const value = fit(cased(window.value ?? "", style), WIDTH - nameX, style.measure, FONT);
    const room = WIDTH - style.measure(value, FONT) - nameX;
    const shortName = fit(name, room, style.measure, FONT);
    const elements: Element[] = [
      {
        id: `w${row}_value`,
        type: "text",
        x: WIDTH,
        y,
        align: "top_right",
        text: value,
        font: FONT,
        color: "#FFFFFFFF",
      },
    ];
    if (style.measure(shortName, FONT) <= room) {
      elements.unshift({ id: `w${row}_name`, type: "text", x: nameX, y, text: shortName, font: FONT, color: GREY });
    }
    return elements;
  }
  const full = percent >= 100;
  const fill = Math.round((Math.min(percent, 100) / 100) * (barWidth - 2));

  const elements: Element[] = [
    { id: `w${row}_name`, type: "text", x: nameX, y, text: name, font: FONT, color: GREY },
    {
      id: `w${row}_box`,
      type: "rectangle",
      x: barX,
      y: y + GLYPH_TOP,
      width: barWidth,
      height: BAR_HEIGHT,
      border_width: 1,
      border_color: BAR_BORDER,
      fill: "none",
    },
    {
      id: `w${row}_value`,
      type: "text",
      x: WIDTH,
      y,
      align: "top_right",
      text: barValue(window, percent, nowSeconds, style),
      font: FONT,
      color: full ? RED : "#FFFFFFFF",
    },
  ];
  if (fill > 0) {
    elements.push({
      id: `w${row}_fill`,
      type: "rectangle",
      x: barX + 1,
      y: y + GLYPH_TOP + 1,
      width: fill,
      height: BAR_HEIGHT - 2,
      border_width: 0,
      fill: "solid",
      fill_colors: [barColor(percent)],
    });
  }
  return elements;
}

/** The elements for one account's page. */
export function accountFrame(account: Account, nowSeconds: number, style: TextStyle): Element[] {
  const windows = account.error === null ? account.windows.slice(0, ROW_Y.length) : [];
  const layout = columns(style, windows, nowSeconds);
  const label = (text: string, font: "tiny" | "small") =>
    fit(cased(text, style), layout.labelWidth, style.measure, font);
  // A message in the window area; its last blank column may fall past the screen's edge.
  const notice = (text: string, color: string): Element => ({
    id: "w0_name",
    type: "text",
    x: layout.nameX,
    y: SINGLE_ROW_Y,
    text: fit(cased(text, style), WIDTH + 1 - layout.nameX, style.measure, FONT),
    font: FONT,
    color,
  });
  const elements: Element[] = [
    {
      id: "provider",
      type: "text",
      x: 0,
      y: ROW_Y[0],
      text: label(account.providerName ?? capitalize(account.provider), FONT),
      font: FONT,
      color: PROVIDER_COLORS[account.provider] ?? "#FFFFFFFF",
    },
    {
      id: "account",
      type: "text",
      x: 0,
      y: ACCOUNT_Y,
      text: label(account.account, "tiny"),
      font: "tiny",
      color: account.blocked ? RED : GREY,
    },
  ];
  if (account.error !== null) {
    elements.push(notice(account.error, RED));
    return elements;
  }
  windows.forEach((window, row) => {
    const y = windows.length === 1 ? SINGLE_ROW_Y : ROW_Y[row];
    elements.push(...windowElements(window, row, y, nowSeconds, style, layout));
  });
  if (windows.length === 0) elements.push(notice("no data", GREY));
  return elements;
}

/** A one-line message, such as when the hub cannot be reached. */
export function messageFrame(text: string, style: TextStyle): Element[] {
  return [
    {
      id: "message",
      type: "text",
      x: WIDTH / 2,
      y: 8,
      align: "center",
      text: cased(text, style),
      font: "small",
      color: GREY,
    },
  ];
}
