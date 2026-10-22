import { createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  CERTIFICATE_PREDICATE_TYPE,
  STATEMENT_TYPE,
  renderCertificateBlock,
  type DsseEnvelope,
} from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import {
  certificateId,
  certificateScope,
  certificateStatement,
  certificateSubject,
  checkCertificate,
  keyIdOf,
  keySigner,
  merkleRoot,
  signStatement,
} from "./certificate.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const keyPair = () => generateKeyPairSync("ed25519");

const runFiles = (): Map<string, Uint8Array> =>
  new Map([
    ["plan/plan.approved.yaml", enc("cases: [TC-01]\n")],
    ["evidence/manifest.json", enc("[]")],
    ["report/matrix.md", enc("| TC-01 | FAILED |\n")],
    ["report/report.html", enc(`<h1>DEMO-1</h1>${renderCertificateBlock()}<p>TC-01 FAILED</p>`)],
    ["journal/events.jsonl", enc('{"event":"a"}\n')],
  ]);

const certify = (files: Map<string, Uint8Array>, key = keyPair().privateKey) => {
  const statement = certificateStatement(
    [...files].map(([p, d]) => certificateSubject(p, d)),
    { ticket: "DEMO-1", runId: "r", issuedAt: "2026-10-22T10:00:00.000Z" },
  );
  return { envelope: signStatement(statement, keySigner(key)), key };
};

