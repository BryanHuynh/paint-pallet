import { describe, expect, it, vi } from 'vitest';
import { generateVisionRecipes } from '../../src/main/visionRecipes';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const REQUEST = { apiKey: 'test-key', images: [PNG, PNG] };
const RECIPE = {
  name: ' Blue cloth ',
  swatches: {
    shadow: { hex: '#14243a', mixNotes: ' 2 parts navy, 1 part black ' },
    midtone: { hex: '#365a92', mixNotes: '2 parts navy, 1 part ultramarine' },
    highlight: { hex: '#86aada', mixNotes: '2 parts ultramarine, 1 part ivory' },
  },
};

function completed(part: unknown) {
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', role: 'assistant', content: [part] }],
  });
}

function withRecipes(recipes: unknown[]) {
  return completed({ type: 'output_text', text: JSON.stringify({ recipes }) });
}

describe('OpenAI vision recipes', () => {
  it('sends each reference as an image and normalizes the validated recipes', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(withRecipes([RECIPE]));

    expect(await generateVisionRecipes(REQUEST, send)).toEqual({
      ok: true,
      recipes: [{
        name: 'Blue cloth',
        swatches: {
          shadow: { hex: '#14243A', mixNotes: '2 parts navy, 1 part black' },
          midtone: { hex: '#365A92', mixNotes: RECIPE.swatches.midtone.mixNotes },
          highlight: { hex: '#86AADA', mixNotes: RECIPE.swatches.highlight.mixNotes },
        },
      }],
    });

    expect(send).toHaveBeenCalledTimes(1);
    const [url, request] = send.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(request).toMatchObject({
      method: 'POST', headers: { Authorization: 'Bearer test-key' }, redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(request!.body as string);
    expect(body).toMatchObject({
      model: 'gpt-4.1-mini',
      store: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text' },
          { type: 'input_image', image_url: PNG, detail: 'high' },
          { type: 'input_image', image_url: PNG, detail: 'high' },
        ],
      }],
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(request!.body).not.toContain(REQUEST.apiKey);
  });

  it.each([
    { ...REQUEST, apiKey: 'abc\r\n' + 'extra-header' },
    { ...REQUEST, images: [] },
    { ...REQUEST, images: Array(5).fill(PNG) },
    { ...REQUEST, images: Array(2) },
    { ...REQUEST, images: ['https://example.com/reference.png'] },
    { ...REQUEST, images: ['data:image/png;base64,AAAA'] },
  ])('rejects invalid inputs before making any request', async (request) => {
    const send = vi.fn<typeof fetch>();
    expect(await generateVisionRecipes(request, send)).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an image whose encoded dimensions exceed the app limit', async () => {
    const data = Buffer.from(PNG.split(',')[1], 'base64');
    data.writeUInt32BE(1025, 16);
    const send = vi.fn<typeof fetch>();
    expect(await generateVisionRecipes({ ...REQUEST, images: [`data:image/png;base64,${data.toString('base64')}`] }, send))
      .toMatchObject({ ok: false, message: expect.stringContaining('reference') });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'HTTP 400'],
    [401, 'key'],
    [403, 'permissions'],
    [404, 'unavailable'],
    [429, 'quota'],
    [503, 'HTTP 503'],
  ])('reports HTTP %i without exposing the provider body', async (status, expected) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('private provider details', { status }));
    const result = await generateVisionRecipes(REQUEST, send);
    expect(result).toEqual({ ok: false, message: expect.stringContaining(expected) });
    expect(JSON.stringify(result)).not.toContain('private provider details');
  });

  it('reports network failures and timeouts without exposing the exception', async () => {
    const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('private transport details'));
    expect(await generateVisionRecipes(REQUEST, send)).toEqual({
      ok: false, message: expect.stringContaining('connection'),
    });

    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
    try {
      expect(await generateVisionRecipes(REQUEST, send)).toEqual({
        ok: false, message: expect.stringContaining('timed out'),
      });
      expect(timeout).toHaveBeenCalledWith(60_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    [() => new Response('not JSON'), 'unreadable'],
    [() => Response.json({ status: 'incomplete', output: [] }), 'did not complete'],
    [() => completed({ type: 'refusal', refusal: 'Declined' }), 'declined'],
    [() => completed({ type: 'output_text', text: '{' }), 'invalid paint recipes'],
    [() => withRecipes([]), 'invalid paint recipes'],
    [() => withRecipes(Array(7).fill(RECIPE)), 'invalid paint recipes'],
    [() => withRecipes([RECIPE, { ...RECIPE, swatches: { shadow: RECIPE.swatches.shadow } }]), 'invalid paint recipes'],
    [() => withRecipes([{ ...RECIPE, swatches: { ...RECIPE.swatches, shadow: { hex: 'navy', mixNotes: '2 parts navy' } } }]), 'invalid paint recipes'],
    [() => withRecipes([{ ...RECIPE, swatches: { ...RECIPE.swatches, midtone: RECIPE.swatches.highlight } }]), 'invalid paint recipes'],
  ] satisfies [() => Response, string][])('rejects unusable provider responses safely', async (response, message) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(response());
    expect(await generateVisionRecipes(REQUEST, send)).toEqual({
      ok: false, message: expect.stringContaining(message),
    });
  });
});
