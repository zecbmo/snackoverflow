/** Simple line icons (24px grid, currentColor). Decorative unless given a label. */
const paths = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  box: 'M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9zM3.8 7.6 12 12.2l8.2-4.6M12 12.2v8.9',
  calendar: 'M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM4 10h16M8 3v4M16 3v4',
  cart: 'M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.9a1 1 0 0 0 1-.8L20 8H6.2M9.5 20.5a1 1 0 1 0 0-.01M17 20.5a1 1 0 1 0 0-.01',
  scan: 'M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M8 8v8M11 8v8M14 8v8M17 8v8',
  menu: 'M4 7h16M4 12h16M4 17h10',
  close: 'M6 6l12 12M18 6 6 18',
  search: 'M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15zM16 16l5 5',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  keyboard: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8',
  fridge: 'M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM5 10h14M9 6v2M9 13v3',
  snowflake: 'M12 2v20M4.2 7l15.6 10M4.2 17 19.8 7M9 4l3 2 3-2M9 20l3-2 3 2',
  cupboard: 'M4 4h16v16H4zM12 4v16M9.5 11v2M14.5 11v2',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  plus: 'M12 5v14M5 12h14',
  bottle: 'M10 2.5h4M10.5 2.5v3.2L8 9.5V20a1.5 1.5 0 0 0 1.5 1.5h5A1.5 1.5 0 0 0 16 20V9.5l-2.5-3.8V2.5M8 13h8',
  undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  warning: 'M12 3.5 21.5 20h-19zM12 10v4.5M12 17.5h.01',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  logout: 'M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2.5h6L16.5 7h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM12 16a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  torch: 'M8 3h8l-1 6H9zM9 9l1 12h4l1-12',
  copy: 'M8 8h11v12H8zM5 16V4h11',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  recipe: 'M6 3.5h11.5A1.5 1.5 0 0 1 19 5v15.5H6.5A2.5 2.5 0 0 1 4 18V5.5a2 2 0 0 1 2-2zM4 18a2.5 2.5 0 0 1 2.5-2.5H19M9 8h6M9 11h4',
  pot: 'M3 10h18M5 10v7.5A2.5 2.5 0 0 0 7.5 20h9a2.5 2.5 0 0 0 2.5-2.5V10M8 6.5c0-1 1-1.5 1-2.5M12 6.5c0-1 1-1.5 1-2.5M16 6.5c0-1 1-1.5 1-2.5',
  receipt: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 12h6M9 16h3',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1.4 1.4 0 0 1 0 2l-7 7a1.4 1.4 0 0 1-2 0zM8 8h.01',
  leaf: 'M5 19c0-8 5-14 15-15-1 10-7 15-15 15zM5 19l7-7',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-3',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14.5a6.5 6.5 0 0 1 3 5.5',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  sidebar: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM9.5 4v16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
  sort: 'M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3',
  group: 'M4 6h16M4 12h10M4 18h7',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  rows: 'M4 6h16M4 12h16M4 18h16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  move: 'M5 12h14M15 8l4 4-4 4M9 8 5 12l4 4',
  spoon: 'M7 3c2 0 3.5 2 3.5 4.5S9 11.5 7 11.5 3.5 10 3.5 7.5 5 3 7 3zM7 11.5V21M16 3v18M13 3v5a3 3 0 0 0 6 0V3',
  opened: 'M5 10h14v9.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5zM5 10l1.5-5.5L19 8M9 14h6',
  drop: 'M12 3.5s6 6.4 6 10.6a6 6 0 0 1-12 0c0-4.2 6-10.6 6-10.6zM9.5 15a2.5 2.5 0 0 0 2.5 2.5',
  columns: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5zM9.5 4v16M14.5 4v16',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7.4 7.4 0 0 1-2 1.2L14.8 21h-4l-.3-2.4a7.4 7.4 0 0 1-2-1.2l-1.9.7-2-3.4 1.6-1.2a7.6 7.6 0 0 1 0-2.4L4.6 9.9l2-3.4 1.9.7a7.4 7.4 0 0 1 2-1.2l.3-2.4h4l.3 2.4a7.4 7.4 0 0 1 2 1.2l1.9-.7 2 3.4-1.6 1.2a7.6 7.6 0 0 1 0 2.4z',
  burger: 'M4 11a8 6 0 0 1 16 0zM3.5 14.5h17M5 17.5h14v.5a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, className = 'size-6', label, strokeWidth = 1.8 }: { name: IconName; className?: string; label?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function locationIcon(type: string): IconName {
  return type === 'freezer' ? 'snowflake' : type === 'fridge' ? 'fridge' : 'cupboard';
}
