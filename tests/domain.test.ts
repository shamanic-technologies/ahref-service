import { describe, it, expect } from "vitest";
import { normalizeDomain } from "../src/lib/domain";

describe("normalizeDomain", () => {
  it("strips a leading www (the www exception)", () => {
    expect(normalizeDomain("www.example.com")).toBe("example.com");
  });

  it("leaves an apex domain unchanged", () => {
    expect(normalizeDomain("example.com")).toBe("example.com");
  });

  it("lower-cases and trims", () => {
    expect(normalizeDomain("  Www.Example.COM  ")).toBe("example.com");
  });

  it("keeps non-www subdomains distinct", () => {
    expect(normalizeDomain("blog.example.com")).toBe("blog.example.com");
    expect(normalizeDomain("api.example.com")).toBe("api.example.com");
  });

  it("strips ONLY the leading www, keeping deeper labels", () => {
    expect(normalizeDomain("www.blog.example.com")).toBe("blog.example.com");
  });

  it("does NOT strip www2 / wwwx (only exact www)", () => {
    expect(normalizeDomain("www2.example.com")).toBe("www2.example.com");
    expect(normalizeDomain("wwwx.example.com")).toBe("wwwx.example.com");
  });

  it("extracts the hostname from a full URL", () => {
    expect(normalizeDomain("https://www.example.com/path?q=1#frag")).toBe(
      "example.com"
    );
    expect(normalizeDomain("http://blog.example.com")).toBe("blog.example.com");
  });

  it("handles protocol-relative URLs", () => {
    expect(normalizeDomain("//www.example.com/x")).toBe("example.com");
  });

  it("strips a port", () => {
    expect(normalizeDomain("example.com:443")).toBe("example.com");
    expect(normalizeDomain("https://www.example.com:8080/x")).toBe(
      "example.com"
    );
  });

  it("strips a path on a bare host", () => {
    expect(normalizeDomain("example.com/some/path")).toBe("example.com");
  });

  it("strips a trailing dot (FQDN root)", () => {
    expect(normalizeDomain("www.example.com.")).toBe("example.com");
  });

  it("folds www and apex to the SAME key", () => {
    expect(normalizeDomain("www.example.com")).toBe(normalizeDomain("example.com"));
  });

  it("throws on empty / whitespace input (fail loud)", () => {
    expect(() => normalizeDomain("")).toThrow();
    expect(() => normalizeDomain("   ")).toThrow();
  });

  it("throws on scheme-only / unusable input", () => {
    expect(() => normalizeDomain("https://")).toThrow();
    expect(() => normalizeDomain("not a domain")).toThrow();
    expect(() => normalizeDomain("localhost")).toThrow();
  });
});
