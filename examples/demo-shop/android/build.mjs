#!/usr/bin/env node
// Builds the demo-shop Android app without Gradle: javac → d8 → aapt2 → zipalign → apksigner (debug key).
// Needs a JDK (JAVA_HOME, 17 recommended) and the Android SDK with platforms;android-34 and build-tools;34.0.0
// (ANDROID_SDK_ROOT, ANDROID_HOME or ~/Library/Android/sdk). Output: android/build/demo-shop.apk.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sdk =
  process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? join(homedir(), "Library", "Android", "sdk");
const tools = join(sdk, "build-tools", "34.0.0");
const androidJar = join(sdk, "platforms", "android-34", "android.jar");
const javaHome = process.env.JAVA_HOME ?? "/opt/homebrew/opt/openjdk@17";
const bin = (name) => join(javaHome, "bin", name);
if (!existsSync(androidJar) || !existsSync(tools))
  throw new Error(`Android SDK not found in ${sdk}: install platforms;android-34 and build-tools;34.0.0`);

const out = join(here, "build");
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "classes"), { recursive: true });
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
const sources = readdirSync(join(here, "src", "dev", "qajitsu", "demoshop")).map((f) =>
  join(here, "src", "dev", "qajitsu", "demoshop", f),
);
run(bin("javac"), [
  "-source",
  "11",
  "-target",
  "11",
  "-classpath",
  androidJar,
  "-d",
  join(out, "classes"),
  ...sources,
]);
const classes = readdirSync(join(out, "classes", "dev", "qajitsu", "demoshop")).map((f) =>
  join(out, "classes", "dev", "qajitsu", "demoshop", f),
);
run(join(tools, "d8"), ["--lib", androidJar, "--min-api", "26", "--output", out, ...classes]);
run(join(tools, "aapt2"), [
  "link",
  "-o",
  join(out, "unsigned.apk"),
  "--manifest",
  join(here, "AndroidManifest.xml"),
  "-I",
  androidJar,
]);
run(join(tools, "aapt"), ["add", "-k", join(out, "unsigned.apk"), join(out, "classes.dex")]);
run(join(tools, "zipalign"), ["-f", "4", join(out, "unsigned.apk"), join(out, "aligned.apk")]);
const keystore = join(out, "debug.keystore");
run(bin("keytool"), [
  "-genkeypair",
  "-keystore",
  keystore,
  "-storepass",
  "android",
  "-keypass",
  "android",
  "-alias",
  "debug",
  "-keyalg",
  "RSA",
  "-keysize",
  "2048",
  "-validity",
  "3650",
  "-dname",
  "CN=QAJitsu Demo,O=Fictional",
]);
run(join(tools, "apksigner"), [
  "sign",
  "--ks",
  keystore,
  "--ks-pass",
  "pass:android",
  "--key-pass",
  "pass:android",
  "--out",
  join(out, "demo-shop.apk"),
  join(out, "aligned.apk"),
]);
process.stdout.write(`${join(out, "demo-shop.apk")}\n`);
