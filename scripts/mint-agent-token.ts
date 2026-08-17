import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createDatabase } from "@/lib/db";
import { createSession } from "@/lib/auth/session";
import { createUser, findUserByEmail } from "@/lib/auth/users";

/**
 * Provisions (or reuses) the account the `prepare-board` skill writes boards
 * as, and prints a fresh session token for it.
 *
 * Role is `teacher` — same as any teaching-assistant account — so it can see
 * and write to every board, without any exception carved into the authority
 * model. It is marked as an agent only by its display name; the account is
 * otherwise ordinary, and every write it makes is attributed to its own
 * userId like anyone else's.
 *
 * Run once per environment (local dev, or against production over an SSH
 * tunnel to DATABASE_URL). The printed token is a normal session: it renews
 * itself on use and lasts SESSION_TTL_DAYS between uses. Treat it as a
 * standing shared secret — set MURAL_AGENT_SESSION_TOKEN locally for whoever
 * runs the skill, never commit it, and re-run this script to mint a new one
 * if it ever leaks.
 *
 *   npx tsx scripts/mint-agent-token.ts
 */

const AGENT_EMAIL = process.env.AGENT_EMAIL ?? "agent@collab.local";
const AGENT_NAME = process.env.AGENT_NAME ?? "🤖 OrysLabs Agent";

function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]!).join("");
}

async function main(): Promise<void> {
  const db = createDatabase(process.env.DATABASE_URL!);

  let user = await findUserByEmail(db, AGENT_EMAIL);
  if (!user) {
    const created = await createUser(db, {
      email: AGENT_EMAIL,
      password: generatePassword(),
      displayName: AGENT_NAME,
      role: "teacher",
    });
    user = created;
    console.log(`Created ${AGENT_EMAIL} (teacher).`);
  } else {
    console.log(`Reusing existing account ${AGENT_EMAIL}.`);
  }

  const { token } = await createSession(db, user.id);

  console.log("\nSet this in the environment of whoever runs the prepare-board skill:\n");
  console.log(`MURAL_AGENT_SESSION_TOKEN=${token}`);
  console.log(`MURAL_AGENT_YJS_URL=wss://collab.oryslabs.com/yjs   # or ws://localhost:1234 locally\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
