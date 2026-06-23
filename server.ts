import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const __filename = typeof fileURLToPath !== "undefined" && typeof import.meta !== "undefined" && import.meta.url
  ? fileURLToPath(import.meta.url)
  : "";
const __dirname = __filename ? path.dirname(__filename) : process.cwd();

const app = express();
const PORT = 3000;

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

// Core execution endpoint for AI agentic data analysis
app.post("/api/analyze", async (req, res) => {
  const { data, goal, pipelineSteps } = req.body;

  if (!data) {
    return res.status(400).json({ error: "Data payload is required for analysis." });
  }

  try {
    const ai = getAIClient();
    
    // Create a detailed prompt instructing the agentic pipeline to simulate the execution of the selected steps
    // and analyze the user's data.
    const systemInstruction = `
      You are the core execution motor of an Advanced Agentic Data Analysis Framework.
      Your task is to ingest a user's data, run any requested preprocessing, vector synchronization, anomaly/statistical model detection, and final reporting, and output the analysis results in a structured, high-integrity JSON format.

      Rules:
      1. Inspect the provided custom data. Safely parse it (whether CSV-like or plain text or JSON).
      2. Walk step-by-step through the designated pipeline steps: ${JSON.stringify(pipelineSteps)}.
      3. For each step, create a realistic telemetry execution log showing specific observations, parsed item counts, vector embeddings simulated sizes, or statistics.
      4. Run a genuine data analysis based on the user's explicit goal: "${goal}".
      5. Generate exact numeric data coordinates representing trends in the custom data that can be plotted directly on chart axes (e.g., bar charts, line charts). Provide between 5 to 12 data points in the 'chartData' attribute (each object must have 'name' representing category/date, and numeric attributes like 'value', 'revenue', 'users' or relevant custom variables based on the user's actual data).
      6. Identify 3 critical insight bullets covering anomalies, predictions, or correlations.
      7. Write a detailed, gorgeous markdown-formatted executive document summarizing findings, business recommendations, and mathematical trends.

      Output Scheme (STRICTLY return this JSON object alone with NO backticks or markdown wrap except valid JSON):
      {
        "logs": [
          { "stepId": "parsing", "status": "success" | "error", "message": "Step execution message showing detailed agent findings..." }
        ],
        "insights": [
          { "category": "anomaly" | "trend" | "forecast", "title": "Insight Title", "details": "Insight description text..." }
        ],
        "chartData": [
          { "name": "Label", "value": 100, "secondary": 50 }
        ],
        "chartType": "line" | "bar" | "composed",
        "chartKeys": { "primary": "value", "secondary": "secondary" },
        "markdownReport": "Markdown text describing the analysis..."
      }
    `;

    const promptText = `
      USER GOAL:
      ${goal || "Automate standard trends and outlier detection in the following numbers."}

      USER DATA:
      ${data}

      Please execute the selected steps and output valid JSON according to the format constraint.
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: promptText,
      config: {
        systemInstruction: systemInstruction,
        responseMimeType: 'application/json'
      }
    });

    const responseText = response.text;
    if (!responseText) {
      throw new Error("Received empty response from Gemini API.");
    }

    // Parse the JSON securely
    const result = JSON.parse(responseText.trim());
    res.json(result);
  } catch (error: any) {
    console.error("Gemini API Execution Error:", error);
    res.status(500).json({
      error: error.message || "Internal server error running agent analysis.",
      needsApiKey: error.message?.includes("GEMINI_API_KEY") || error.message?.includes("API_KEY"),
      mockFallback: true
    });
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
