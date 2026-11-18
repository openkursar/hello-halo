import { getSourceAccountName, type AISource, type ModelOption } from '../../../shared/types/ai-sources'

export function modelSearchWords(query: string): string[] {
  return query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

export function accountSearchText(source: AISource): string {
  return [source.name, source.provider, getSourceAccountName(source)].filter(Boolean).join(' ').toLocaleLowerCase()
}

export function filterAccountModels(models: ModelOption[], accountText: string, words: readonly string[]): ModelOption[] {
  if (words.length === 0) return models
  return models.filter(model => {
    const text = `${accountText} ${model.name ?? ''} ${model.id}`.toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
}
