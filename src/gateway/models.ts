import { config } from '../config.js';
import { getSetting, setSetting } from '../db/settings.js';
export interface Combo { name: string; models: string[]; fallback: boolean }
export function combos(): Combo[] { return JSON.parse(getSetting('combos') ?? '[]') as Combo[]; }
export function saveCombo(input: Record<string, unknown>): Combo {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const models = Array.isArray(input.models) ? [...new Set(input.models.map(String).map(s => s.trim()))] : [];
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name) || name.startsWith('gemini')) throw new Error('Use a combo name such as character-images, without the gemini prefix');
  if (!models.length || models.length > 10 || models.some(m => !/^gemini-[a-zA-Z0-9._-]+$/.test(m))) throw new Error('Provide 1–10 Gemini model IDs');
  const combo = { name, models, fallback: input.fallback === true };
  setSetting('combos', JSON.stringify([...combos().filter(c => c.name !== name), combo]));
  return combo;
}
export function deleteCombo(name: string): void { setSetting('combos', JSON.stringify(combos().filter(c => c.name !== name))); }
export function extraModels(): string[] { return JSON.parse(getSetting('extraModels') ?? '[]') as string[]; }
export function addModel(name: unknown): void {
  if (typeof name !== 'string' || !/^gemini-[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Provide a Gemini model ID');
  setSetting('extraModels', JSON.stringify([...new Set([...extraModels(), name])]));
}
export function removeModel(name: string): void {
  if (name === config.geminiImageModel || combos().some(c => c.models.includes(name))) throw new Error('The default model or a model used by a combo cannot be removed');
  setSetting('extraModels', JSON.stringify(extraModels().filter(m => m !== name)));
}
export function modelIds(): string[] { return [...new Set([config.geminiImageModel, ...extraModels(), ...combos().flatMap(c => [c.name, ...c.models])])]; }
export function resolveModel(name: string): { models: string[]; fallback: boolean } | null {
  const combo = combos().find(c => c.name === name);
  if (combo) return combo;
  return modelIds().includes(name) ? { models: [name], fallback: false } : null;
}
