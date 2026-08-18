import { describe, expect, it } from "vitest";
import {
  ICON_SIZE,
  findIcon,
  iconDownloadUrl,
  iconOrigin,
  type IconCatalogEntry,
} from "@/lib/collab/icon-tool";

const CATALOG: readonly IconCatalogEntry[] = [
  { name: "shield", label: "Shield", fileId: "icon-shield" },
  { name: "bulb", label: "Bulb", fileId: "icon-bulb" },
];

describe("iconDownloadUrl", () => {
  it("points at the icon catalog's HTTP route", () => {
    expect(iconDownloadUrl("icon-shield")).toBe("/api/icons/icon-shield");
  });

  it("encodes the fileId", () => {
    expect(iconDownloadUrl("icon shield")).toBe("/api/icons/icon%20shield");
  });
});

describe("findIcon", () => {
  it("finds a catalog entry by name", () => {
    expect(findIcon(CATALOG, "shield")).toMatchObject({
      name: "shield",
      fileId: "icon-shield",
    });
  });

  it("returns undefined for a name that is not in the catalog", () => {
    expect(findIcon(CATALOG, "does-not-exist")).toBeUndefined();
  });

  it("returns undefined against an empty catalog", () => {
    expect(findIcon([], "shield")).toBeUndefined();
  });
});

describe("where a new icon goes", () => {
  it("offsets the top-left corner so the icon is centred on that point", () => {
    expect(iconOrigin({ x: 1000, y: -400 })).toEqual({
      x: 1000 - ICON_SIZE / 2,
      y: -400 - ICON_SIZE / 2,
    });
  });

  it("rounds, so a fractional zoom does not put an icon on a half pixel", () => {
    expect(iconOrigin({ x: 10.4, y: 10.6 })).toEqual({
      x: -50,
      y: -49,
    });
  });
});
