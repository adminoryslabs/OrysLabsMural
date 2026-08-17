import { describe, expect, it } from "vitest";
import {
  ICON_CATALOG,
  ICON_SIZE,
  findIcon,
  iconOrigin,
  iconUrl,
} from "@/lib/collab/icon-tool";

describe("the icon catalog", () => {
  it("has a unique name per entry", () => {
    const names = ICON_CATALOG.map((icon) => icon.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has a unique fileId per entry", () => {
    const fileIds = ICON_CATALOG.map((icon) => icon.fileId);
    expect(new Set(fileIds).size).toBe(fileIds.length);
  });

  it("derives every fileId from its name, so the catalog and public/icons stay in lockstep", () => {
    for (const icon of ICON_CATALOG) {
      expect(icon.fileId).toBe(`icon-${icon.name}`);
    }
  });

  it("is not empty", () => {
    expect(ICON_CATALOG.length).toBeGreaterThan(0);
  });
});

describe("iconUrl", () => {
  it("points at the static asset under public/icons", () => {
    expect(iconUrl("shield")).toBe("/icons/shield.png");
  });
});

describe("findIcon", () => {
  it("finds a catalog entry by name", () => {
    expect(findIcon("shield")).toMatchObject({
      name: "shield",
      fileId: "icon-shield",
    });
  });

  it("returns undefined for a name that is not in the catalog", () => {
    expect(findIcon("does-not-exist")).toBeUndefined();
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
