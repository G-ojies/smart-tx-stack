import * as fs from "fs";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env ${name} (see .env.example)`);
  return v;
}

export type Network = "mainnet" | "testnet";

export interface Config {
  network: Network;
  rpcUrl: string;
  yellowstoneUrl: string;
  yellowstoneToken: string | undefined;
  jitoBlockEngineUrl: string;
  walletKeypairPath: string;
  ai: { baseUrl: string; apiKey: string; model: string };
  maxTipLamports: number;
}

export function loadConfig(): Config {
  const network = (process.env.NETWORK || "mainnet") as Network;
  return {
    network,
    rpcUrl: req("RPC_URL"),
    yellowstoneUrl: req("YELLOWSTONE_GRPC_URL"),
    yellowstoneToken: process.env.YELLOWSTONE_X_TOKEN || undefined,
    jitoBlockEngineUrl:
      process.env.JITO_BLOCK_ENGINE_URL ||
      (network === "testnet"
        ? "https://testnet.block-engine.jito.wtf"
        : "https://mainnet.block-engine.jito.wtf"),
    walletKeypairPath: process.env.WALLET_KEYPAIR_PATH || "./wallet.json",
    ai: {
      // Default: Anthropic (api.anthropic.com). Leave AI_BASE_URL empty to use
      // the SDK default; set it only to route through a gateway/proxy.
      baseUrl: process.env.AI_BASE_URL || "",
      apiKey: process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY || "",
      model: process.env.AI_MODEL || "claude-opus-4-8",
    },
    maxTipLamports: parseInt(process.env.MAX_TIP_LAMPORTS || "200000", 10),
  };
}

export function loadWallet(p: string): Keypair {
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) {
    throw new Error(`Wallet keypair not found at ${abs}. Set WALLET_KEYPAIR_PATH.`);
  }
  const secret = JSON.parse(fs.readFileSync(abs, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
