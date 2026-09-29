import { dashboard } from './service';

export async function GET(_req: Request, id: string): Promise<Response> {
  const reply = (body: Record<string, unknown>, status = 200) =>
    Response.json(body, {
      status,
      headers: { 'cache-control': status === 200 && body.complete !== false ? 'private, max-age=600' : 'no-store' },
    });
  const data = await dashboard(id);
  return reply({ ok: true, ...data });
}
