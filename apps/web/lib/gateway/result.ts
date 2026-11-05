export type GatewayResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export async function toResult<T>(response: Response): Promise<GatewayResult<T>> {
  const body = await response.json().catch(() => null);
  if (response.ok) return { ok: true, data: body as T };
  return { ok: false, status: response.status, code: (body as { error?: { code?: string } } | null)?.error?.code ?? "error" };
}
