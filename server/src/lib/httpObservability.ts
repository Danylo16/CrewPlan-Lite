import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface ServerTimingMetric {
  name: string;
  durationMs: number;
}

export function requestObservability(
  _request: Request,
  response: Response,
  next: NextFunction,
) {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
}

export function preventDecisionCaching(response: Response) {
  response.setHeader("Cache-Control", "no-store");
}

export function recordServerTiming(
  response: Response,
  operation: string,
  startedAt: number,
  metrics: ServerTimingMetric[] = [],
) {
  const totalDurationMs = Math.max(0, performance.now() - startedAt);
  const allMetrics = [
    { name: "total", durationMs: totalDurationMs },
    ...metrics,
  ];
  response.setHeader("Server-Timing", allMetrics.map((metric) =>
    `${metric.name};dur=${Math.max(0, metric.durationMs).toFixed(1)}`,
  ).join(", "));
  response.setHeader("Timing-Allow-Origin", "*");

  if (process.env.NODE_ENV !== "test") {
    console.info(JSON.stringify({
      event: "portfolio_operation",
      operation,
      requestId: response.locals.requestId,
      statusCode: response.statusCode,
      durationMs: Math.round(totalDurationMs),
      metrics: Object.fromEntries(metrics.map((metric) => [
        metric.name,
        Math.round(Math.max(0, metric.durationMs)),
      ])),
    }));
  }
}
