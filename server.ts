import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const __filename = typeof fileURLToPath !== "undefined" && typeof import.meta !== "undefined" && import.meta.url
  ? fileURLToPath(import.meta.url)
  : "";
const __dirname = __filename ? path.dirname(__filename) : process.cwd();

const app = express();
const PORT = 3000;
const GEMINI_MODEL = "gemini-3.5-flash";
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

app.use(express.json({ limit: "20mb" }));

// Lazy load Gemini Client to prevent startup failure
let aiClient: any = null;
function getAIClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.trim() === "") {
    throw new Error("GEMINI_API_KEY has not been configured yet. Please add it via the Settings or Secrets panel.");
  }
  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Lazy Postgres pool, mirroring the Gemini client pattern: don't fail server startup
// if the database isn't reachable yet, only when a request actually needs it.
let pgPool: Pool | null = null;
function getDbPool() {
  if (!pgPool) {
    pgPool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      max: 5,
    });
  }
  return pgPool;
}

let schemaReady = false;
async function ensureSchema(pool: Pool) {
  if (schemaReady) return;
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_embeddings (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding VECTOR(${EMBEDDING_DIMENSIONS}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS document_embeddings_embedding_idx
      ON document_embeddings USING hnsw (embedding vector_cosine_ops)
  `);
  schemaReady = true;
}

// API endpoints first
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Agentic Pipeline runner backend is healthy." });
});

// Mock database of saved pipelines (stored in memory in server for simple session consistency)
let savedPipelines = [
  {
    id: "sales-forecast",
    name: "Sales Trend & Forecasting Pipeline",
    description: "Ingests sales metrics, searches vectors, cleans records, and performs statistical forecasting.",
    steps: [
      { id: "parsing", name: "Sanitization & Parsers", type: "ingestion", active: true },
      { id: "vector-store", name: "Vector DB Store & Sync", type: "vector", active: true },
      { id: "anomaly-detector", name: "Anomalies & Patterns", type: "model", active: true },
      { id: "reporter", name: "Narrative Report Gen", type: "generation", active: true }
    ]
  }
];

app.get("/api/pipelines", (req, res) => {
  res.json(savedPipelines);
});

app.post("/api/pipelines", (req, res) => {
  const pipeline = req.body;
  if (!pipeline.id) {
    pipeline.id = Math.random().toString(36).substring(7);
  }
  const index = savedPipelines.findIndex(p => p.id === pipeline.id);
  if (index >= 0) {
    savedPipelines[index] = pipeline;
  } else {
    savedPipelines.push(pipeline);
  }
  res.json({ success: true, pipeline });
});

// Deterministic CSV/freeform parsing - this step never calls the model, it actually parses the data.
function parseRows(raw: string): Record<string, any>[] {
  const lines = raw.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2 || !lines[0].includes(",")) {
    return [{ text: raw.trim() }];
  }
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cells = line.split(",");
    const row: Record<string, any> = {};
    headers.forEach((h, i) => {
      const cell = cells[i]?.trim();
      const num = Number(cell);
      row[h] = cell !== undefined && cell !== "" && !Number.isNaN(num) ? num : cell;
    });
    return row;
  });
}

// Gemini occasionally returns a transient 503 ("model overloaded") under real load - retry
// those a couple of times with backoff instead of failing the whole pipeline run.
async function withRetry(fn: () => Promise<any>, retries = 2, delayMs = 2000): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const transient = err.message?.includes("UNAVAILABLE") || err.message?.includes("503");
      if (!transient || attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

// Embeds each row and writes it into Postgres/pgvector - the real vector-sync step.
async function embedAndStore(ai: any, pool: Pool, runId: string, rows: Record<string, any>[]) {
  const texts = rows.map(r => JSON.stringify(r));
  const embedResponse = await withRetry(() => ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts,
    config: { outputDimensionality: EMBEDDING_DIMENSIONS }
  }));
  const embeddings = embedResponse.embeddings ?? [];

  const client = await pool.connect();
  try {
    for (let i = 0; i < embeddings.length; i++) {
      const values = embeddings[i]?.values ?? [];
      if (values.length === 0) continue;
      await client.query(
        `INSERT INTO document_embeddings (run_id, content, embedding) VALUES ($1, $2, $3::vector)`,
        [runId, texts[i], `[${values.join(",")}]`]
      );
    }
  } finally {
    client.release();
  }

  return { count: embeddings.length, dimensions: embeddings[0]?.values?.length ?? 0 };
}

// Focused model call: only asked to find insights in the already-parsed data, nothing else.
async function detectAnomalies(ai: any, rows: Record<string, any>[], goal: string) {
  const prompt = `
    You are the anomaly/trend detection stage of a data analysis pipeline.
    Given this structured dataset: ${JSON.stringify(rows)}
    and the analytical goal: "${goal || "Identify notable trends and outliers."}"

    Identify exactly 3 notable insights covering anomalies, trends, or forecasts.
    Respond ONLY with this JSON shape, no markdown wrap:
    { "insights": [ { "category": "anomaly" | "trend" | "forecast", "title": "string", "details": "string" } ] }
  `;
  const response = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  }));
  const text = response.text;
  if (!text) throw new Error("Received empty response from Gemini API during anomaly detection.");
  return JSON.parse(text.trim()).insights ?? [];
}

// Final model call: synthesizes the report and chart data from the previous steps' real outputs.
async function buildReport(
  ai: any,
  rows: Record<string, any>[],
  insights: any[],
  vectorStats: { count: number; dimensions: number },
  goal: string
) {
  const prompt = `
    You are the reporting stage of a data analysis pipeline. The earlier pipeline stages already
    parsed the dataset and produced the insights below - do not re-derive them, synthesize from them.

    DATASET: ${JSON.stringify(rows)}
    GOAL: "${goal || "Summarize trends and outliers in the data."}"
    INSIGHTS ALREADY FOUND: ${JSON.stringify(insights)}
    VECTOR STORE STATS: ${vectorStats.count} embeddings stored at ${vectorStats.dimensions} dimensions.

    Produce:
    1. Between 5 and 12 chart-ready data points reusing the dataset's actual field names.
    2. A chart type and the keys to plot.
    3. A polished executive markdown report referencing the insights and vector store stats above.

    Respond ONLY with this JSON shape, no markdown wrap:
    {
      "chartData": [ { "name": "Label", "...": 0 } ],
      "chartType": "line" | "bar" | "composed",
      "chartKeys": { "primary": "string", "secondary": "string" },
      "markdownReport": "Markdown text"
    }
  `;
  const response = await withRetry(() => ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  }));
  const text = response.text;
  if (!text) throw new Error("Received empty response from Gemini API during report generation.");
  return JSON.parse(text.trim());
}

// Core execution endpoint for AI agentic data analysis. Streams real per-step progress over
// Server-Sent Events as each stage actually runs, instead of returning one fabricated blob.
app.post("/api/analyze", async (req, res) => {
  const { data, goal, pipelineSteps } = req.body;

  if (!data) {
    return res.status(400).json({ error: "Data payload is required for analysis." });
  }

  const steps: string[] = Array.isArray(pipelineSteps) && pipelineSteps.length > 0
    ? pipelineSteps
    : ["parsing", "vector-store", "anomaly-detector", "reporter"];

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  const send = (event: Record<string, any>) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  let rows: Record<string, any>[] = [];
  let insights: any[] = [];
  let vectorStats = { count: 0, dimensions: 0 };
  let currentStep = "parsing";

  try {
    const ai = getAIClient();
    const runId = randomUUID();

    send({ stepId: "parsing", status: "running", message: "Parsing raw input into structured records..." });
    rows = parseRows(data);
    send({ stepId: "parsing", status: "success", message: `Parsed ${rows.length} rows with fields: ${Object.keys(rows[0] || {}).join(", ")}.` });

    if (steps.includes("vector-store")) {
      currentStep = "vector-store";
      send({ stepId: "vector-store", status: "running", message: "Generating embeddings and writing to PGVECTOR..." });
      try {
        const pool = getDbPool();
        await ensureSchema(pool);
        vectorStats = await embedAndStore(ai, pool, runId, rows);
        send({ stepId: "vector-store", status: "success", message: `Stored ${vectorStats.count} embeddings (${vectorStats.dimensions}-dim) in document_embeddings under run ${runId}.` });
      } catch (dbErr: any) {
        send({ stepId: "vector-store", status: "error", message: `Vector store unavailable: ${dbErr.message}` });
      }
    }

    if (steps.includes("anomaly-detector")) {
      currentStep = "anomaly-detector";
      send({ stepId: "anomaly-detector", status: "running", message: "Analyzing parsed dataset for anomalies, trends, and forecasts..." });
      insights = await detectAnomalies(ai, rows, goal);
      send({ stepId: "anomaly-detector", status: "success", message: `Identified ${insights.length} insights.` });
    }

    if (steps.includes("reporter")) {
      currentStep = "reporter";
      send({ stepId: "reporter", status: "running", message: "Synthesizing executive narrative report from prior steps..." });
      const report = await buildReport(ai, rows, insights, vectorStats, goal);
      send({ stepId: "reporter", status: "success", message: "Report generated." });
      send({ done: true, result: { insights, ...report } });
    } else {
      send({ done: true, result: { insights, chartData: [], chartType: "line", chartKeys: { primary: "value" }, markdownReport: "" } });
    }
  } catch (error: any) {
    console.error("Agentic pipeline execution error:", error);
    send({ stepId: currentStep, status: "error", message: error.message || "Internal server error running agent analysis." });
    send({ done: true, error: error.message || "Internal server error running agent analysis." });
  } finally {
    res.end();
  }
});

// Vite integration inside async server start wrapper
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
