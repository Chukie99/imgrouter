import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { proxyGenerateContent } from './proxy.js';
import { modelIds } from './models.js';
import { buildContents } from '../worker/generator.js';
import type { ReferenceImage } from '../worker/generator.js';
export interface OpenAIImageInput {
 model?: string; prompt: string; n?: number; responseFormat?: string;
 referenceImages?: unknown; image?: unknown; allowModelFallback?: boolean;
}
function fail(message: string) { return { status: 400, body: { error: { message, type: 'invalid_request_error' } } }; }
/** Inline images only: the gateway does not fetch arbitrary client URLs or local files. */
export function parseReferences(value: unknown): ReferenceImage[] {
 if (value === undefined) return [];
 const items = Array.isArray(value) ? value : [value];
 if (items.length > 3) throw new Error('Maximum 3 reference images');
 return items.map(item => {
  let mimeType: unknown; let data: unknown;
  if (typeof item === 'string') {
   const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(item);
   if (!match) throw new Error('image must be a base64 data URL; remote URLs are not fetched');
   [, mimeType, data] = match;
  } else if (item && typeof item === 'object') {
   ({ mimeType, data } = item as Record<string, unknown>);
  }
  if (!['image/png','image/jpeg','image/webp'].includes(String(mimeType)) || typeof data !== 'string' || !data.length || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || Buffer.from(data,'base64').toString('base64') !== data) throw new Error('Invalid reference image MIME type or base64');
  if (Buffer.byteLength(data, 'base64') > 8 * 1024 * 1024) throw new Error('Each reference image must be at most 8 MiB');
  return { mimeType: String(mimeType), data };
 });
}
export async function openAIImageGeneration(input: OpenAIImageInput, origin: string): Promise<{ status: number; body: unknown }> {
 if (typeof input.prompt !== 'string' || !input.prompt.trim()) return fail('prompt is required');
 const model = input.model ?? config.geminiImageModel;
 const n = input.n ?? 1;
 if (!Number.isInteger(n) || n < 1 || n > 10) return fail('n must be an integer from 1 to 10');
 if (input.responseFormat && !['url','b64_json'].includes(input.responseFormat)) return fail('response_format must be url or b64_json');
 let references: ReferenceImage[];
 try { references = parseReferences(input.referenceImages ?? input.image); } catch(e) { return fail((e as Error).message); }
 const data: Array<Record<string,string>> = [];
 let actualModel: string | undefined;
 for (let i=0;i<n;i++) {
  const result = await proxyGenerateContent(actualModel ?? model, {
   contents: buildContents({ prompt: input.prompt, referenceImages: references }),
   generationConfig: { responseModalities: ['TEXT','IMAGE'] },
   allow_model_fallback: input.allowModelFallback,
  });
  actualModel = result.model;
  if (result.status !== 200) {
   const error = result.body as { error?: { message?: string } };
   return { status: result.status, body: { error: { message: error.error?.message ?? 'Provider request failed', type:'upstream_error' }, data, model: actualModel } };
  }
  const payload = result.body as { candidates?: Array<{content?: {parts?: Array<{inlineData?:{data?:string;mimeType?:string}}>}}> };
  const image = payload.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data)?.inlineData;
  if (!image?.data) return { status:502,body:{error:{message:'No image returned by provider',type:'upstream_error'},data,model:actualModel} };
  if (input.responseFormat === 'url') {
   const dir=path.join(config.imagesDir,'_openai'); fs.mkdirSync(dir,{recursive:true});
   const ext=image.mimeType==='image/jpeg'?'jpg':image.mimeType==='image/webp'?'webp':'png';
   const name=`${randomUUID()}.${ext}`;fs.writeFileSync(path.join(dir,name),Buffer.from(image.data,'base64'));
   data.push({url:`${origin}/files/_openai/${name}`});
  } else data.push({b64_json:image.data});
 }
 return {status:200,body:{created:Math.floor(Date.now()/1000),model:actualModel,data}};
}
export function listOpenAIModels(): {object:string;data:Array<Record<string,unknown>>} {
 return {object:'list',data:modelIds().map(id=>({id,object:'model',created:0,owned_by:'imgrouter'}))};
}
