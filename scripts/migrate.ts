import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv } from "./env";
import { postgres } from "../src/lib/db/postgres";
import { clickhouse } from "../src/lib/db/clickhouse";
import { errorMessage } from "../src/lib/db/tls";

loadEnv(); // clients read env lazily, so loading after imports is fine

const statements = (sql: string) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").split(";").map((part) => part.trim()).filter(Boolean);

async function main() {
  let failed = false;
  const pg = postgres();
  if (!pg) console.log("postgres: DATABASE_URL not set, skipped");
  else {
    try { await pg.query(readFileSync(join("db", "postgres.sql"), "utf8")); console.log("postgres: db/postgres.sql applied"); }
    catch (error) { failed = true; console.error("postgres: migration failed:", errorMessage(error)); }
    finally { await pg.end(); }
  }
  const ch = clickhouse();
  if (!ch) console.log("clickhouse: CLICKHOUSE_URL not set, skipped");
  else {
    try { for (const query of statements(readFileSync(join("db", "clickhouse.sql"), "utf8"))) await ch.command({ query }); console.log("clickhouse: db/clickhouse.sql applied"); }
    catch (error) { failed = true; console.error("clickhouse: migration failed:", errorMessage(error)); }
    finally { await ch.close(); }
  }
  process.exit(failed ? 1 : 0);
}

void main();
