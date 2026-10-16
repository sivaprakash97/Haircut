import type { ToolChoice } from '../app/input';

export interface ToolInfo {
  id: ToolChoice;
  label: string;
  help: string;
  /** Accent colour (matches the brush cursor). */
  color: string;
  /** Which brush controls apply. */
  size: boolean;
  strength: boolean;
  guard: boolean;
  icon: preact.JSX.Element;
}

// Simple 24×24 stroke icons (drawn with currentColor).
export const TOOLS: ToolInfo[] = [
  {
    id: 'view', label: 'Rotate', color: '#c9c3e6', size: false, strength: false, guard: false,
    help: 'Drag to spin the chair; flick it and watch the hair swing',
    icon: (
      <>
        <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9" />
        <path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" />
      </>
    ),
  },
  {
    id: 'scissors', label: 'Scissors', color: '#ff4d6d', size: false, strength: false, guard: false,
    help: 'Swipe across locks to snip them; the ends fall away',
    icon: (
      <>
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M8.5 7.5 20 18M8.5 16.5 20 6" />
      </>
    ),
  },
  {
    id: 'clippers', label: 'Clippers', color: '#b98cff', size: true, strength: false, guard: true,
    help: 'Rub over the head to buzz the hair down to the guard length',
    icon: (
      <>
        <path d="M7 10h10v9a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z" />
        <path d="M6 7h12v3H6zM8 7V4M11 7V4M14 7V4M17 7V4" />
      </>
    ),
  },
  {
    id: 'comb', label: 'Comb', color: '#7cc6ff', size: true, strength: true, guard: false,
    help: 'Drag through the hair to comb it the way you drag',
    icon: <path d="M3 8h18v3H3zM5 11v8M8 11v8M11 11v8M14 11v8M17 11v8M20 11v8" />,
  },
  {
    id: 'grow', label: 'Grow', color: '#6be38a', size: true, strength: true, guard: false,
    help: 'Hold over hair (or bare scalp) to grow it longer',
    icon: (
      <>
        <path d="M4 20h16" />
        <path d="M12 20v-9M12 11c0-4 3-6 6-6 0 3-2 6-6 6ZM12 14c0-3-2.5-5-5-5 0 2.5 2 5 5 5Z" />
      </>
    ),
  },
  {
    id: 'extrude', label: 'Extrude', color: '#ffc43d', size: true, strength: false, guard: false,
    help: 'Grab hair and pull it out; it stays put (spikes, flicks, wings)',
    icon: (
      <>
        <path d="M4 20h16" />
        <path d="M8 20 12 5l4 15" />
        <path d="m9 8 3-4 3 4" />
      </>
    ),
  },
  {
    id: 'gel', label: 'Gel', color: '#6fe7ff', size: true, strength: true, guard: false,
    help: 'Brush gel on: hair freezes in its current shape and shines',
    icon: <path d="M12 3c3.5 4.5 6 7.7 6 11a6 6 0 0 1-12 0c0-3.3 2.5-6.5 6-11ZM9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" />,
  },
  {
    id: 'dryer', label: 'Dryer', color: '#ffa36b', size: true, strength: true, guard: false,
    help: 'Hold to blow the hair around; it sets the way it was blown',
    icon: (
      <>
        <path d="M3 9a5 5 0 0 1 5-5h7v10H8a5 5 0 0 1-5-5ZM9 14l-1 7h3l1-7" />
        <path d="M18 6h3M18 9h4M18 12h3" />
      </>
    ),
  },
];
