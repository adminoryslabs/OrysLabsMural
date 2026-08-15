/**
 * Inline SVG icons.
 *
 * The design calls for Material Symbols Outlined at weight 300. Self-hosting an
 * icon font for a dozen glyphs would ship a font file and a second loading
 * state for no benefit, so these are inline paths keeping the same glyph
 * meanings: `arrow_forward`, `arrow_back`, `logout`, `add`, `grid_view`,
 * `view_list`, `group`, `groups`, `ac_unit`, `visibility`, `history`.
 *
 * They inherit `currentColor` and are `aria-hidden` by default: every icon in
 * this app sits next to a text label or inside a button with an accessible
 * name, so the icon itself is decorative.
 */

export interface IconProps {
  /** Square size in px. The design uses 17–20. */
  size?: number;
  className?: string;
}

function Svg({
  size = 19,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function ArrowForwardIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 12h15" />
      <path d="M13 6l6 6-6 6" />
    </Svg>
  );
}

export function ArrowBackIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12H5" />
      <path d="M11 18l-6-6 6-6" />
    </Svg>
  );
}

export function LogoutIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8" />
      <path d="M11 12h10" />
      <path d="M17 8l4 4-4 4" />
    </Svg>
  );
}

export function AddIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

export function GridViewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" />
      <rect x="13" y="4" width="7" height="7" />
      <rect x="4" y="13" width="7" height="7" />
      <rect x="13" y="13" width="7" height="7" />
    </Svg>
  );
}

export function ViewListIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h2" />
      <path d="M9 6h11" />
      <path d="M4 12h2" />
      <path d="M9 12h11" />
      <path d="M4 18h2" />
      <path d="M9 18h11" />
    </Svg>
  );
}

export function GroupIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9.5" cy="8.5" r="3" />
      <path d="M3.5 19c0-2.8 2.7-4.5 6-4.5s6 1.7 6 4.5" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6" />
      <path d="M17.5 14.9c1.9.6 3 1.9 3 4.1" />
    </Svg>
  );
}

export function GroupsIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.5" r="2.8" />
      <path d="M6.8 19c0-2.7 2.4-4.3 5.2-4.3s5.2 1.6 5.2 4.3" />
      <path d="M6.2 11.2a2.4 2.4 0 1 1 0-4.4" />
      <path d="M4.6 14.6C3.2 15.2 2.5 16.5 2.5 18.4" />
      <path d="M17.8 6.8a2.4 2.4 0 1 1 0 4.4" />
      <path d="M19.4 14.6c1.4.6 2.1 1.9 2.1 3.8" />
    </Svg>
  );
}

export function AcUnitIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3v18" />
      <path d="M4.2 7.5l15.6 9" />
      <path d="M19.8 7.5l-15.6 9" />
      <path d="M9.6 5.2L12 6.6l2.4-1.4" />
      <path d="M9.6 18.8L12 17.4l2.4 1.4" />
    </Svg>
  );
}

export function VisibilityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </Svg>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" />
      <path d="M3.2 4.4v4.2h4.2" />
      <path d="M12 7.6V12l3.2 2" />
    </Svg>
  );
}
