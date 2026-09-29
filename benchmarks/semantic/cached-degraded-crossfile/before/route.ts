import { dashboard } from './service';

export async function GET(_req: Request, id: string): Promise<Response> {
  const reply = (body: Record<string, unknown>, status = 200) =>
    Response.json(body, {
      status,
      headers: { ...(status === 200 ? { 'cache-control': 'private, max-age=600' } : {}) },
    });
  const data = await dashboard(id);
  return reply({ ok: true, ...data });
}
