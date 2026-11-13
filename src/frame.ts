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

/** Pixel width of a string in the tiny font; the device build provides the real one. */
export type MeasureText = (text: string) => number;

/** The left column ends here, before the window names. */
const LABEL_WIDTH = 25;
/** Two window rows; a lone window sits between them. */
const ROW_Y = [1, 9];
const SINGLE_ROW_Y = 5;
const NAME_X = 27;
/** Window names such as "30d" are up to three characters. */
const BAR_X = 40;
const BAR_WIDTH = 16;
const BAR_HEIGHT = 5;

/** Cuts text to fit a width, dropping characters from the end. */
function fit(text: string, width: number, measure: MeasureText): string {
  let fitted = text;
  while (fitted.length > 1 && measure(fitted) > width) fitted = fitted.slice(0, -1);
  return fitted;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function barColor(percent: number): string {
  if (percent >= 90) return RED;
  if (percent >= 70) return AMBER;
  return GREEN;
}

function windowElements(window: UsageWindow, row: number, y: number, nowSeconds: number): Element[] {
  const percent = currentPercent(window, nowSeconds);
  if (percent === null) {
    // No limit to draw against: the value takes the bar's place.
    return [
      { id: `w${row}_name`, type: "text", x: NAME_X, y, text: window.name.slice(0, 3), font: "tiny", color: GREY },
      { id: `w${row}_value`, type: "text", x: WIDTH, y, align: "top_right", text: window.value ?? "", font: "tiny", color: "#FFFFFFFF" },
    ];
  }
  const full = percent >= 100;
  const fill = Math.round((Math.min(percent, 100) / 100) * (BAR_WIDTH - 2));
  // A full window shows how long until it resets instead of "100%".
  const value =
    full && window.resetsAt !== null ? formatRemaining(window.resetsAt, nowSeconds) : `${Math.round(percent)}%`;

  const elements: Element[] = [
    { id: `w${row}_name`, type: "text", x: NAME_X, y, text: window.name.slice(0, 3), font: "tiny", color: GREY },
    {
      id: `w${row}_box`,
      type: "rectangle",
      x: BAR_X,
      y,
      width: BAR_WIDTH,
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
      text: value,
      font: "tiny",
      color: full ? RED : "#FFFFFFFF",
    },
  ];
  if (fill > 0) {
    elements.push({
      id: `w${row}_fill`,
      type: "rectangle",
      x: BAR_X + 1,
      y: y + 1,
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
export function accountFrame(account: Account, nowSeconds: number, measure: MeasureText): Element[] {
  const elements: Element[] = [
    {
      id: "provider",
      type: "text",
      x: 0,
      y: ROW_Y[0],
      text: fit(capitalize(account.provider), LABEL_WIDTH, measure),
      font: "tiny",
      color: PROVIDER_COLORS[account.provider] ?? "#FFFFFFFF",
    },
    {
      id: "account",
      type: "text",
      x: 0,
      y: ROW_Y[1],
      text: fit(account.account, LABEL_WIDTH, measure),
      font: "tiny",
      color: account.blocked ? RED : GREY,
    },
  ];
  if (account.error !== null) {
    elements.push({ id: "w0_name", type: "text", x: NAME_X, y: SINGLE_ROW_Y, text: account.error, font: "tiny", color: RED });
    return elements;
  }
  const windows = account.windows.slice(0, ROW_Y.length);
  windows.forEach((window, row) => {
    const y = windows.length === 1 ? SINGLE_ROW_Y : ROW_Y[row];
    elements.push(...windowElements(window, row, y, nowSeconds));
  });
  if (windows.length === 0) {
    elements.push({ id: "w0_name", type: "text", x: NAME_X, y: SINGLE_ROW_Y, text: "no data", font: "tiny", color: GREY });
  }
  return elements;
}

/** A one-line message, such as when the hub cannot be reached. */
export function messageFrame(text: string): Element[] {
  return [{ id: "message", type: "text", x: WIDTH / 2, y: 8, align: "center", text, font: "small", color: GREY }];
}