describe("test certificate (REQ-VER-15)", () => {
  it("REQ-VER-15/AC2+AC3+AC5: an in-toto statement in a DSSE envelope, signed with the project key, verifies against the files", () => {
    const files = runFiles();
    const { envelope, key } = certify(files);
    expect(envelope.payloadType).toBe("application/vnd.in-toto+json");
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      _type: string;
      predicateType: string;
      subject: { name: string }[];
    };
    expect(statement._type).toBe(STATEMENT_TYPE);
    expect(statement.predicateType).toBe(CERTIFICATE_PREDICATE_TYPE);
    expect(statement.subject.map((s) => s.name)).toEqual([...files.keys()].sort());
    const check = checkCertificate(envelope, [createPublicKey(key)], (p) => files.get(p));
    expect(check).toMatchObject({ changed: [], missing: [], problems: [], id: certificateId(envelope) });
    expect(check.id).toMatch(/^qjc-[0-9a-f]{20}$/);
    expect(check.keyId).toBe(keyIdOf(key));
  });

  it("REQ-VER-15/AC3+AC4: one changed byte, a removed file or a cut journal is reported by name; a journal that grew is fine", () => {
    const files = runFiles();
    const { envelope, key } = certify(files);
    const trusted = [createPublicKey(key)];
    const edited = new Map(files);
    edited.set("report/matrix.md", enc("| TC-01 | PASSED |\n"));
    edited.delete("evidence/manifest.json");
    edited.set("journal/events.jsonl", enc('{"event":"a"}\n{"event":"publish"}\n'));
    expect(checkCertificate(envelope, trusted, (p) => edited.get(p))).toMatchObject({
      changed: ["report/matrix.md"],
      missing: ["evidence/manifest.json"],
      problems: [],
    });
    edited.set("journal/events.jsonl", enc('{"event":"b"}\n{"event":"publish"}\n'));
    expect(checkCertificate(envelope, trusted, (p) => edited.get(p)).changed).toContain(
      "journal/events.jsonl",
    );
    edited.set("journal/events.jsonl", enc("{"));
    expect(checkCertificate(envelope, trusted, (p) => edited.get(p)).changed).toContain(
      "journal/events.jsonl",
    );

    // The root depends on every leaf: one byte anywhere changes it.
    const subjects = [...files].map(([p, d]) => certificateSubject(p, d));
    const other = [...edited].map(([p, d]) => certificateSubject(p, d));
    expect(merkleRoot(subjects)).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(other)).not.toBe(merkleRoot(subjects));
    expect(merkleRoot([])).toMatch(/^[0-9a-f]{64}$/);
    expect(merkleRoot(subjects.slice(0, 1))).not.toBe(merkleRoot(subjects.slice(0, 2)));
  });

  it("REQ-VER-15/AC7: stamping the certificate into report.html keeps it valid; any other text in its section is a change", () => {
    const files = runFiles();
    const { envelope, key } = certify(files);
    const trusted = [createPublicKey(key)];
    const html = new TextDecoder().decode(files.get("report/report.html"));
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate: { merkleRoot: string };
    };
    const stamp = renderCertificateBlock({
      id: certificateId(envelope),
      merkleRoot: statement.predicate.merkleRoot,
      keyId: keyIdOf(key),
    });
    const stamped = new Map(files);
    stamped.set("report/report.html", enc(html.replace(renderCertificateBlock(), stamp)));
    expect(checkCertificate(envelope, trusted, (p) => stamped.get(p)).changed).toEqual([]);
    expect(html.replace(renderCertificateBlock(), stamp)).toContain(certificateId(envelope));
    // Someone hides a claim inside the section the hash leaves out.
    stamped.set(
      "report/report.html",
      enc(
        html.replace(renderCertificateBlock(), stamp.replace("<h2>Certificate</h2>", "<h2>All PASSED</h2>")),
      ),
    );
    expect(checkCertificate(envelope, trusted, (p) => stamped.get(p)).changed).toEqual([
      "report/report.html",
    ]);
  });

  it("REQ-VER-15/AC6: keys rotate: an old certificate verifies with its old public key; an untrusted or wrong key fails", () => {
    const files = runFiles();
    const old = keyPair();
    const current = keyPair();
    const { envelope } = certify(files, old.privateKey);
    const read = (p: string) => files.get(p);
    expect(checkCertificate(envelope, [current.publicKey, old.publicKey], read).problems).toEqual([]);
    expect(checkCertificate(envelope, [current.publicKey], read).problems).toEqual([
      `signed with key ${keyIdOf(old.publicKey).slice(0, 16)}, which is not a trusted key (pass it with --key)`,
    ]);
    // A signature moved onto another statement, or a key id claimed by someone else, does not verify.
    const forged: DsseEnvelope = {
      ...envelope,
      payload: certify(
        new Map([...files, ["report/matrix.md", enc("| TC-01 | PASSED |\n")]]),
        current.privateKey,
      ).envelope.payload,
    };
    expect(checkCertificate(forged, [old.publicKey], read).problems).toEqual([
      "the signature does not match: the certificate was changed or signed with another key",
    ]);
  });

  it("REQ-VER-15/AC3: an unsigned, malformed or foreign envelope and a statement whose root was edited fail", () => {
    const files = runFiles();
    const { envelope, key } = certify(files);
    const trusted = [key.type === "private" ? createPublicKey(key) : key];
    const read = (p: string) => files.get(p);
    expect(checkCertificate({ ...envelope, signatures: [] }, trusted, read).problems).toEqual([
      "the certificate is not signed",
    ]);
    expect(checkCertificate({ ...envelope, payloadType: "text/plain" }, trusted, read).problems).toEqual([
      "unexpected payload type text/plain",
    ]);
    const notJson = { ...envelope, payload: Buffer.from("{").toString("base64"), signatures: [] };
    expect(checkCertificate(notJson, trusted, read).problems).toContain("the payload is not JSON");
    const foreign = { ...envelope, payload: Buffer.from('{"_type":"x"}').toString("base64"), signatures: [] };
    expect(checkCertificate(foreign, trusted, read).problems).toContain("not a QAJitsu test certificate");
    const statementOf = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const badSubject = {
      ...envelope,
      payload: Buffer.from(JSON.stringify({ ...statementOf, subject: [{ name: "x" }] })).toString("base64"),
    };
    expect(checkCertificate(badSubject, trusted, read).problems.at(-1)).toMatch(
      /^the statement does not match the certificate schema: subject\.0\.digest: /,
    );
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate: Record<string, unknown>;
    };
    const edited = {
      ...envelope,
      payload: Buffer.from(
        JSON.stringify({ ...statement, predicate: { ...statement.predicate, merkleRoot: "0".repeat(64) } }),
      ).toString("base64"),
    };
    expect(checkCertificate(edited, trusted, read).problems).toEqual([
      "the signature does not match: the certificate was changed or signed with another key",
      "the Merkle root does not match the listed files",
    ]);
  });

  it("REQ-VER-15/AC1: what the certificate covers: the run's files, journals and logs as written so far; not run.json, env, audit, publish copies", () => {
    expect(
      [
        "plan/plan.approved.yaml",
        "journal/agents.jsonl",
        "logs/api.log",
        "run.json",
        "env/api.env",
        "audit/trail.json",
        "certificate/certificate.dsse.json",
        "report/published/jira-comment.wiki.txt",
        "report/media/x.mp4",
      ].map(certificateScope),
    ).toEqual([
      "exact",
      "prefix",
      "prefix",
      "excluded",
      "excluded",
      "excluded",
      "excluded",
      "excluded",
      "excluded",
    ]);
  });
});
