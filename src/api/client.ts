const API_URL =
  import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

interface ApiError {
  code?: string;
  message?: string;
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
    const error = (await response.json()) as ApiError;

    throw new Error(error.message ?? "Request failed");
  }

  return response.json() as Promise<T>;
}