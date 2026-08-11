const API_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

interface ApiError {
  code?: string;
  message?: string;
}

async function responseBody(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error(
      response.ok
        ? "API deployment returned HTML instead of JSON. The backend preview is not deployed for this branch."
        : `API endpoint is unavailable in this deployment (${response.status}).`,
    );
  }
  return response.json() as Promise<unknown>;
}

export async function apiRequest<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = (await responseBody(response)) as ApiError;

    throw new Error(error.message ?? "Request failed");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return responseBody(response) as Promise<T>;
}
