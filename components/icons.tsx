/**
 * Interface icons, from Lucide.
 *
 * The design system's vocabulary is Lucide at a 24px grid, so these are thin
 * wrappers that keep the names the screens already import. The stroke width
 * follows the brandbook: 1.75 at the base sizes, 1.5 on miniatures below 20px,
 * and 2 above 32px.
 *
 * They inherit `currentColor` and are `aria-hidden` by default: every icon in
 * this app sits next to a text label or inside a button with an accessible
 * name, so the icon itself is decorative.
 */

import {
  ArrowLeft,
  ArrowRight,
  Eye,
  History,
  Image as ImageGlyph,
  LayoutGrid,
  List,
  LogOut,
  Plus,
  Snowflake,
  StickyNote,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export interface IconProps {
  /** Square size in px. The design uses 17–20. */
  size?: number;
  className?: string;
}

function strokeWidthFor(size: number): number {
  if (size >= 32) return 2;
  if (size < 20) return 1.5;
  return 1.75;
}

function fromLucide(Glyph: LucideIcon) {
  return function Icon({ size = 19, className }: IconProps) {
    return (
      <Glyph
        className={className ? `icon ${className}` : "icon"}
        size={size}
        strokeWidth={strokeWidthFor(size)}
        aria-hidden="true"
        focusable="false"
      />
    );
  };
}

export const ArrowForwardIcon = fromLucide(ArrowRight);
export const ArrowBackIcon = fromLucide(ArrowLeft);
export const LogoutIcon = fromLucide(LogOut);
export const AddIcon = fromLucide(Plus);
export const GridViewIcon = fromLucide(LayoutGrid);
export const ViewListIcon = fromLucide(List);
export const GroupIcon = fromLucide(Users);
export const GroupsIcon = fromLucide(UsersRound);
export const AcUnitIcon = fromLucide(Snowflake);
export const VisibilityIcon = fromLucide(Eye);
export const HistoryIcon = fromLucide(History);
export const StickyNoteIcon = fromLucide(StickyNote);
export const ImageIcon = fromLucide(ImageGlyph);
