import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import { OID, der, derParse } from "../../packages/verifier/src/timestamp.js";

/**
 * A fake RFC 3161 time-stamping authority for tests: a CA and a TSA certificate made here (ECDSA P-256, nothing kept
 * on disk), and tokens built like a real TSA builds them, with switches to break each part.
 */
const name = (cn: string): Buffer =>
  der.seq(der.set(der.seq(der.oid("2.5.4.3"), der.node(0x0c, Buffer.from(cn)))));
const utc = (d: Date): Buffer =>
  der.node(0x17, Buffer.from(`${d.toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));
const ECDSA = der.seq(der.oid(OID.ecdsaSha256));

function certificate(o: {
  serial: number;
  issuer: string;
  subject: string;
  from: Date;
  to: Date;
  publicKey: KeyObject;
  signer: KeyObject;
  ca?: boolean;
  timeStamping?: boolean;
}): Buffer {
  const exts: Buffer[] = [];
  if (o.ca) exts.push(der.seq(der.oid("2.5.29.19"), der.bool(true), der.octets(der.seq(der.bool(true)))));
  if (o.timeStamping)
    exts.push(der.seq(der.oid("2.5.29.37"), der.bool(true), der.octets(der.seq(der.oid(OID.timeStamping)))));
  const tbs = der.seq(
    der.ctx(0, der.int(2)),
    der.int(o.serial),
    ECDSA,
    name(o.issuer),
    der.seq(utc(o.from), utc(o.to)),
    name(o.subject),
    o.publicKey.export({ type: "spki", format: "der" }),
    ...(exts.length > 0 ? [der.ctx(3, der.seq(...exts))] : []),
  );
  const sig = sign("sha256", tbs, o.signer);
  return der.seq(tbs, ECDSA, der.node(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

const pem = (body: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${body.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;

/** Options of one token: each one breaks a part of it. */
export interface StampOptions {
  readonly genTime?: Date;
  /** Stamp this digest instead of the requested one. */
  readonly digest?: Buffer;
  /** Answer with this nonce instead of the request's. */
  readonly nonce?: Buffer;
  /** Change the TSTInfo after signing. */
  readonly tamper?: boolean;
  /** Sign with a key that is not the certificate's. */
  readonly wrongKey?: boolean;
  /** Use a TSA certificate without the timeStamping purpose. */
  readonly noEku?: boolean;
  /** PKIStatus to answer with (2 = rejection). */
  readonly status?: number;
  /** Issue the TSA certificate from an intermediate CA carried in the token (expired when `expired`). */
  readonly intermediate?: "valid" | "expired";
  /** Carry no certificate in the token. */
  readonly noCerts?: boolean;
  /** Carry bytes that are no certificate next to the TSA's. */
  readonly junkCert?: boolean;
  /** Signature algorithm OID to name instead of ecdsa-with-SHA256. */
  readonly sigAlg?: string;
  /** Digest algorithm OID of the signer instead of SHA-256. */
  readonly digestAlg?: string;
  /** Content type in the signed attributes instead of TSTInfo. */
  readonly contentType?: string;
  /** Imprint hash algorithm instead of SHA-256. */
  readonly imprintAlg?: string;
  /** Leave the nonce out of the TSTInfo. */
  readonly noNonce?: boolean;
  /** GeneralizedTime text instead of a valid one. */
  readonly rawTime?: string;
  /** Leave the signed attributes out. */
  readonly noAttrs?: boolean;
  /** Replace the TSTInfo by bytes that are not DER. */
  readonly junkTst?: boolean;
  /** Leave the signer infos empty. */
  readonly noSigner?: boolean;
}

/** A fake TSA with its CA (`caPem` is what a project would trust). */
export function createFakeTsa(now = new Date("2026-10-03T10:46:00Z")) {
  const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const tsa = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + 365 * 86_400_000);
  const caCert = certificate({
    serial: 1,
    issuer: "Fake TSA Root",
    subject: "Fake TSA Root",
    from,
    to,
    publicKey: ca.publicKey,
    signer: ca.privateKey,
    ca: true,
  });
  const mid = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const intermediate = (expired: boolean) =>
    certificate({
      serial: 4,
      issuer: "Fake TSA Root",
      subject: "Fake TSA Intermediate",
      from: expired ? new Date(from.getTime() - 86_400_000) : from,
      to: expired ? new Date(now.getTime() - 3_600_000) : to,
      publicKey: mid.publicKey,
      signer: ca.privateKey,
      ca: true,
    });
  const tsaCert = (eku: boolean, viaIntermediate = false) =>
    certificate({
      serial: eku ? 2 : 3,
      issuer: viaIntermediate ? "Fake TSA Intermediate" : "Fake TSA Root",
      subject: "Fake TSA",
      from,
      to,
      publicKey: tsa.publicKey,
      signer: viaIntermediate ? mid.privateKey : ca.privateKey,
      timeStamping: eku,
    });
  // Each certificate once: an ECDSA signature differs on every signing, and a certificate is known by its bytes.
  const issued = {
    eku: tsaCert(true),
    noEku: tsaCert(false),
    viaMid: tsaCert(true, true),
    mid: intermediate(false),
    expiredMid: intermediate(true),
  };
  let serial = 100;
  const stamp = (request: Buffer, o: StampOptions = {}): Buffer => {
    if (o.status !== undefined && o.status > 1)
      return der.seq(der.seq(der.int(o.status), der.seq(der.node(0x0c, Buffer.from("request rejected")))));
    const req = derParse(request);
    const imprint = req.children[1]?.children[1]?.value ?? Buffer.alloc(32);
    const nonce = o.nonce ?? Buffer.from(req.children[2]?.value ?? Buffer.alloc(8));
    const t = o.genTime ?? now;
    const genTime = `${t.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`;
    serial += 1;
    let tst = der.seq(
      der.int(1),
      der.oid("1.3.6.1.4.1.99999.1"),
      der.seq(
        der.seq(der.oid(o.imprintAlg ?? OID.sha256), der.null()),
        der.octets(o.digest ?? Buffer.from(imprint)),
      ),
      der.int(serial),
      der.node(0x18, Buffer.from(o.rawTime ?? genTime)),
      ...(o.noNonce ? [] : [der.int(nonce)]),
    );
    if (o.junkTst) tst = Buffer.from([0x30, 0x05, 0x01]);
    const attrs = der.set(
      der.seq(der.oid(OID.contentType), der.set(der.oid(o.contentType ?? OID.tstInfo))),
      der.seq(der.oid(OID.messageDigest), der.set(der.octets(createHash("sha256").update(tst).digest()))),
    );
    const sig = sign("sha256", attrs, o.wrongKey ? other.privateKey : tsa.privateKey);
    if (o.tamper)
      tst = Buffer.from(tst.toString("latin1").replace(genTime, genTime.replace(/^\d{4}/, "2030")), "latin1");
    const signer = der.seq(
      der.int(1),
      der.seq(name("Fake TSA Root"), der.int(o.noEku ? 3 : 2)),
      der.seq(der.oid(o.digestAlg ?? OID.sha256)),
      ...(o.noAttrs ? [] : [Buffer.concat([Buffer.from([0xa0]), attrs.subarray(1)])]),
      o.sigAlg === undefined ? ECDSA : der.seq(der.oid(o.sigAlg)),
      der.octets(sig),
    );
    const signedData = der.seq(
      der.int(3),
      der.set(der.seq(der.oid(OID.sha256))),
      der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octets(tst))),
      ...(o.noCerts
        ? []
        : [
            der.ctx(
              0,
              Buffer.concat([
                o.intermediate !== undefined ? issued.viaMid : o.noEku ? issued.noEku : issued.eku,
                ...(o.intermediate ? [o.intermediate === "expired" ? issued.expiredMid : issued.mid] : []),
                ...(o.junkCert ? [der.seq(der.int(7))] : []),
              ]),
            ),
          ]),
      o.noSigner ? der.set() : der.set(signer),
    );
    return der.seq(der.seq(der.int(0)), der.seq(der.oid(OID.signedData), der.ctx(0, signedData)));
  };
  return { caPem: pem(caCert), tsaPem: pem(issued.eku), stamp };
}

/**
 * A fake TSA listening on localhost: answers like a real one, or as `set` says; keeps the requests it got.
 *
 * @returns Its URL, the CA to trust, the requests, a switch and a `close`.
 */
export async function startFakeTsaServer() {
  const tsa = createFakeTsa();
  const requests: Buffer[] = [];
  let mode: StampOptions = {};
  let httpStatus = 200;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      requests.push(body);
      if (httpStatus !== 200) {
        res.writeHead(httpStatus).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/timestamp-reply" }).end(tsa.stamp(body, mode));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/tsr`,
    caPem: tsa.caPem,
    requests,
    set: (o: StampOptions, status = 200) => {
      mode = o;
      httpStatus = status;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}
