#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { CosmosClient } from "@azure/cosmos";

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    container: "",
    database: "",
    query: "SELECT * FROM c",
    output: "",
    reportOut: "",
    pageSize: 100,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") && !args.container) {
      args.container = token.trim();
      continue;
    }
    if (token === "--database") {
      args.database = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (token === "--query") {
      args.query = String(argv[index + 1] ?? "").trim() || args.query;
      index += 1;
      continue;
    }
    if (token === "--output") {
      args.output = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (token === "--report-out") {
      args.reportOut = String(argv[index + 1] ?? "").trim();
      index += 1;
      continue;
    }
    if (token === "--page-size") {
      const pageSize = Number(argv[index + 1] ?? "100");
      if (Number.isFinite(pageSize) && pageSize > 0) {
        args.pageSize = Math.floor(pageSize);
      }
      index += 1;
    }
  }

  return args;
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) {
    fail(`Missing ${name}.`);
  }
  return text;
}

function buildClient() {
  const connectionString = String(process.env.OLD_ERP_COSMOS_CONNECTION_STRING ?? "").trim();
  if (connectionString) {
    return {
      mode: "connection_string",
      client: new CosmosClient(connectionString),
    };
  }

  const endpoint = String(process.env.OLD_ERP_COSMOS_ENDPOINT ?? "").trim();
  const key = String(process.env.OLD_ERP_COSMOS_KEY ?? "").trim();

  if (!endpoint || !key) {
    fail(
      "Missing Cosmos credentials. Set OLD_ERP_COSMOS_CONNECTION_STRING, or set both OLD_ERP_COSMOS_ENDPOINT and OLD_ERP_COSMOS_KEY.",
    );
  }

  return {
    mode: "endpoint_key",
    client: new CosmosClient({ endpoint, key }),
  };
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonFile(filePath, value) {
  ensureDirectory(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function exportContainer({ client, databaseName, containerName, query, pageSize, outputPath, reportPath }) {
  const database = client.database(databaseName);
  const container = database.container(containerName);

  const queryIterator = container.items.query(query, {
    maxItemCount: pageSize,
  });

  const rows = [];
  let pageCount = 0;

  while (queryIterator.hasMoreResults()) {
    const { resources } = await queryIterator.fetchNext();
    if (!resources || resources.length === 0) {
      break;
    }
    rows.push(...resources);
    pageCount += 1;
  }

  writeJsonFile(outputPath, rows);

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "read-only-export",
    database: databaseName,
    container: containerName,
    query,
    pageSize,
    pageCount,
    totalRecords: rows.length,
    outputPath,
    credentialMode: process.env.OLD_ERP_COSMOS_CONNECTION_STRING ? "connection_string" : "endpoint_key",
    writesPerformed: false,
  };

  writeJsonFile(reportPath, report);

  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const containerName = requireText(args.container, "container name argument, e.g. npm run azure:export -- InvoiceQueueItems");
  const databaseName = requireText(args.database || process.env.OLD_ERP_COSMOS_DATABASE, "OLD_ERP_COSMOS_DATABASE or --database");

  const { client } = buildClient();
  const slug = timestampSlug();
  const outputPath = path.resolve(
    args.output || `tmp/exports/azure-${containerName}-${slug}.json`,
  );
  const reportPath = path.resolve(
    args.reportOut || `tmp/import-reports/azure-export-${containerName}-${slug}.json`,
  );

  console.log(`Exporting ${containerName} from ${databaseName} with query: ${args.query}`);
  const report = await exportContainer({
    client,
    databaseName,
    containerName,
    query: args.query,
    pageSize: args.pageSize,
    outputPath,
    reportPath,
  });

  console.log("\n=== Azure Cosmos Read-Only Export Complete ===\n");
  console.log(`Container: ${report.container}`);
  console.log(`Database: ${report.database}`);
  console.log(`Pages fetched: ${report.pageCount}`);
  console.log(`Total records: ${report.totalRecords}`);
  console.log(`Raw export: ${report.outputPath}`);
  console.log(`Report: ${reportPath}`);
  console.log("No Azure records were modified.");
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unknown export failure");
});
