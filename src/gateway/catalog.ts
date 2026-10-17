import { config } from '../config.js';
import { getAccount } from '../db/accounts.js';
import { addModel } from './models.js';
/** Discover configured provider image models; listing is not a generation/billing test. */
export async function discoverModels(accountId:string):Promise<string[]> {
 const account=getAccount(accountId);
 if(!account) throw new Error('Provider key not found');
 if(account.status==='disabled') throw new Error('Enable this provider key before syncing models');
 if(config.mockGemini) throw new Error('Model discovery requires real provider mode');
 let token='';const models=new Set<string>();
 for(let page=0;page<20;page++) {
  const url=new URL(`${config.geminiBaseUrl}/models`);url.searchParams.set('pageSize','1000');if(token)url.searchParams.set('pageToken',token);
  const res=await fetch(url,{headers:{'x-goog-api-key':account.apiKey},signal:AbortSignal.timeout(15000)});
  if(!res.ok)throw new Error(`Model discovery failed (HTTP ${res.status}); check this key's access`);
  const json=await res.json() as {models?:Array<{name?:string;supportedGenerationMethods?:string[]}>;nextPageToken?:string};
  for(const m of json.models??[]) {const id=m.name?.replace(/^models\//,'');if(id&&/^gemini-[a-zA-Z0-9._-]+$/.test(id)&&/image/i.test(id)&&m.supportedGenerationMethods?.includes('generateContent'))models.add(id);}
  token=json.nextPageToken??'';if(!token)break;
 }
 for(const id of models)addModel(id);
 return [...models];
}
