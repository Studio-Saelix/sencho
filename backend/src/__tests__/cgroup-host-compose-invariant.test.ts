/**
 * Ensures every canonical nested-host Compose / docker run path joins the
 * host cgroup namespace. Without this, LXC capacity stays hidden.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("cgroup: host deployment invariant", () => {
  it("root docker-compose.yml sets cgroup: host", () => {
    expect(read("docker-compose.yml")).toMatch(/cgroup:\s*host/);
  });

  it("README Compose and docker run examples join host cgroupns", () => {
    const body = read("README.md");
    expect(body).toMatch(/cgroup:\s*host/);
    expect(body).toContain("--cgroupns=host");
  });

  it("quickstart Compose and docker run examples join host cgroupns", () => {
    const body = read("docs/getting-started/quickstart.mdx");
    expect(body).toMatch(/cgroup:\s*host/);
    expect(body).toContain("--cgroupns=host");
  });

  it("configuration full example sets cgroup: host", () => {
    expect(read("docs/getting-started/configuration.mdx")).toMatch(/cgroup:\s*host/);
  });

  it("pilot-agent docs include cgroup: host on both Compose examples", () => {
    const body = read("docs/features/pilot-agent.mdx");
    expect((body.match(/cgroup:\s*host/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
