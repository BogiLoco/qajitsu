import { z } from "zod";

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");
const RelPath = z.string().regex(/^(?!\/)(?!.*\.\.)[\w./*-]+$/, "Relative path without ..");
const Alias = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/**
 * Where the app binary comes from (REQ-ENV-06/AC1): a CI artifact of the change SHA, a file in the
 * worktree, or a build command run in the worktree.
 */
export const AppSourceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("ci"),
    /** Repository alias whose CI built the app for the analysed SHA. */
    repo: Alias,
    /** Artifact name in GitHub Actions or the GitLab job artifacts. */
    artifact: z.string().min(1).max(200),
    /** File inside the artifact (glob with `*`), e.g. `*.apk`. */
    file: RelPath,
  }),
  z.strictObject({ source: z.literal("path"), repo: Alias, path: RelPath }),
  z.strictObject({
    source: z.literal("build"),
    repo: Alias,
    /** Argument array run in the worktree (no shell). */
    command: z.array(z.string().min(1)).min(1),
    output: RelPath,
  }),
]);

/** Mobile testing (REQ-EXEC-06, REQ-ENV-06, REQ-EVD-03). */
export const MobileSchema = z.strictObject({
  appium: z
    .strictObject({
      /** An Appium server to use; without it QAJitsu starts one on a free port. */
      url: z.url().optional(),
      /** Appium executable when QAJitsu starts the server (default `appium` on PATH); relative to `.qa/`. */
      bin: z.string().min(1).optional(),
      /** APPIUM_HOME with the installed drivers; relative to `.qa/` (default: Appium's own, `~/.appium`). */
      home: z.string().min(1).optional(),
    })
    .default({}),
  /**
   * Devices used in parallel (REQ-EXEC-10/AC2): mobile cases are split among them and each device runs its
   * cases one after another. Android starts one emulator per device; a device farm opens one session each.
   */
  devices: z.number().int().min(1).max(8).default(1),
  /** Screen recording per case (REQ-EVD-03/AC2). */
  recording: z.enum(["retain-on-failure", "always", "off"]).default("retain-on-failure"),
  action_timeout_ms: z.number().int().min(500).max(120_000).default(10_000),
  android: z
    .strictObject({
      app: AppSourceSchema,
      /** Application id (package), used for deep links and logcat. */
      app_id: z.string().regex(/^[a-zA-Z][\w.]*$/),
      deep_link_scheme: z
        .string()
        .regex(/^[a-z][a-z0-9+.-]*$/)
        .optional(),
      /** Launcher activity, e.g. `.MainActivity`. */
      activity: z
        .string()
        .regex(/^\.?[A-Za-z][\w.]*$/)
        .optional(),
      /**
       * `am start` arguments for the launch, e.g. `--es api_url {{base_url}}`; `{{base_url}}` is the
       * environment URL as the emulator sees it (localhost becomes 10.0.2.2).
       */
      intent_args: z
        .string()
        .max(500)
        // Passed to `am start` in a device shell: no shell metacharacters or quotes.
        .regex(/^[\w\s.:/{}=,-]*$/, "Only letters, digits, spaces and . : / { } = , - _ are allowed")
        .optional(),
      /** Emulator started and stopped by QAJitsu (REQ-ENV-06/AC2). */
      emulator: z
        .strictObject({
          avd: z
            .string()
            .regex(/^[\w.-]+$/)
            .default("qajitsu"),
          system_image: z.string().regex(/^system-images;[\w.;-]+$/),
          headless: z.boolean().default(true),
          boot_timeout_s: z.number().int().min(30).max(1800).default(300),
        })
        .optional(),
      /** SDK root; default `$ANDROID_SDK_ROOT`, `$ANDROID_HOME` or `~/Library/Android/sdk`. */
      sdk_root: z.string().min(1).optional(),
    })
    .optional(),
  ios: z
    .strictObject({
      /** App for a local simulator run (needs Xcode); farms use `farm.app`. */
      app: AppSourceSchema.optional(),
      bundle_id: z.string().regex(/^[a-zA-Z][\w.-]*$/),
      deep_link_scheme: z
        .string()
        .regex(/^[a-z][a-z0-9+.-]*$/)
        .optional(),
      /** Device farm used when this machine cannot run the iOS simulator (REQ-ENV-06/AC3). */
      farm: z
        .strictObject({
          provider: z.enum(["browserstack", "saucelabs"]),
          /** The app as uploaded to the farm (`bs://...`, `storage:...`); a local path never leaves the machine. */
          app: z
            .string()
            .regex(/^(bs:\/\/[\w-]+|storage:[\w=.:-]+)$/, "Expected a bs://... or storage:... id"),
          /** Let the farm record video and device logs (stored by the vendor, outside the secret scan). */
          vendor_recording: z.boolean().default(false),
          username: SecretRef,
          access_key: SecretRef,
          device: z.string().min(1),
          os_version: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
});

/** Parsed `mobile` section. */
export type MobileConfig = z.infer<typeof MobileSchema>;
