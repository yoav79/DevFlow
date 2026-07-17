/// <reference types="node" />

import { DatabaseSync } from "node:sqlite";

import type { HumanRequest, HumanRequestStatus } from "../types.js";

function mapRowToHumanRequest(row: Record<string, unknown>): HumanRequest {
  return {
    id: String(row["id"]),
    taskId: String(row["taskId"]),
    type: String(row["type"]) as HumanRequest["type"],
    question: String(row["question"]),
    optionsJson: String(row["optionsJson"]),
    resolutionJson: row["resolutionJson"] === null ? null : String(row["resolutionJson"]),
    status: String(row["status"]) as HumanRequestStatus,
    createdAt: String(row["createdAt"]),
    resolvedAt: row["resolvedAt"] === null ? null : String(row["resolvedAt"]),
  };
}

export function createHumanRequest(
  database: DatabaseSync,
  request: HumanRequest,
): HumanRequest {
  database
    .prepare(
      "INSERT INTO human_requests (id, taskId, type, question, optionsJson, resolutionJson, status, createdAt, resolvedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      request.id,
      request.taskId,
      request.type,
      request.question,
      request.optionsJson,
      request.resolutionJson,
      request.status,
      request.createdAt,
      request.resolvedAt,
    );

  return request;
}

export function getHumanRequestById(
  database: DatabaseSync,
  requestId: string,
): HumanRequest | null {
  const row = database.prepare("SELECT * FROM human_requests WHERE id = ?").get(requestId) as
    | Record<string, unknown>
    | undefined;

  if (row === undefined) {
    return null;
  }

  return mapRowToHumanRequest(row);
}

export function listPendingHumanRequests(database: DatabaseSync): HumanRequest[] {
  const rows = database
    .prepare(
      "SELECT * FROM human_requests WHERE status = 'PENDING' ORDER BY createdAt ASC, id ASC",
    )
    .all() as Record<string, unknown>[];

  return rows.map(mapRowToHumanRequest);
}

export function resolveHumanRequest(
  database: DatabaseSync,
  requestId: string,
  status: Exclude<HumanRequestStatus, "PENDING">,
  resolutionJson: string | null,
  resolvedAt: string,
): HumanRequest | null {
  const result = database
    .prepare(
      "UPDATE human_requests SET status = ?, resolutionJson = ?, resolvedAt = ? WHERE id = ? AND status = 'PENDING'",
    )
    .run(status, resolutionJson, resolvedAt, requestId);

  if (result.changes === 0) {
    return null;
  }

  return getHumanRequestById(database, requestId);
}
