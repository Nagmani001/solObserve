/**
 * Generic Anchor program traffic generator.
 *
 * Usage:
 *   pnpm --filter @repo/bot start -- \
 *     --program <BASE58_ID> \
 *     --idl <PATH_TO_IDL.json> \
 *     [--cluster devnet|mainnet|localnet] \
 *     [--iterations 50] \
 *     [--delay-ms 800] \
 *     [--keypair ~/.config/solana/id.json]
 *
 * For each call: picks an instruction from the IDL, derives any PDAs from
 * `accounts[].pda.seeds`, fills numeric args with random values, signs with
 * the wallet, and sends the tx. Logs signature + status.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

type Cli = {
  program: string;
  idl: string;
  cluster: "devnet" | "mainnet" | "localnet";
  iterations: number;
  delayMs: number;
  keypair: string;
};

function parseArgs(): Cli {
  const args = process.argv.slice(2);
  const get = (flag: string, def?: string) => {
    const i = args.indexOf(flag);
    if (i === -1) return def;
    return args[i + 1];
  };
  const program = get("--program");
  const idl = get("--idl");
  if (!program || !idl) {
    console.error(
      "missing required --program <id> and --idl <path>\n" +
        "example: --program 89XirrVN9... --idl ./calculator.json --iterations 30",
    );
    process.exit(1);
  }
  return {
    program,
    idl,
    cluster: (get("--cluster", "devnet") as Cli["cluster"]) ?? "devnet",
    iterations: Number(get("--iterations", "30")),
    delayMs: Number(get("--delay-ms", "800")),
    keypair: get(
      "--keypair",
      path.join(os.homedir(), ".config/solana/id.json"),
    )!,
  };
}

function rpcUrl(cluster: Cli["cluster"]): string {
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  if (cluster === "mainnet") return "https://api.mainnet-beta.solana.com";
  return "http://127.0.0.1:8899";
}

function loadKeypair(p: string): Keypair {
  const expanded = p.startsWith("~") ? p.replace("~", os.homedir()) : p;
  const raw = JSON.parse(fs.readFileSync(expanded, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

type IxAccount = {
  name: string;
  writable?: boolean;
  signer?: boolean;
  address?: string;
  pda?: {
    seeds: Array<
      | { kind: "const"; value: number[] }
      | { kind: "account"; path: string }
      | { kind: "arg"; path: string }
    >;
  };
};

type IxArg = { name: string; type: string | object };

type IxDef = {
  name: string;
  discriminator: number[];
  accounts: IxAccount[];
  args: IxArg[];
};

type Idl = {
  address: string;
  metadata: { name: string };
  instructions: IxDef[];
};

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function pickValueForArg(arg: IxArg): bigint | number {
  const t = typeof arg.type === "string" ? arg.type : "i64";
  if (t.startsWith("u") || t.startsWith("i")) {
    return BigInt(Math.floor(Math.random() * 100) + 1);
  }
  return 1;
}

function encodeArg(arg: IxArg, v: bigint | number): Buffer {
  const t = typeof arg.type === "string" ? arg.type : "i64";
  const buf = Buffer.alloc(8);
  const big = typeof v === "bigint" ? v : BigInt(v);
  if (t === "u8" || t === "i8") {
    const b = Buffer.alloc(1);
    b.writeInt8(Number(big));
    return b;
  }
  if (t === "u16" || t === "i16") {
    const b = Buffer.alloc(2);
    b.writeInt16LE(Number(big));
    return b;
  }
  if (t === "u32" || t === "i32") {
    const b = Buffer.alloc(4);
    b.writeInt32LE(Number(big));
    return b;
  }
  // default i64/u64
  buf.writeBigInt64LE(big);
  return buf;
}

function derivePda(
  seeds: IxAccount["pda"]["seeds"],
  programId: PublicKey,
  authority: PublicKey,
  argValues: Map<string, bigint | number>,
): PublicKey {
  const seedBuffers: Buffer[] = [];
  for (const s of seeds) {
    if (s.kind === "const") {
      seedBuffers.push(Buffer.from(s.value));
    } else if (s.kind === "account") {
      // Only support `authority` path here; extend as needed.
      const camel = snakeToCamel(s.path);
      if (s.path === "authority" || camel === "authority") {
        seedBuffers.push(authority.toBuffer());
      } else {
        throw new Error(`unsupported PDA account seed: ${s.path}`);
      }
    } else if (s.kind === "arg") {
      const v = argValues.get(s.path) ?? argValues.get(snakeToCamel(s.path));
      if (v === undefined)
        throw new Error(`missing arg for PDA seed: ${s.path}`);
      seedBuffers.push(encodeArg({ name: s.path, type: "i64" }, v));
    }
  }
  const [pda] = PublicKey.findProgramAddressSync(seedBuffers, programId);
  return pda;
}

function buildIx(
  def: IxDef,
  programId: PublicKey,
  wallet: Keypair,
): { ix: TransactionInstruction; argValues: Map<string, bigint | number> } {
  const argValues = new Map<string, bigint | number>();
  for (const a of def.args) argValues.set(a.name, pickValueForArg(a));

  const keys = def.accounts.map((acc) => {
    let pubkey: PublicKey;
    if (acc.pda) {
      pubkey = derivePda(acc.pda.seeds, programId, wallet.publicKey, argValues);
    } else if (acc.address) {
      pubkey = new PublicKey(acc.address);
    } else if (acc.name === "authority" || acc.name === "payer" || acc.signer) {
      pubkey = wallet.publicKey;
    } else if (acc.name === "system_program" || acc.name === "systemProgram") {
      pubkey = SystemProgram.programId;
    } else {
      throw new Error(`cannot resolve account ${acc.name}`);
    }
    return {
      pubkey,
      isSigner: !!acc.signer,
      isWritable: !!acc.writable,
    };
  });

  const data = Buffer.concat([
    Buffer.from(def.discriminator),
    ...def.args.map((a) => encodeArg(a, argValues.get(a.name)!)),
  ]);

  return {
    ix: new TransactionInstruction({ programId, keys, data }),
    argValues,
  };
}

async function ensureInitialized(
  conn: Connection,
  idl: Idl,
  programId: PublicKey,
  wallet: Keypair,
) {
  const initDef = idl.instructions.find((x) => x.name === "initialize");
  if (!initDef) return;
  // Try to find an account derived purely from authority (typical state PDA).
  const stateAcc = initDef.accounts.find(
    (a) => a.pda && a.pda.seeds.every((s) => s.kind !== "arg"),
  );
  if (!stateAcc) return;
  const pda = derivePda(
    stateAcc.pda!.seeds,
    programId,
    wallet.publicKey,
    new Map(),
  );
  const info = await conn.getAccountInfo(pda);
  if (info) {
    console.log(`[init] state PDA ${pda.toBase58()} already exists`);
    return;
  }
  console.log(`[init] calling initialize, PDA=${pda.toBase58()}`);
  const { ix } = buildIx(initDef, programId, wallet);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(conn, tx, [wallet], {
    commitment: "confirmed",
  });
  console.log(`[init] ok sig=${sig}`);
}

async function main() {
  const cli = parseArgs();
  console.log(`[bot] cluster=${cli.cluster} program=${cli.program}`);
  const conn = new Connection(rpcUrl(cli.cluster), "confirmed");
  const wallet = loadKeypair(cli.keypair);
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(
    `[bot] wallet=${wallet.publicKey.toBase58()} balance=${(bal / 1e9).toFixed(4)} SOL`,
  );
  if (bal < 0.05 * 1e9) {
    console.warn(
      "[bot] low balance; run `solana airdrop 2 --url devnet` first",
    );
  }

  const idl: Idl = JSON.parse(fs.readFileSync(cli.idl, "utf-8"));
  const programId = new PublicKey(cli.program);

  await ensureInitialized(conn, idl, programId, wallet);

  // Pick instructions other than initialize for the spam loop.
  const callable = idl.instructions.filter((x) => x.name !== "initialize");
  if (callable.length === 0) {
    console.error("[bot] no non-initialize instructions in IDL");
    return;
  }

  let ok = 0;
  let fail = 0;
  for (let i = 0; i < cli.iterations; i++) {
    const def = callable[i % callable.length];
    try {
      const { ix } = buildIx(def, programId, wallet);
      const tx = new Transaction().add(ix);
      const sig = await sendAndConfirmTransaction(conn, tx, [wallet], {
        commitment: "confirmed",
      });
      ok++;
      console.log(`[${i + 1}/${cli.iterations}] ${def.name} ok ${sig}`);
    } catch (e: any) {
      fail++;
      console.warn(
        `[${i + 1}/${cli.iterations}] ${def.name} FAIL ${e.message ?? e}`,
      );
    }
    await new Promise((r) => setTimeout(r, cli.delayMs));
  }

  console.log(`\n[bot] done ok=${ok} fail=${fail}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
