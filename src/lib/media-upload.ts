import {
  CapacitiesApiError,
  type GetObjectResponse,
  PUBLIC_API_VERSION,
} from "@capacities/api";
import { resolveApiToken } from "./client";

const DEFAULT_BASE_URL = "https://api.capacities.io";

export type MediaUploadInit = {
  id: string;
  status: "pending";
  fileName: string;
  fileType: string;
  fileSize: number;
  partSize: number;
  partCount: number;
  expiresAt: string;
};

export type MediaUploadPart = {
  number: number;
  size: number;
};

export type MediaUploadObject = GetObjectResponse & {
  files?: Array<{
    url: string;
    fileType: string;
    expirationDate: string;
  }>;
};

type RequestBody = string | Uint8Array;

function baseUrl(): string {
  return (
    process.env.CAPACITIES_API_BASE_URL?.trim() || DEFAULT_BASE_URL
  ).replace(/\/$/, "");
}

async function request<T>(
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  apiToken: string | undefined,
  body?: RequestBody,
  contentType?: string,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveApiToken(apiToken)}`,
    "X-Capacities-Api-Version": PUBLIC_API_VERSION,
  };
  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  const response = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    body: body as BodyInit | undefined,
    signal,
  });

  if (!response.ok) {
    throw await CapacitiesApiError.fromResponse(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function initMediaUpload(
  body: {
    fileName: string;
    fileSize: number;
    fileType?: string;
    title?: string;
    collections?: string[];
  },
  apiToken?: string,
  signal?: AbortSignal,
): Promise<MediaUploadInit> {
  return request(
    "/object/media/upload",
    "POST",
    apiToken,
    JSON.stringify(body),
    "application/json",
    signal,
  );
}

export function uploadMediaPart(
  params: { id: string; partNumber: number },
  bytes: Uint8Array,
  apiToken?: string,
  signal?: AbortSignal,
): Promise<MediaUploadPart> {
  return request(
    `/object/media/upload/part?id=${encodeURIComponent(params.id)}&partNumber=${params.partNumber}`,
    "PUT",
    apiToken,
    bytes,
    "application/octet-stream",
    signal,
  );
}

export function completeMediaUpload(
  id: string,
  apiToken?: string,
  signal?: AbortSignal,
): Promise<MediaUploadObject> {
  return request(
    "/object/media/upload/complete",
    "POST",
    apiToken,
    JSON.stringify({ id }),
    "application/json",
    signal,
  );
}

export function abortMediaUpload(
  id: string,
  apiToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  return request(
    "/object/media/upload/abort",
    "POST",
    apiToken,
    JSON.stringify({ id }),
    "application/json",
    signal,
  );
}
