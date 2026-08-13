import type { ITheme } from '@xterm/xterm';

const style = getComputedStyle(document.documentElement);
const cssVar = (token: string) => style.getPropertyValue(token) || undefined;

export function getTerminalTheme(overrides?: ITheme): ITheme {
  return {
    cursor: cssVar('--aisso-elements-terminal-cursorColor'),
    cursorAccent: cssVar('--aisso-elements-terminal-cursorColorAccent'),
    foreground: cssVar('--aisso-elements-terminal-textColor'),
    background: cssVar('--aisso-elements-terminal-backgroundColor'),
    selectionBackground: cssVar('--aisso-elements-terminal-selection-backgroundColor'),
    selectionForeground: cssVar('--aisso-elements-terminal-selection-textColor'),
    selectionInactiveBackground: cssVar('--aisso-elements-terminal-selection-backgroundColorInactive'),

    // ansi escape code colors
    black: cssVar('--aisso-elements-terminal-color-black'),
    red: cssVar('--aisso-elements-terminal-color-red'),
    green: cssVar('--aisso-elements-terminal-color-green'),
    yellow: cssVar('--aisso-elements-terminal-color-yellow'),
    blue: cssVar('--aisso-elements-terminal-color-blue'),
    magenta: cssVar('--aisso-elements-terminal-color-magenta'),
    cyan: cssVar('--aisso-elements-terminal-color-cyan'),
    white: cssVar('--aisso-elements-terminal-color-white'),
    brightBlack: cssVar('--aisso-elements-terminal-color-brightBlack'),
    brightRed: cssVar('--aisso-elements-terminal-color-brightRed'),
    brightGreen: cssVar('--aisso-elements-terminal-color-brightGreen'),
    brightYellow: cssVar('--aisso-elements-terminal-color-brightYellow'),
    brightBlue: cssVar('--aisso-elements-terminal-color-brightBlue'),
    brightMagenta: cssVar('--aisso-elements-terminal-color-brightMagenta'),
    brightCyan: cssVar('--aisso-elements-terminal-color-brightCyan'),
    brightWhite: cssVar('--aisso-elements-terminal-color-brightWhite'),

    ...overrides,
  };
}
