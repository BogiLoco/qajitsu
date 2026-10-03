import { describe, expect, it } from "vitest";
import { checkComposeModel } from "./compose-safety.js";

const roots = ["/runs/r1/repos/shop", "/project/.qa"];

describe("compose model checks (REQ-ENV-03, invariant 10)", () => {
  it("accepts a plain service with loopback ports and mounts from the worktree", () => {
    expect(
      checkComposeModel(
        {
          services: {
            api: {
              volumes: [
                { type: "bind", source: "/runs/r1/repos/shop/api", target: "/app/api" },
                { type: "volume", source: "data", target: "/data" },
              ],
              ports: [{ host_ip: "127.0.0.1", published: "51234", target: 3000 }, { target: 3000 }],
              build: { context: "/runs/r1/repos/shop" },
            },
            pay: { volumes: [{ type: "bind", source: "/project/.qa/stubs/pay", target: "/m" }] },
          },
        },
        roots,
      ),
    ).toEqual([]);
    expect(checkComposeModel(null, roots)).toEqual([]);
  });

  it("rejects everything that would let the analysed branch reach the host", () => {
    const problems = checkComposeModel(
      {
        services: {
          evil: {
            privileged: true,
            cap_add: ["SYS_ADMIN"],
            devices: ["/dev/kmsg"],
            network_mode: "host",
            pid: "host",
            security_opt: ["seccomp:unconfined"],
            volumes: [
              { type: "bind", source: "/var/run/docker.sock", target: "/s" },
              { type: "bind", source: "/Users/someone/.aws", target: "/a" },
              { type: "bind", source: "/runs/r1/repos/shop/../../../etc", target: "/e" },
            ],
            build: { context: "/" },
            ports: [
              { published: "3000", target: 3000 },
              { host_ip: "0.0.0.0", published: "3001", target: 1 },
            ],
          },
        },
      },
      roots,
    );
    expect(problems).toEqual([
      "evil: privileged containers are not allowed",
      "evil: cap_add is not allowed",
      "evil: devices are not allowed",
      "evil: network_mode: host is not allowed",
      "evil: pid: host is not allowed",
      "evil: unconfined security options are not allowed",
      "evil: mounting the Docker socket is not allowed",
      "evil: bind mount /Users/someone/.aws is outside the worktree",
      "evil: bind mount /runs/r1/repos/shop/../../../etc is outside the worktree",
      "evil: build context / is outside the worktree",
      "evil: port 3000 is published on all interfaces",
      "evil: port 3001 is published on 0.0.0.0",
    ]);
  });
});
