import type { LlmProvider,ProviderCapabilities,ProviderRequest,ProviderResponse,StreamEvent } from "../../../types/provider.js";
export interface PromptToolCallingAdapter {
    readonly id: string;
    readonly name: string;
    readonly listModels?: LlmProvider['listModels'];
    readonly healthCheck?: LlmProvider['healthCheck'];
    capabilities(): ProviderCapabilities;
    createMessage(request: ProviderRequest): Promise<ProviderResponse>;
    createMessageStream(request: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined>;
}
