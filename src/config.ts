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
  ai: { provider: "anthropic" | "openai"; baseUrl: string; apiKey: string; model: string };
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
      // Two providers are supported so the agent can run on a *free* key:
      //   - "anthropic" (default): Claude via @anthropic-ai/sdk.
      //   - "openai":  any OpenAI-compatible Chat Completions endpoint —
      //                e.g. Groq, Google Gemini (OpenAI-compat), or OpenRouter,
      //                all of which offer a free tier. Set AI_PROVIDER=openai,
      //                AI_BASE_URL to the provider's /v1 base, AI_API_KEY, AI_MODEL.
      // Auto-detect: if AI_PROVIDER is unset but AI_BASE_URL points somewhere
      // other than Anthropic, assume an OpenAI-compatible endpoint.
      provider:
        (process.env.AI_PROVIDER as "anthropic" | "openai") ||
        (process.env.AI_BASE_URL && !/anthropic\.com/.test(process.env.AI_BASE_URL)
          ? "openai"
          : "anthropic"),
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
