import "dotenv/config";
import path from "node:path";
import express from "express";
import { createCallsRouter } from "./callsRouter.js";
import { createGeminiService } from "./geminiService.js";
import { createSupabaseAdminClient } from "./supabaseClient.js";

export function createApp() {
  const app = express();
  const supabase = createSupabaseAdminClient();
  const bucketName = process.env.SUPABASE_STORAGE_BUCKET?.trim() || "call-recordings";
  const ai = createGeminiService(process.env.GEMINI_API_KEY);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use("/api/calls", createCallsRouter({ supabase, bucketName, ai }));
  app.use("/api", (_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "API route not found." } });
  });

  if (process.env.NODE_ENV === "production") {
    const clientDist = path.resolve(process.cwd(), "dist/client");
    app.use(express.static(clientDist));
    app.get(/^(?!\/api\/).*/, (_request, response, next) => {
      response.sendFile(path.join(clientDist, "index.html"), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  return app;
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port number.");
}

createApp().listen(port, "0.0.0.0", () => {
  console.info(`PestLaunch Call Intelligence listening on port ${port}.`);
});
