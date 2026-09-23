import { STATUS_PALETTE, type SlotDisplayStatus } from '@laqum/shared';
import { useColorScheme } from 'react-native';

/**
 * The app's colours come from the SHARED palette, not from a second set.
 *
 * `STATUS_PALETTE` is the same table the dashboard's CSS mirrors, and a test
 * in @laqum/shared asserts the two agree. A slot shown as "occupied" on the
 * attendant's tablet and on the driver's phone is therefore the same blue —
 * which matters when the two are standing next to each other at the gate
 * disagreeing about a slot.
 */

export type Scheme = 'light' | 'dark';

export interface Theme {
  scheme: Scheme;
  bg: string;
  card: string;
  text: string;
  muted: string;
  line: string;
  accent: string;
  accentInk: string;
  danger: string;
  ok: string;
  slot: (status: SlotDisplayStatus) => { surface: string; ink: string };
}

const PALETTES = {
  light: {
    bg: '#fdfdfe',
    card: '#ffffff',
    text: '#1e293b',
    muted: '#64748b',
    line: '#cbd5e1',
    accent: '#1d4ed8',
    accentInk: '#ffffff',
    danger: '#b91c1c',
    ok: '#15803d',
  },
  dark: {
    bg: '#0f172a',
    card: '#1e293b',
    text: '#f8fafc',
    muted: '#94a3b8',
    line: '#475569',
    accent: '#60a5fa',
    accentInk: '#0f172a',
    danger: '#f87171',
    ok: '#4ade80',
  },
} as const;

export function useTheme(): Theme {
  // Follows the phone. A driver who runs their phone dark at night is
  // holding it up at a dark lot entrance; forcing light would dazzle them.
  const scheme: Scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return {
    scheme,
    ...PALETTES[scheme],
    slot: (status) => STATUS_PALETTE[status][scheme],
  };
}
