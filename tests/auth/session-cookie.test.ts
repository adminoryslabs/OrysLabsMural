import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  readSessionTokenFromCookieHeader,
} from "@/lib/auth/session-cookie";

describe("parseCookieHeader", () => {
  it("returns an empty jar for a missing header", () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
  });

  it("parses several cookies", () => {
    expect(parseCookieHeader("a=1; b=2;c=3")).toEqual({
      a: "1",
      b: "2",
      c: "3",
    });
  });

  it("keeps '=' inside a value", () => {
    // Base64url tokens do not contain '=', but a padded base64 value would.
    expect(parseCookieHeader("t=abc==")).toEqual({ t: "abc==" });
  });

  it("strips surrounding double quotes", () => {
    expect(parseCookieHeader('t="quoted"')).toEqual({ t: "quoted" });
  });

  it("percent-decodes values and survives a malformed escape", () => {
    expect(parseCookieHeader("t=a%20b")).toEqual({ t: "a b" });
    expect(parseCookieHeader("t=%E0%A4%A")).toEqual({ t: "%E0%A4%A" });
  });

  it("ignores nameless or empty segments", () => {
    expect(parseCookieHeader("; =x; a=1;")).toEqual({ a: "1" });
  });

  it("lets the first occurrence of a name win", () => {
    expect(parseCookieHeader("a=first; a=second")).toEqual({ a: "first" });
  });
});

describe("readSessionTokenFromCookieHeader", () => {
  it("finds the session token among other cookies", () => {
    const header = `theme=dark; ${SESSION_COOKIE_NAME}=tok3n; lang=es`;
    expect(readSessionTokenFromCookieHeader(header)).toBe("tok3n");
  });

  it("returns null when the session cookie is absent or empty", () => {
    expect(readSessionTokenFromCookieHeader("theme=dark")).toBeNull();
    expect(
      readSessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=`),
    ).toBeNull();
    expect(readSessionTokenFromCookieHeader(null)).toBeNull();
  });
});
