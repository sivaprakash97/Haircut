import type { ToolChoice } from '../app/brush';

export interface ToolInfo {
  id: ToolChoice;
  label: string;
  help: string;
  /** Accent colour (matches the brush cursor). */
  color: string;
  /** Which brush controls apply. */
  size: boolean;
  strength: boolean;
  icon: preact.JSX.Element;
}

// Simple 24×24 stroke icons (drawn with currentColor).
export const TOOLS: ToolInfo[] = [
  {
    id: 'view', label: 'Rotate', color: '#c9c3e6', size: false, strength: false,
    help: 'Drag to turn the head',
    icon: (
      <>
        <path d="M20 12a8 8 0 0 1-14.3 4.9M4 12a8 8 0 0 1 14.3-4.9" />
        <path d="M18.5 3.5v4h-4M5.5 20.5v-4h4" />
      </>
    ),
  },
  {
    id: 'scissors', label: 'Scissors', color: '#ff4d6d', size: false, strength: false,
    help: 'Swipe across hair to slice it; cut-off pieces fall away',
    icon: (
      <>
        <circle cx="6" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M8.5 7.5 20 18M8.5 16.5 20 6" />
      </>
    ),
  },
  {
    id: 'comb', label: 'Comb', color: '#7cc6ff', size: true, strength: true,
    help: 'Drag along the hair to push the clay with your stroke',
    icon: <path d="M3 8h18v3H3zM5 11v8M8 11v8M11 11v8M14 11v8M17 11v8M20 11v8" />,
  },
  {
    id: 'grow', label: 'Grow', color: '#6be38a', size: true, strength: true,
    help: 'Hold or drag to build hair up, even on bare scalp',
    icon: (
      <>
        <path d="M4 20h16" />
        <path d="M12 20v-9M12 11c0-4 3-6 6-6 0 3-2 6-6 6ZM12 14c0-3-2.5-5-5-5 0 2.5 2 5 5 5Z" />
      </>
    ),
  },
  {
    id: 'extrude', label: 'Extrude', color: '#ffc43d', size: true, strength: false,
    help: 'Press on hair and pull outward to draw a spike',
    icon: (
      <>
        <path d="M4 20h16" />
        <path d="M8 20 12 5l4 15" />
        <path d="m9 8 3-4 3 4" />
      </>
    ),
  },
  {
    id: 'gel', label: 'Gel', color: '#6fe7ff', size: true, strength: true,
    help: 'Brush gel on so hair holds its shape (and shines)',
    icon: <path d="M12 3c3.5 4.5 6 7.7 6 11a6 6 0 0 1-12 0c0-3.3 2.5-6.5 6-11ZM9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" />,
  },
  {
    id: 'dryer', label: 'Dryer', color: '#ffa36b', size: true, strength: true,
    help: 'Dry hair out: it loosens, sags and goes matte like dry sand',
    icon: (
      <>
        <path d="M3 9a5 5 0 0 1 5-5h7v10H8a5 5 0 0 1-5-5ZM9 14l-1 7h3l1-7" />
        <path d="M18 6h3M18 9h4M18 12h3" />
      </>
    ),
  },
];
