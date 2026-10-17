#!/usr/bin/env node
// A fictional command-line tool for the tests of CLI exploration (REQ-EXEC-24): it prompts, waits for Ctrl+C, leaves
// a process behind, writes files, prints its environment and makes HTTP requests through the proxy it is given.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { createInterface } from "node:readline";

const [command = "help", ...rest] = process.argv.slice(2);

const proxied = (target) =>
  new Promise((resolve) => {
    const proxy = process.env.HTTP_PROXY ? new URL(process.env.HTTP_PROXY) : undefined;
    const url = new URL(target);
    const req = http.request(
      proxy
        ? {
            host: proxy.hostname,
            port: proxy.port,
            path: url.href,
            method: "GET",
            headers: { host: url.host },
          }
        : { host: url.hostname, port: url.port, path: url.pathname, method: "GET" },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(`${String(res.statusCode)} ${body}`));
      },
    );
    req.on("error", (e) => resolve(`error ${e.message}`));
    req.end();
  });

switch (command) {
  case "hello":
    console.log(`hello ${rest.join(" ")}`.trim());
    break;
  case "fail":
    console.error("boom: the tool failed");
    process.exitCode = 2;
    break;
  case "ask": {
    process.stdout.write("Type yes to confirm: ");
    const rl = createInterface({ input: process.stdin });
    rl.once("line", (line) => {
      console.log(line.trim() === "yes" ? "confirmed" : "aborted");
      process.exitCode = line.trim() === "yes" ? 0 : 1;
      rl.close();
    });
    rl.once("close", () => undefined);
    break;
  }
  case "serve": {
    console.log("listening; press Ctrl+C to stop");
    const keep = setInterval(() => undefined, 1 << 30);
    process.on("SIGINT", () => {
      console.log("stopped");
      clearInterval(keep);
    });
    break;
  }
  case "orphan": {
    // A child that outlives the tool: the session must find it and stop it.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.cwd()], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`started ${String(child.pid)}`);
    break;
  }
  case "write":
    writeFileSync(rest[0] ?? "out.txt", "written\n");
    console.log(`wrote ${rest[0] ?? "out.txt"}`);
    break;
  case "env":
    console.log(
      Object.keys(process.env)
        .filter((k) => !k.startsWith("__CF") && k !== "_")
        .sort()
        .join("\n"),
    );
    if (process.env.TOOL_TOKEN) console.log(`token ${process.env.TOOL_TOKEN}`);
    break;
  case "get":
    console.log(await proxied(rest[0] ?? "http://127.0.0.1:1/"));
    break;
  default:
    console.log("usage: tool hello|fail|ask|serve|orphan|write <file>|env|get <url>");
}
